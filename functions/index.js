/**
 * index.js — Cloud Functions de Lienzo
 * ==============================================================================
 * Backend de la plataforma humanitaria Lienzo (apoyo a centros de cuidado de
 * ninos huerfanos/separados tras el terremoto en Venezuela).
 *
 * CONTEXTO CRITICO DE SEGURIDAD:
 * Existe riesgo real y reportado de personas con intenciones de abuso o
 * trafico infantil intentando infiltrarse como "voluntarios". Por eso:
 *   - NUNCA se otorga acceso a datos de centros/ninos sin que el registro
 *     pase por verificacion (automatica con IA o manual humana) y quede
 *     "aprobado" explicitamente.
 *   - El rol y el estado de verificacion de un usuario NUNCA son editables
 *     por el propio cliente: solo estas Cloud Functions (Admin SDK) pueden
 *     cambiarlos. Las reglas de Firestore/Storage refuerzan esto del lado
 *     del cliente, pero la fuente de verdad es siempre el backend.
 *   - Si no hay forma de verificar automaticamente (no hay ANTHROPIC_API_KEY
 *     configurada), el sistema NUNCA aprueba por defecto: cae siempre en
 *     "pendiente_manual", a la espera de un humano (admin/verificador).
 *
 * Estructura de datos (ver ARQUITECTURA.md para el detalle completo):
 *   usuarios/{uid}        -> perfil del voluntario + estado de verificacion.
 *   verificaciones/{uid}  -> bitacora/auditoria de cada intento de verificacion.
 *   Storage: /voluntarios/{uid}/rostro.jpg y /voluntarios/{uid}/cedula.jpg
 * ==============================================================================
 */

'use strict';

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

admin.initializeApp();

const db = admin.firestore();
const storage = admin.storage();

// ------------------------------------------------------------------------------
// CONFIGURACION GENERAL
// ------------------------------------------------------------------------------

// Modelo de Claude usado para el analisis de identidad. Se deja como constante
// para poder cambiarlo facilmente sin tocar el resto de la logica (por ejemplo
// si Anthropic libera un modelo de vision mas nuevo o mas economico).
const MODELO_CLAUDE = 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

// Dominio fijo usado para construir el email "sintetico" de Firebase Auth a
// partir de la cedula del usuario (ver ARQUITECTURA.md: estrategia de login).
const DOMINIO_AUTH_SINTETICO = '@voluntarios.lienzo.app';

// Umbrales de decision para la verificacion automatica con IA, segun lo
// definido en el documento de arquitectura.
const UMBRAL_APROBADO = 80; // confianza >= 80 y coincidencias OK -> aprobado
const UMBRAL_PENDIENTE_MIN = 50; // 50-79 -> pendiente_manual

// Tiempo de expiracion del codigo de verificacion de email (en minutos).
const MINUTOS_EXPIRACION_CODIGO_EMAIL = 15;

// Remitente de los correos salientes. Se usa EMAIL_USER si no se define algo
// distinto explicitamente.
function obtenerRemitente() {
  return process.env.EMAIL_USER;
}

// ------------------------------------------------------------------------------
// HELPERS GENERALES
// ------------------------------------------------------------------------------

/**
 * Crea (una sola vez por invocacion "en caliente" de la funcion) el
 * transporte de nodemailer configurado para Gmail SMTP usando una
 * contrasena de aplicacion (ver functions/.env.example para instrucciones
 * de como generarla). Si en el futuro se quiere cambiar de proveedor SMTP,
 * este es el unico lugar que hay que tocar.
 */
function crearTransporteCorreo() {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.warn(
      'ADVERTENCIA: EMAIL_USER / EMAIL_PASS no estan configuradas. ' +
      'No se podra enviar el correo. Configura estas variables ' +
      '(ver functions/.env.example).'
    );
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

/**
 * Envia un correo. Si el transporte no esta disponible (faltan credenciales),
 * solo deja un log de advertencia en vez de lanzar una excepcion: preferimos
 * que el flujo de verificacion continue (los datos en Firestore son la fuente
 * de verdad) aunque el correo no se pueda enviar en un entorno de pruebas.
 */
async function enviarCorreo({ to, subject, html }) {
  const transporte = crearTransporteCorreo();
  if (!transporte) {
    console.warn(`No se envio el correo "${subject}" a ${to} (sin transporte configurado).`);
    return false;
  }
  try {
    await transporte.sendMail({
      from: `"Lienzo - Red de Apoyo" <${obtenerRemitente()}>`,
      to,
      subject,
      html,
    });
    return true;
  } catch (error) {
    console.error(`Error enviando correo a ${to}:`, error);
    return false;
  }
}

/**
 * Genera una contrasena temporal aleatoria, razonablemente segura
 * (16 caracteres, mezcla de mayusculas/minusculas/numeros/simbolos basicos),
 * usando crypto.randomBytes para que sea criptograficamente aleatoria.
 */
function generarPasswordTemporal() {
  const alfabeto =
    'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(20);
  let resultado = '';
  for (let i = 0; i < 16; i++) {
    resultado += alfabeto[bytes[i] % alfabeto.length];
  }
  return resultado;
}

/**
 * Genera un codigo numerico de 6 digitos (como string, para preservar ceros
 * a la izquierda) usado para verificar el email personal del usuario.
 */
function generarCodigo6Digitos() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

/**
 * Construye el email "sintetico" de Firebase Auth a partir de la cedula,
 * exactamente como lo espera el frontend: CEDULA en mayusculas + dominio fijo.
 * Ej: "v12345678" -> "V12345678@voluntarios.lienzo.app"
 */
function construirEmailAuthDesdeCedula(cedula) {
  return `${String(cedula).toUpperCase()}${DOMINIO_AUTH_SINTETICO}`;
}

/**
 * Descarga un archivo de Storage y lo devuelve como Buffer.
 */
async function descargarArchivoStorage(rutaStorage) {
  const bucket = storage.bucket();
  const file = bucket.file(rutaStorage);
  const [buffer] = await file.download();
  return buffer;
}

/**
 * Genera una URL firmada (temporal) de lectura para un archivo de Storage,
 * util para incrustar la foto de rostro en el carnet enviado por correo sin
 * necesidad de hacer el archivo publico. Expira en 7 dias (tiempo generoso
 * para que el voluntario pueda reenviarse el correo si lo necesita, pero no
 * indefinido).
 */
async function generarUrlFirmada(rutaStorage, diasValidez = 7) {
  try {
    const bucket = storage.bucket();
    const file = bucket.file(rutaStorage);
    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + diasValidez * 24 * 60 * 60 * 1000,
    });
    return url;
  } catch (error) {
    console.error('No se pudo generar URL firmada para', rutaStorage, error);
    return null;
  }
}

/**
 * Detecta el tipo MIME de una imagen a partir de sus primeros bytes (magic
 * numbers). Soporta JPEG y PNG, que son los formatos esperados desde
 * <input type="file" accept="image/*">. Por defecto asume JPEG.
 */
function detectarMimeImagen(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return 'image/png';
  }
  return 'image/jpeg';
}

// ------------------------------------------------------------------------------
// ANALISIS DE IDENTIDAD CON CLAUDE (IA) — solo si hay ANTHROPIC_API_KEY
// ------------------------------------------------------------------------------

/**
 * Llama a la API de Claude (mensajes con vision) enviando la foto de la
 * cedula y la selfie como content blocks tipo "image", junto con los datos
 * declarados por el usuario, y pide EXCLUSIVAMENTE un JSON estricto de
 * respuesta. Devuelve el objeto ya parseado, o lanza un error si la llamada
 * o el parseo fallan (el llamante decide que hacer en ese caso).
 */
async function analizarIdentidadConClaude({ nombreCompleto, cedula, bufferRostro, mimeRostro, bufferCedula, mimeCedula }) {
  const promptTexto = `Eres un sistema de verificacion de identidad para una plataforma humanitaria que registra voluntarios para centros de cuidado de ninos en Venezuela. Es CRITICO ser estricto: existe riesgo real de personas con intenciones de abuso o trafico infantil tratando de registrarse con identidades falsas.

Se te dan dos imagenes:
1. La primera imagen es una foto del documento de identidad (cedula) del solicitante.
2. La segunda imagen es una "selfie" (foto de rostro) tomada por el solicitante.

Datos declarados por el solicitante al registrarse:
- Nombre completo declarado: "${nombreCompleto}"
- Cedula declarada: "${cedula}"

Analiza:
- Si el nombre y la cedula que logras leer en la foto del documento coinciden razonablemente con los datos declarados (coincideNombre).
- Si el rostro de la selfie corresponde a la misma persona que la foto del documento de identidad (coincideRostro).
- Un nivel de confianza global de 0 a 100 sobre si esta es una identidad legitima y consistente.
- Observaciones breves relevantes (por ejemplo: foto borrosa, documento no coincide, posible foto de foto, etc).

Responde UNICAMENTE con un JSON estricto, sin texto adicional, sin markdown, con EXACTAMENTE esta forma:
{"coincideNombre": true|false, "coincideRostro": true|false, "confianza": 0-100, "observaciones": "string corta"}`;

  const cuerpo = {
    model: MODELO_CLAUDE,
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: promptTexto },
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeCedula, data: bufferCedula.toString('base64') },
          },
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeRostro, data: bufferRostro.toString('base64') },
          },
        ],
      },
    ],
  };

  const respuesta = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(cuerpo),
  });

  if (!respuesta.ok) {
    const textoError = await respuesta.text();
    throw new Error(`Error HTTP ${respuesta.status} llamando a Claude: ${textoError}`);
  }

  const datos = await respuesta.json();
  const textoRespuesta = (datos.content && datos.content[0] && datos.content[0].text) || '';

  // Intentamos parsear el JSON devuelto. Por robustez, si Claude agrega texto
  // extra alrededor (no deberia, pero por si acaso), extraemos el primer
  // bloque que parezca un objeto JSON antes de parsear.
  let jsonCrudo = textoRespuesta.trim();
  const inicio = jsonCrudo.indexOf('{');
  const fin = jsonCrudo.lastIndexOf('}');
  if (inicio !== -1 && fin !== -1 && fin > inicio) {
    jsonCrudo = jsonCrudo.slice(inicio, fin + 1);
  }

  let resultado;
  try {
    resultado = JSON.parse(jsonCrudo);
  } catch (errorParseo) {
    throw new Error(`No se pudo parsear la respuesta de Claude como JSON: ${errorParseo.message}. Respuesta cruda: ${textoRespuesta}`);
  }

  return { resultado, textoRespuesta };
}

// ------------------------------------------------------------------------------
// a) enviarParaVerificacion (callable)
// ------------------------------------------------------------------------------
/**
 * Invocada por el cliente justo despues de que el voluntario completa su
 * perfil y sube sus dos fotos (rostro y cedula) a Storage. No recibe ningun
 * parametro sensible: toma el uid exclusivamente del contexto de autenticacion
 * (context.auth.uid), nunca de lo que envie el cliente, para evitar que
 * alguien intente verificar/aprobar el perfil de otra persona.
 *
 * Flujo:
 *  1. Lee usuarios/{uid}. Si no existe, error.
 *  2. Descarga las dos imagenes desde Storage (rutas fijas conocidas).
 *  3. Si hay ANTHROPIC_API_KEY: llama a Claude y aplica los umbrales de
 *     decision. Si la llamada o el parseo fallan, cae a "pendiente_manual"
 *     (nunca se aprueba automaticamente si algo salio mal: fail-safe).
 *  4. Si NO hay ANTHROPIC_API_KEY (modo activo por defecto del proyecto):
 *     siempre "pendiente_manual", metodo "manual", sin llamar a ninguna API.
 *  5. Escribe verificaciones/{uid} (auditoria) y actualiza usuarios/{uid}.
 *  6. Segun el resultado, dispara aprobarVoluntario / rechazarVoluntario, o
 *     simplemente deja constancia de que quedo pendiente de revision manual.
 */
exports.enviarParaVerificacion = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para enviar tu perfil a verificacion.'
    );
  }

  const uid = context.auth.uid;

  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();

  if (!snapUsuario.exists) {
    throw new functions.https.HttpsError(
      'not-found',
      'No se encontro tu perfil. Completa el registro antes de continuar.'
    );
  }

  const usuario = snapUsuario.data();
  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const cedula = usuario.cedula || '';

  // Rutas fijas de Storage segun ARQUITECTURA.md.
  const rutaRostro = usuario.fotoRostroPath || `voluntarios/${uid}/rostro.jpg`;
  const rutaCedula = usuario.fotoCedulaPath || `voluntarios/${uid}/cedula.jpg`;

  let bufferRostro;
  let bufferCedula;
  try {
    [bufferRostro, bufferCedula] = await Promise.all([
      descargarArchivoStorage(rutaRostro),
      descargarArchivoStorage(rutaCedula),
    ]);
  } catch (error) {
    console.error('Error descargando imagenes de Storage para', uid, error);
    throw new functions.https.HttpsError(
      'failed-precondition',
      'No se pudieron leer las fotos subidas. Verifica que ambas fotos (rostro y cedula) se hayan subido correctamente e intenta de nuevo.'
    );
  }

  const tieneClaveIA = !!process.env.ANTHROPIC_API_KEY;

  let decision; // "aprobado" | "rechazado" | "pendiente_manual"
  let confianza = null;
  let metodo;
  let resultadoBruto = '';
  let motivoRechazo = null;

  if (tieneClaveIA) {
    // ---- MODO IA: hay clave de Anthropic configurada -----------------------
    metodo = 'claude-ia';
    try {
      const mimeRostro = detectarMimeImagen(bufferRostro);
      const mimeCedula = detectarMimeImagen(bufferCedula);

      const { resultado, textoRespuesta } = await analizarIdentidadConClaude({
        nombreCompleto,
        cedula,
        bufferRostro,
        mimeRostro,
        bufferCedula,
        mimeCedula,
      });

      resultadoBruto = textoRespuesta;
      confianza = typeof resultado.confianza === 'number' ? resultado.confianza : 0;
      const coincideNombre = !!resultado.coincideNombre;
      const coincideRostro = !!resultado.coincideRostro;

      if (confianza >= UMBRAL_APROBADO && coincideNombre && coincideRostro) {
        decision = 'aprobado';
      } else if (confianza >= UMBRAL_PENDIENTE_MIN) {
        decision = 'pendiente_manual';
      } else {
        decision = 'rechazado';
        motivoRechazo =
          resultado.observaciones ||
          'La verificacion automatica no encontro suficiente coincidencia entre los datos declarados, el documento de identidad y la foto de rostro.';
      }
    } catch (error) {
      // Fail-safe: si la IA falla (timeout, JSON invalido, error de red,
      // etc.) NUNCA aprobamos automaticamente. Cae a revision manual.
      console.error('Error en analisis de Claude para', uid, '- cae a pendiente_manual:', error);
      decision = 'pendiente_manual';
      resultadoBruto = `Error al analizar con IA, enviado a revision manual: ${error.message}`;
      confianza = null;
    }
  } else {
    // ---- MODO MANUAL: sin ANTHROPIC_API_KEY (estado/modo activo actual) ----
    // Comportamiento por defecto y obligatorio del proyecto: si no se puede
    // verificar automaticamente, jamas se aprueba solo; siempre queda en
    // manos de un humano (admin/verificador) a traves del futuro dashboard.
    metodo = 'manual';
    decision = 'pendiente_manual';
    resultadoBruto = 'Verificacion automatica no configurada (sin ANTHROPIC_API_KEY). Enviado a revision manual.';
    confianza = null;
  }

  // ---- Registrar auditoria en verificaciones/{uid} --------------------------
  await db.collection('verificaciones').doc(uid).set({
    metodo,
    resultadoBruto,
    confianza,
    decision,
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });

  // ---- Actualizar usuarios/{uid} con el resultado ---------------------------
  await refUsuario.update({
    estadoVerificacion: decision,
    confianzaIA: confianza,
    fechaVerificacion: admin.firestore.FieldValue.serverTimestamp(),
    motivoRechazo: decision === 'rechazado' ? motivoRechazo : null,
    verificadoPor: metodo === 'claude-ia' ? 'claude-ia' : null,
  });

  // ---- Disparar la accion correspondiente al resultado -----------------------
  if (decision === 'aprobado') {
    await aprobarVoluntario(uid);
    return { ok: true, estado: 'aprobado', mensaje: 'Tu perfil fue aprobado. Revisa tu correo personal para las credenciales y tu carnet.' };
  }

  if (decision === 'rechazado') {
    await rechazarVoluntario(uid, motivoRechazo);
    return { ok: true, estado: 'rechazado', mensaje: 'No fue posible aprobar tu registro. Revisa tu correo personal para mas detalles.' };
  }

  // pendiente_manual: no se envia correo todavia, solo confirmamos al cliente.
  return {
    ok: true,
    estado: 'pendiente_manual',
    mensaje: 'Tu perfil quedo en revision manual. Un coordinador verificara tus datos pronto.',
  };
});

// ------------------------------------------------------------------------------
// b) aprobarVoluntario(uid) — funcion interna (NO expuesta como callable)
// ------------------------------------------------------------------------------
/**
 * DECISION DE DISENO sobre el "carnet":
 * Para este MVP optamos por NO renderizar una imagen de carnet en el
 * servidor (eso requeriria un motor de canvas/HTML-to-image como
 * "puppeteer" o "@napi-rs/canvas", lo cual agrega dependencias pesadas,
 * tiempos de cold-start mayores y mas superficie de fallos en Cloud
 * Functions). En su lugar, el "carnet" se construye como un bloque HTML
 * cuidadosamente disenado e incrustado directamente en el cuerpo del correo
 * (tabla con la foto de rostro via URL firmada, datos del voluntario y el
 * codigo QR como imagen embebida vía "Content-ID" / data URL). Esto es mas
 * simple, mas robusto (no depende de renderizado headless en un entorno
 * serverless) y se ve bien en cualquier cliente de correo moderno. El QR en
 * si SI se genera como imagen real (PNG) con el paquete "qrcode", y se
 * adjunta al correo como inline attachment referenciado por cid.
 *
 * Flujo:
 *  1. Genera password temporal segura.
 *  2. Crea o actualiza el usuario en Firebase Auth con el email sintetico
 *     (cedula@voluntarios.lienzo.app) y esa password.
 *  3. Genera qrToken (uuid v4) y lo guarda en usuarios/{uid}.
 *  4. Genera el PNG del QR (codifica el qrToken) con el paquete "qrcode".
 *  5. Genera una URL firmada de la foto de rostro para mostrarla en el carnet.
 *  6. Envia el correo a emailPersonal con usuario (cedula) + password + carnet.
 */
async function aprobarVoluntario(uid) {
  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();

  if (!snapUsuario.exists) {
    console.error('aprobarVoluntario: no existe usuarios/' + uid);
    return;
  }

  const usuario = snapUsuario.data();
  const cedula = usuario.cedula || '';
  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const emailAuth = construirEmailAuthDesdeCedula(cedula);
  const passwordTemporal = generarPasswordTemporal();

  // ---- 1. Crear o actualizar el usuario en Firebase Auth --------------------
  let authUid = uid;
  try {
    // Intentamos actualizar primero asumiendo que el uid de Firestore ya
    // corresponde a un usuario de Auth (caso normal: el voluntario se
    // registro con email temporal/anonimo y luego completamos su alta real).
    await admin.auth().updateUser(uid, {
      email: emailAuth,
      password: passwordTemporal,
      emailVerified: false,
    });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      // Si por algun motivo no existe (por ejemplo el doc de Firestore se
      // creo antes de que existiera el usuario de Auth), lo creamos usando
      // el MISMO uid para mantener la relacion 1:1 con usuarios/{uid}.
      const nuevoUsuario = await admin.auth().createUser({
        uid,
        email: emailAuth,
        password: passwordTemporal,
        displayName: nombreCompleto,
      });
      authUid = nuevoUsuario.uid;
    } else {
      console.error('Error creando/actualizando usuario de Auth para', uid, error);
      throw error;
    }
  }

  // ---- 2. Asignar el custom claim de rol base "voluntario" -------------------
  // (El rol de Firestore "rol" tambien se actualiza abajo; el custom claim es
  // lo que efectivamente usan las reglas de seguridad y las funciones.)
  const claimsActuales = (await admin.auth().getUser(authUid)).customClaims || {};
  await admin.auth().setCustomUserClaims(authUid, {
    ...claimsActuales,
    role: claimsActuales.role || 'voluntario',
  });

  // ---- 3. Generar qrToken unico ------------------------------------------
  const qrToken = uuidv4();

  // ---- 4. Generar el PNG del QR (codifica el qrToken) ------------------------
  const qrBuffer = await QRCode.toBuffer(qrToken, {
    type: 'png',
    width: 300,
    margin: 2,
  });

  // ---- 5. URL firmada de la foto de rostro, para mostrarla en el carnet -----
  const rutaRostro = usuario.fotoRostroPath || `voluntarios/${uid}/rostro.jpg`;
  const urlRostro = await generarUrlFirmada(rutaRostro);

  // ---- 6. Persistir resultado en usuarios/{uid} ------------------------------
  await refUsuario.update({
    estado: 'aprobado',
    estadoVerificacion: 'aprobado',
    qrToken,
    rol: 'voluntario',
  });

  // ---- 7. Construir y enviar el correo con el carnet -------------------------
  const carnetHtml = construirHtmlCarnet({
    nombreCompleto,
    cedula,
    telefono: usuario.telefono,
    ciudad: usuario.ciudad,
    estadoProvincia: usuario.estadoProvincia,
    urlRostro,
  });

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="color:#0f766e;">Bienvenido(a) a Lienzo, ${escaparHtml(nombreCompleto)}</h2>
      <p>Tu registro como voluntario(a) fue <strong>aprobado</strong>. A continuacion encontraras tus credenciales de acceso y tu carnet digital.</p>

      <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:4px 0;"><strong>Usuario (tu cedula):</strong> ${escaparHtml(cedula)}</p>
        <p style="margin:4px 0;"><strong>Contrasena temporal:</strong> ${escaparHtml(passwordTemporal)}</p>
        <p style="margin:4px 0; font-size: 13px; color:#4b5563;">Por tu seguridad, te recomendamos cambiar esta contrasena despues de tu primer inicio de sesion.</p>
      </div>

      <h3 style="color:#0f766e;">Tu carnet digital de voluntario(a)</h3>
      ${carnetHtml}

      <p style="margin-top:24px; font-size:13px; color:#6b7280;">
        Si tienes dudas, contacta a un coordinador de Lienzo. Gracias por ayudar a proteger a los ninos de los centros de cuidado.
      </p>
    </div>
  `;

  await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'Lienzo - Tu registro fue aprobado',
    html: cuerpoCorreo,
    // El QR se adjunta inline para poder referenciarlo con cid en el HTML.
    // nodemailer permite "attachments" con cid incluso cuando llamamos a
    // enviarCorreo (extendemos la llamada de transporte directamente abajo).
  });

  // NOTA: la funcion "enviarCorreo" generica no soporta adjuntos inline, asi
  // que para el QR (que SI necesita ir como imagen real con cid) usamos el
  // transporte directamente. Esto evita complicar la firma de enviarCorreo
  // para el caso comun, que es solo HTML.
  const transporte = crearTransporteCorreo();
  if (transporte) {
    try {
      await transporte.sendMail({
        from: `"Lienzo - Red de Apoyo" <${obtenerRemitente()}>`,
        to: usuario.emailPersonal,
        subject: 'Lienzo - Tu carnet de voluntario(a) (QR)',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin:0 auto;">
            <p>Este es tu codigo QR de identificacion como voluntario(a) aprobado(a) de Lienzo. Preséntalo en el centro de cuidado donde colabores.</p>
            ${carnetHtml}
          </div>
        `,
        attachments: [
          {
            filename: 'qr-voluntario.png',
            content: qrBuffer,
            cid: 'qr-voluntario',
          },
        ],
      });
    } catch (error) {
      console.error('Error enviando correo con QR adjunto para', uid, error);
    }
  }
}

/**
 * Construye el bloque HTML del "carnet" del voluntario: foto de rostro,
 * nombre, cedula, telefono, ciudad/estado y el QR (referenciado por cid;
 * el cid solo se resuelve correctamente en el correo que lo adjunta —
 * ver aprobarVoluntario, segundo envio).
 */
function construirHtmlCarnet({ nombreCompleto, cedula, telefono, ciudad, estadoProvincia, urlRostro }) {
  const fotoHtml = urlRostro
    ? `<img src="${urlRostro}" alt="Foto" style="width:96px; height:96px; object-fit:cover; border-radius:8px; border:2px solid #0f766e;" />`
    : `<div style="width:96px; height:96px; background:#e5e7eb; border-radius:8px;"></div>`;

  return `
    <table style="width:100%; max-width:480px; border:2px solid #0f766e; border-radius:12px; overflow:hidden; border-collapse:collapse; font-family: Arial, sans-serif;">
      <tr>
        <td style="background:#0f766e; color:#ffffff; padding:10px 16px; font-weight:bold; font-size:14px;" colspan="2">
          LIENZO &middot; Carnet de Voluntario(a)
        </td>
      </tr>
      <tr>
        <td style="padding:16px; vertical-align:top; width:110px;">
          ${fotoHtml}
        </td>
        <td style="padding:16px; vertical-align:top;">
          <p style="margin:0 0 4px 0; font-size:16px; font-weight:bold; color:#111827;">${escaparHtml(nombreCompleto)}</p>
          <p style="margin:0 0 2px 0; font-size:13px; color:#374151;">Cedula: ${escaparHtml(cedula)}</p>
          <p style="margin:0 0 2px 0; font-size:13px; color:#374151;">Telefono: ${escaparHtml(telefono || '-')}</p>
          <p style="margin:0; font-size:13px; color:#374151;">${escaparHtml(ciudad || '-')}, ${escaparHtml(estadoProvincia || '-')}</p>
        </td>
        <td style="padding:16px; text-align:center; vertical-align:top; width:110px;">
          <img src="cid:qr-voluntario" alt="QR" style="width:90px; height:90px;" />
        </td>
      </tr>
    </table>
  `;
}

/**
 * Escape minimo de HTML para evitar inyeccion al insertar datos del usuario
 * directamente en el cuerpo de los correos.
 */
function escaparHtml(texto) {
  if (texto === undefined || texto === null) return '';
  return String(texto)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ------------------------------------------------------------------------------
// c) rechazarVoluntario(uid, motivo) — funcion interna
// ------------------------------------------------------------------------------
/**
 * Notifica por correo, en tono respetuoso y NUNCA acusatorio, que no fue
 * posible aprobar el registro. Siempre se invita a contactar a un
 * coordinador en caso de que la persona crea que se trato de un error —
 * los falsos positivos de un analisis automatico (o un revisor humano con
 * informacion incompleta) son posibles y la plataforma debe dejar una via
 * de apelacion humana.
 */
async function rechazarVoluntario(uid, motivo) {
  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();
  if (!snapUsuario.exists) {
    console.error('rechazarVoluntario: no existe usuarios/' + uid);
    return;
  }

  const usuario = snapUsuario.data();
  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const motivoTexto = motivo || 'No se pudieron verificar correctamente los datos proporcionados.';

  await refUsuario.update({
    estado: 'rechazado',
    estadoVerificacion: 'rechazado',
    motivoRechazo: motivoTexto,
  });

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color:#1f2937;">
      <h2 style="color:#9a3412;">Resultado de tu registro en Lienzo</h2>
      <p>Hola ${escaparHtml(nombreCompleto)},</p>
      <p>
        Gracias por tu interes en colaborar con los centros de cuidado de Lienzo.
        Lamentablemente, en esta ocasion no fue posible aprobar tu registro
        como voluntario(a).
      </p>
      <div style="background:#fff7ed; border:1px solid #fdba74; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:0;"><strong>Motivo indicado:</strong> ${escaparHtml(motivoTexto)}</p>
      </div>
      <p>
        Si crees que esto se debio a un error o un malentendido (por ejemplo,
        una foto poco clara o un dato mal escrito), por favor contacta a un
        coordinador de Lienzo para revisar tu caso nuevamente. Entendemos que
        los procesos de verificacion pueden tener fallas y queremos darte la
        oportunidad de aclarar cualquier inconsistencia.
      </p>
      <p>Gracias por tu comprension y por tu interes en apoyar a los ninos de los centros de cuidado.</p>
      <p style="color:#6b7280; font-size:13px;">— Equipo de Lienzo</p>
    </div>
  `;

  await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'Lienzo - Resultado de tu registro como voluntario',
    html: cuerpoCorreo,
  });
}

// ------------------------------------------------------------------------------
// d) enviarCodigoVerificacionEmail (callable)
// ------------------------------------------------------------------------------
/**
 * Genera un codigo de 6 digitos, lo guarda temporalmente en el doc del
 * usuario (campos codigoEmailTemp / codigoEmailExpira) y lo envia al
 * emailPersonal declarado. Este es el mecanismo para verificar el correo
 * PERSONAL (no el de Auth sintetico) — ver ARQUITECTURA.md, seccion
 * "Estrategia de login con cedula".
 */
exports.enviarCodigoVerificacionEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para verificar tu correo.'
    );
  }

  const uid = context.auth.uid;
  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();

  if (!snapUsuario.exists) {
    throw new functions.https.HttpsError('not-found', 'No se encontro tu perfil.');
  }

  const usuario = snapUsuario.data();
  if (!usuario.emailPersonal) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'No tienes un correo personal registrado en tu perfil.'
    );
  }

  const codigo = generarCodigo6Digitos();
  const expiraEnMs = Date.now() + MINUTOS_EXPIRACION_CODIGO_EMAIL * 60 * 1000;

  await refUsuario.update({
    codigoEmailTemp: codigo,
    codigoEmailExpira: admin.firestore.Timestamp.fromMillis(expiraEnMs),
  });

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin:0 auto; color:#1f2937;">
      <h2 style="color:#0f766e;">Tu codigo de verificacion - Lienzo</h2>
      <p>Usa este codigo para verificar tu correo personal:</p>
      <p style="font-size:32px; font-weight:bold; letter-spacing:6px; text-align:center; background:#f0fdf4; padding:16px; border-radius:8px; color:#0f766e;">
        ${codigo}
      </p>
      <p style="font-size:13px; color:#6b7280;">Este codigo expira en ${MINUTOS_EXPIRACION_CODIGO_EMAIL} minutos. Si no solicitaste esto, puedes ignorar este correo.</p>
    </div>
  `;

  const enviado = await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'Lienzo - Tu codigo de verificacion',
    html: cuerpoCorreo,
  });

  return { ok: true, enviado };
});

// ------------------------------------------------------------------------------
// e) verificarCodigoEmail (callable)
// ------------------------------------------------------------------------------
/**
 * Recibe { codigo }, lo compara contra codigoEmailTemp/codigoEmailExpira.
 * Si coincide y no ha expirado, marca emailVerificado: true y borra el
 * codigo temporal (para que no se pueda reutilizar).
 */
exports.verificarCodigoEmail = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError(
      'unauthenticated',
      'Debes iniciar sesion para verificar tu correo.'
    );
  }

  const codigoRecibido = data && data.codigo ? String(data.codigo).trim() : '';
  if (!codigoRecibido) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes enviar el codigo recibido por correo.');
  }

  const uid = context.auth.uid;
  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();

  if (!snapUsuario.exists) {
    throw new functions.https.HttpsError('not-found', 'No se encontro tu perfil.');
  }

  const usuario = snapUsuario.data();
  const codigoGuardado = usuario.codigoEmailTemp;
  const expira = usuario.codigoEmailExpira;

  if (!codigoGuardado || !expira) {
    throw new functions.https.HttpsError(
      'failed-precondition',
      'No hay un codigo de verificacion pendiente. Solicita uno nuevo.'
    );
  }

  const ahoraMs = Date.now();
  const expiraMs = expira.toMillis ? expira.toMillis() : new Date(expira).getTime();

  if (ahoraMs > expiraMs) {
    // Limpiamos el codigo vencido para forzar a pedir uno nuevo.
    await refUsuario.update({
      codigoEmailTemp: admin.firestore.FieldValue.delete(),
      codigoEmailExpira: admin.firestore.FieldValue.delete(),
    });
    throw new functions.https.HttpsError('deadline-exceeded', 'El codigo expiro. Solicita uno nuevo.');
  }

  if (codigoRecibido !== String(codigoGuardado)) {
    throw new functions.https.HttpsError('invalid-argument', 'El codigo ingresado no es correcto.');
  }

  await refUsuario.update({
    emailVerificado: true,
    codigoEmailTemp: admin.firestore.FieldValue.delete(),
    codigoEmailExpira: admin.firestore.FieldValue.delete(),
  });

  return { ok: true, emailVerificado: true };
});

// ------------------------------------------------------------------------------
// f) asignarRolAdmin / asignarRolVerificador (callables, solo admin)
// ------------------------------------------------------------------------------

/**
 * Helper comun: lanza permission-denied si quien invoca no es admin segun
 * su custom claim "role" (NUNCA confiar en nada que venga del cliente para
 * esto, solo en context.auth.token.role, que proviene del ID token firmado
 * por Firebase y que solo el Admin SDK puede modificar).
 */
function exigirRolAdmin(context) {
  if (!context.auth || !context.auth.token || context.auth.token.role !== 'admin') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un administrador puede realizar esta accion.'
    );
  }
}

/**
 * Igual que exigirRolAdmin, pero tambien acepta el rol "verificador". Se usa
 * para acciones de revision (aprobar/rechazar voluntarios) que segun
 * ARQUITECTURA.md puede realizar un admin O un verificador, a diferencia de
 * la gestion de roles (asignarRolAdmin/asignarRolVerificador) que es
 * exclusiva de admin.
 */
function exigirRolAdminOVerificador(context) {
  const rol = context.auth && context.auth.token && context.auth.token.role;
  if (rol !== 'admin' && rol !== 'verificador') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un administrador o verificador puede realizar esta accion.'
    );
  }
}

/**
 * asignarRolAdmin: otorga el custom claim role: 'admin' a un uid indicado.
 * Solo puede ser invocada por alguien que YA es admin (ver bootstrapAdmin.js
 * para como se crea el primer admin, ya que este es justamente el problema
 * de "huevo y gallina" que ese script resuelve).
 */
exports.asignarRolAdmin = functions.https.onCall(async (data, context) => {
  exigirRolAdmin(context);

  const uidObjetivo = data && data.uid;
  if (!uidObjetivo) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar el uid del usuario a promover.');
  }

  const usuarioObjetivo = await admin.auth().getUser(uidObjetivo);
  const claimsActuales = usuarioObjetivo.customClaims || {};

  await admin.auth().setCustomUserClaims(uidObjetivo, {
    ...claimsActuales,
    role: 'admin',
  });

  return { ok: true, uid: uidObjetivo, role: 'admin' };
});

/**
 * asignarRolVerificador: otorga el custom claim role: 'verificador' a un uid
 * indicado. Solo un admin puede hacerlo. Segun ARQUITECTURA.md, este rol
 * solo deberia darsele a un voluntario YA aprobado, pero la validacion de
 * "ya aprobado" se deja como buena practica recomendada para la UI del
 * futuro dashboard de admin; aqui se aplica el control de seguridad
 * fundamental (solo admin puede asignar roles).
 */
exports.asignarRolVerificador = functions.https.onCall(async (data, context) => {
  exigirRolAdmin(context);

  const uidObjetivo = data && data.uid;
  if (!uidObjetivo) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar el uid del usuario a promover.');
  }

  const usuarioObjetivo = await admin.auth().getUser(uidObjetivo);
  const claimsActuales = usuarioObjetivo.customClaims || {};

  await admin.auth().setCustomUserClaims(uidObjetivo, {
    ...claimsActuales,
    role: 'verificador',
  });

  return { ok: true, uid: uidObjetivo, role: 'verificador' };
});

// ------------------------------------------------------------------------------
// g) revisarVoluntario (callable, admin o verificador) — panel de administracion
// ------------------------------------------------------------------------------
/**
 * Permite que un admin/verificador, desde el panel (dashboard.html), apruebe
 * o rechace MANUALMENTE el registro de un voluntario que quedo en
 * "pendiente_manual" (o "pendiente_ia") tras enviarParaVerificacion.
 *
 * Reutiliza exactamente la misma logica de aprobarVoluntario/rechazarVoluntario
 * que usa el flujo automatico con IA, por lo que el resultado es identico:
 * se crea/actualiza la cuenta de Auth con una contrasena real, se genera el
 * carnet con QR y se envia todo por correo al voluntario (si se aprueba), o
 * se le notifica el rechazo con su motivo (si se rechaza).
 *
 * Es importante que esto sea una Cloud Function (y no una simple escritura
 * de Firestore desde el cliente): aunque las reglas de Firestore SI permiten
 * que un admin/verificador edite el campo "estado" directamente, solo el
 * Admin SDK (aqui) puede crear la cuenta de Auth con password real, generar
 * el QR y enviar los correos. Una edicion directa del documento nunca
 * dispararia nada de eso.
 */
exports.revisarVoluntario = functions.https.onCall(async (data, context) => {
  exigirRolAdminOVerificador(context);

  const uid = data && data.uid;
  const decision = data && data.decision; // 'aprobado' | 'rechazado'
  const motivoRechazo = (data && data.motivoRechazo) || null;

  if (!uid) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar el uid del voluntario a revisar.');
  }
  if (decision !== 'aprobado' && decision !== 'rechazado') {
    throw new functions.https.HttpsError('invalid-argument', 'decision debe ser "aprobado" o "rechazado".');
  }

  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();
  if (!snapUsuario.exists) {
    throw new functions.https.HttpsError('not-found', 'No se encontro el perfil indicado.');
  }

  const usuarioActual = snapUsuario.data();
  if (usuarioActual.estadoVerificacion === 'aprobado' || usuarioActual.estadoVerificacion === 'rechazado') {
    throw new functions.https.HttpsError(
      'failed-precondition',
      `Este voluntario ya fue revisado anteriormente (estado actual: ${usuarioActual.estadoVerificacion}).`
    );
  }

  // Auditoria en verificaciones/{uid}, igual que hace enviarParaVerificacion
  // para el flujo automatico, dejando constancia de quien decidio.
  await db.collection('verificaciones').doc(uid).set({
    metodo: 'manual',
    resultadoBruto: `Revision manual desde el panel por uid ${context.auth.uid} (rol: ${context.auth.token.role}).`,
    confianza: null,
    decision,
    revisadoPor: context.auth.uid,
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Mismos campos que actualiza enviarParaVerificacion antes de disparar la
  // accion correspondiente (mantener consistencia entre ambos flujos).
  await refUsuario.update({
    estadoVerificacion: decision,
    confianzaIA: null,
    fechaVerificacion: admin.firestore.FieldValue.serverTimestamp(),
    motivoRechazo: decision === 'rechazado' ? (motivoRechazo || 'No se pudieron verificar correctamente los datos proporcionados.') : null,
    verificadoPor: context.auth.uid,
  });

  if (decision === 'aprobado') {
    await aprobarVoluntario(uid);
    return { ok: true, estado: 'aprobado', mensaje: 'Voluntario aprobado. Se le envio un correo con sus credenciales y carnet.' };
  }

  await rechazarVoluntario(uid, motivoRechazo);
  return { ok: true, estado: 'rechazado', mensaje: 'Voluntario rechazado. Se le notifico el motivo por correo.' };
});
