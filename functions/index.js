/**
 * index.js — Cloud Functions de ChildCare
 * ==============================================================================
 * Backend de la plataforma humanitaria ChildCare (apoyo a centros de cuidado de
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
 *   usuarios/{uid}          -> perfil del voluntario + estado de verificacion.
 *   verificaciones/{uid}    -> bitacora/auditoria de cada intento de verificacion.
 *   cedulasBloqueadas/{ced} -> cedulas con registro bloqueado temporal o
 *                              permanentemente (ver revisarVoluntario, motivos
 *                              "datos_no_coinciden" y "no_elegible").
 *   Storage: /voluntarios/{uid}/rostro.jpg, /voluntarios/{uid}/cedula.jpg,
 *            /voluntarios/{uid}/perfil.jpg (foto de perfil editable, opcional)
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

const MODELO_CLAUDE = 'claude-sonnet-4-5';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const DOMINIO_AUTH_SINTETICO = '@voluntarios.lienzo.app';

const UMBRAL_APROBADO = 80;
const UMBRAL_PENDIENTE_MIN = 50;

const MINUTOS_EXPIRACION_CODIGO_EMAIL = 15;

const HORAS_BLOQUEO_TEMPORAL_CEDULA = 24;

function obtenerRemitente() {
  return process.env.EMAIL_USER;
}

// ------------------------------------------------------------------------------
// HELPERS GENERALES
// ------------------------------------------------------------------------------

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
 * Envia un correo, opcionalmente con adjuntos inline (referenciados por cid
 * desde el HTML, ej. <img src="cid:foto-perfil">). USA UN SOLO transporte y
 * UN SOLO sendMail por llamada: esto es deliberado. En una version anterior
 * el correo de "credenciales" y el correo del "carnet/QR" se enviaban como
 * dos correos separados (dos llamadas a sendMail), y si la segunda fallaba
 * (o si Gmail rechazaba/retrasaba el segundo envio inmediato desde la misma
 * cuenta) el voluntario se quedaba SIN el correo de credenciales sin que
 * nadie se enterara, porque el error solo se registraba en los logs del
 * servidor. Unificar todo en un solo correo con adjuntos elimina ese punto
 * de falla: o llega completo, o no llega (y entonces si se loguea el error).
 */
async function enviarCorreoConAdjuntos({ to, subject, html, attachments }) {
  const transporte = crearTransporteCorreo();
  if (!transporte) {
    console.warn(`No se envio el correo "${subject}" a ${to} (sin transporte configurado).`);
    return false;
  }
  try {
    await transporte.sendMail({
      from: `"ChildCare - Red de Apoyo" <${obtenerRemitente()}>`,
      to,
      subject,
      html,
      attachments: attachments || [],
    });
    return true;
  } catch (error) {
    console.error(`Error enviando correo "${subject}" a ${to}:`, error);
    return false;
  }
}

/** Atajo para correos sin adjuntos (mantiene la firma simple usada en el resto del archivo). */
async function enviarCorreo({ to, subject, html }) {
  return enviarCorreoConAdjuntos({ to, subject, html, attachments: [] });
}

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

function generarCodigo6Digitos() {
  const n = crypto.randomInt(0, 1000000);
  return String(n).padStart(6, '0');
}

function construirEmailAuthDesdeCedula(cedula) {
  return `${String(cedula).toUpperCase()}${DOMINIO_AUTH_SINTETICO}`;
}

/** Normaliza una cedula a la forma exacta usada como clave: ej "v12345678" -> "V12345678". */
function normalizarCedula(cedula) {
  return String(cedula || '').toUpperCase().trim();
}

async function descargarArchivoStorage(rutaStorage) {
  const bucket = storage.bucket();
  const file = bucket.file(rutaStorage);
  const [buffer] = await file.download();
  return buffer;
}

/** Borra un archivo de Storage sin lanzar si no existe (best-effort). */
async function borrarArchivoStorageSiExiste(rutaStorage) {
  try {
    const bucket = storage.bucket();
    await bucket.file(rutaStorage).delete();
  } catch (error) {
    if (error && error.code !== 404) {
      console.warn('No se pudo borrar', rutaStorage, error.message);
    }
  }
}

function detectarMimeImagen(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50) {
    return 'image/png';
  }
  return 'image/jpeg';
}

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
// HELPERS DE BLOQUEO DE CEDULA (cedulasBloqueadas/{cedula})
// ------------------------------------------------------------------------------

async function bloquearCedulaTemporal(cedula, motivo) {
  const cedulaN = normalizarCedula(cedula);
  if (!cedulaN) return;
  const disponibleDesdeMs = Date.now() + HORAS_BLOQUEO_TEMPORAL_CEDULA * 60 * 60 * 1000;
  await db.collection('cedulasBloqueadas').doc(cedulaN).set({
    tipo: 'temporal',
    motivo: motivo || 'datos_no_coinciden',
    disponibleDesde: admin.firestore.Timestamp.fromMillis(disponibleDesdeMs),
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function bloquearCedulaPermanente(cedula, motivo) {
  const cedulaN = normalizarCedula(cedula);
  if (!cedulaN) return;
  await db.collection('cedulasBloqueadas').doc(cedulaN).set({
    tipo: 'permanente',
    motivo: motivo || 'no_elegible',
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });
}


// ------------------------------------------------------------------------------
// ANALISIS DE IDENTIDAD CON CLAUDE (IA) — solo si hay ANTHROPIC_API_KEY
// ------------------------------------------------------------------------------

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

/** Calcula la edad en anos completos a partir de una fecha 'YYYY-MM-DD'. */
function calcularEdadDesdeFecha(fechaNacimientoStr) {
  if (!fechaNacimientoStr) return null;
  const nacimiento = new Date(fechaNacimientoStr + 'T00:00:00Z');
  if (isNaN(nacimiento.getTime())) return null;
  const ahora = new Date();
  let edad = ahora.getUTCFullYear() - nacimiento.getUTCFullYear();
  const aunNoCumple =
    ahora.getUTCMonth() < nacimiento.getUTCMonth() ||
    (ahora.getUTCMonth() === nacimiento.getUTCMonth() && ahora.getUTCDate() < nacimiento.getUTCDate());
  if (aunNoCumple) edad -= 1;
  return edad;
}

// ------------------------------------------------------------------------------
// verificarCedulaDisponible (callable, PUBLICO — sin necesidad de sesion)
// ------------------------------------------------------------------------------
/**
 * Paso 1 del wizard de registro: antes de dejar avanzar al siguiente paso,
 * el cliente llama a esto para saber si la cedula ingresada ya esta en uso
 * (alguien ya se registro con ella, sin importar el estado de su revision)
 * o si esta bloqueada (rechazo "no elegible" -> bloqueo permanente, o
 * rechazo "datos no coinciden" -> bloqueo temporal de 24 horas).
 *
 * Es deliberadamente PUBLICA (no exige context.auth): en este punto del
 * wizard la persona todavia no tiene ninguna cuenta ni sesion. No expone
 * informacion sensible: solo devuelve disponible:true/false y un mensaje
 * generico, nunca los datos de la persona que ya esta registrada con esa
 * cedula.
 */
exports.verificarCedulaDisponible = functions.https.onCall(async (data) => {
  const cedula = normalizarCedula(data && data.cedula);
  if (!cedula || cedula.length < 6) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar una cedula valida.');
  }

  // 1. Bloqueos explicitos (rechazo previo "no elegible" o "datos no coinciden").
  const refBloqueo = db.collection('cedulasBloqueadas').doc(cedula);
  const snapBloqueo = await refBloqueo.get();
  if (snapBloqueo.exists) {
    const bloqueo = snapBloqueo.data();
    if (bloqueo.tipo === 'permanente') {
      return {
        disponible: false,
        motivo: 'restringido',
        mensaje: 'Esta cedula no puede registrarse en la plataforma. Si crees que esto es un error, contacta a un coordinador de ChildCare.',
      };
    }
    if (bloqueo.tipo === 'temporal') {
      const disponibleDesdeMs = bloqueo.disponibleDesde && bloqueo.disponibleDesde.toMillis
        ? bloqueo.disponibleDesde.toMillis()
        : 0;
      if (Date.now() < disponibleDesdeMs) {
        return {
          disponible: false,
          motivo: 'temporal',
          disponibleDesde: disponibleDesdeMs,
          mensaje: 'Tu intento de registro anterior con esta cedula no pudo completarse porque algunos datos no coincidian. Puedes intentarlo de nuevo en 24 horas desde tu intento anterior.',
        };
      }
      // Ya paso el tiempo de espera: liberamos el bloqueo y dejamos continuar.
      await refBloqueo.delete().catch(() => {});
    }
  }

  // 2. Ya existe un registro (en cualquier estado) con esta cedula.
  const snapUsuarios = await db.collection('usuarios').where('cedula', '==', cedula).limit(1).get();
  if (!snapUsuarios.empty) {
    return {
      disponible: false,
      motivo: 'ya_registrado',
      mensaje: 'Esta cedula ya fue registrada anteriormente en ChildCare. No es posible registrarse dos veces con la misma cedula. Si necesitas ayuda con tu cuenta existente, contacta a un coordinador.',
    };
  }

  return { disponible: true };
});

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
 *  0. Verificacion de mayoria de edad como ultima linea de defensa: si por
 *     algun motivo el wizard del cliente no bloqueo a un menor (deberia
 *     haberlo hecho ya en el paso de fecha de nacimiento), aqui se rechaza
 *     de inmediato SIN llamar a la IA ni gastar ese costo.
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

  // ---- 0. Fail-safe de mayoria de edad --------------------------------------
  const edadCalculada = calcularEdadDesdeFecha(usuario.fechaNacimiento);
  if (edadCalculada !== null && edadCalculada < 18) {
    const motivo = 'Por motivos de seguridad, actualmente la plataforma no puede aceptar solicitudes de personas menores de edad.';
    await db.collection('verificaciones').doc(uid).set({
      metodo: 'validacion-edad',
      resultadoBruto: `Edad calculada: ${edadCalculada}. Registro bloqueado automaticamente por minoria de edad.`,
      confianza: null,
      decision: 'rechazado',
      fecha: admin.firestore.FieldValue.serverTimestamp(),
    });
    await refUsuario.update({
      estadoVerificacion: 'rechazado',
      motivoRechazo: motivo,
      fechaVerificacion: admin.firestore.FieldValue.serverTimestamp(),
      verificadoPor: 'validacion-edad',
    });
    await rechazarVoluntario(uid, motivo);
    return { ok: true, estado: 'rechazado', mensaje: motivo };
  }

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
      console.error('Error en analisis de Claude para', uid, '- cae a pendiente_manual:', error);
      decision = 'pendiente_manual';
      resultadoBruto = `Error al analizar con IA, enviado a revision manual: ${error.message}`;
      confianza = null;
    }
  } else {
    metodo = 'manual';
    decision = 'pendiente_manual';
    resultadoBruto = 'Verificacion automatica no configurada (sin ANTHROPIC_API_KEY). Enviado a revision manual.';
    confianza = null;
  }

  await db.collection('verificaciones').doc(uid).set({
    metodo,
    resultadoBruto,
    confianza,
    decision,
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });

  await refUsuario.update({
    estadoVerificacion: decision,
    confianzaIA: confianza,
    fechaVerificacion: admin.firestore.FieldValue.serverTimestamp(),
    motivoRechazo: decision === 'rechazado' ? motivoRechazo : null,
    verificadoPor: metodo === 'claude-ia' ? 'claude-ia' : null,
  });

  if (decision === 'aprobado') {
    await aprobarVoluntario(uid);
    return { ok: true, estado: 'aprobado', mensaje: 'Tu perfil fue aprobado. Revisa tu correo personal para las credenciales y tu carnet.' };
  }

  if (decision === 'rechazado') {
    await rechazarVoluntario(uid, motivoRechazo);
    return { ok: true, estado: 'rechazado', mensaje: 'No fue posible aprobar tu registro. Revisa tu correo personal para mas detalles.' };
  }

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
 * El "carnet" se construye como un bloque HTML incrustado directamente en el
 * cuerpo del correo (tabla con foto + datos + QR), evitando dependencias
 * pesadas de renderizado (canvas/puppeteer) en Cloud Functions. El QR se
 * genera como PNG real con "qrcode" y se adjunta inline por cid.
 *
 * CORRECCION IMPORTANTE (bug reportado: el correo de credenciales nunca
 * llegaba, y la foto de rostro salia en gris en el carnet):
 *   - Antes se enviaban DOS correos por separado (uno de credenciales+carnet
 *     sin adjuntos, y un segundo solo con el QR adjunto). El primero podia
 *     fallar silenciosamente sin que nadie se enterara, y la foto de rostro
 *     se referenciaba con una URL FIRMADA de Storage que requiere permisos
 *     de "signBlob" en la cuenta de servicio — si ese permiso no esta
 *     configurado, la firma falla silenciosamente y el <img> queda roto.
 *   - Ahora se envia UN SOLO correo con TODO (credenciales + carnet), y la
 *     foto de rostro/perfil se descarga como Buffer y se adjunta inline por
 *     cid (igual que el QR), sin depender de URLs firmadas ni de permisos
 *     adicionales de IAM. O llega todo, o se loguea el error — nunca un
 *     envio "a medias".
 *
 * Flujo:
 *  1. Genera password temporal segura.
 *  2. Crea o actualiza el usuario en Firebase Auth con el email sintetico
 *     (cedula@voluntarios.lienzo.app) y esa password.
 *  3. Genera qrToken (uuid v4) y lo guarda en usuarios/{uid}.
 *  4. Genera el PNG del QR (codifica el qrToken) con el paquete "qrcode".
 *  5. Descarga la foto de perfil (o de rostro si aun no hay foto de perfil
 *     elegida) como Buffer, para adjuntarla inline en el correo.
 *  6. Envia UN correo a emailPersonal con usuario + password + carnet + QR.
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
    await admin.auth().updateUser(uid, {
      email: emailAuth,
      password: passwordTemporal,
      emailVerified: false,
      disabled: false,
    });
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
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
  const claimsActuales = (await admin.auth().getUser(authUid)).customClaims || {};
  await admin.auth().setCustomUserClaims(authUid, {
    ...claimsActuales,
    role: claimsActuales.role || 'voluntario',
  });

  // ---- 3. Generar qrToken unico (si no tenia ya uno) -------------------------
  const qrToken = usuario.qrToken || uuidv4();

  // ---- 4. Generar el PNG del QR (codifica el qrToken) ------------------------
  const qrBuffer = await QRCode.toBuffer(qrToken, {
    type: 'png',
    width: 300,
    margin: 2,
  });

  // ---- 5. Descargar la foto a mostrar en el carnet (perfil > rostro) --------
  const rutaFoto = usuario.fotoPerfilPath || usuario.fotoRostroPath || `voluntarios/${uid}/rostro.jpg`;
  let bufferFoto = null;
  let mimeFoto = 'image/jpeg';
  try {
    bufferFoto = await descargarArchivoStorage(rutaFoto);
    mimeFoto = detectarMimeImagen(bufferFoto);
  } catch (error) {
    console.warn('No se pudo descargar la foto de perfil/rostro para el carnet de', uid, '-', error.message);
    bufferFoto = null;
  }

  // ---- 6. Persistir resultado en usuarios/{uid} ------------------------------
  await refUsuario.update({
    estado: 'aprobado',
    estadoVerificacion: 'aprobado',
    qrToken,
    rol: 'voluntario',
    fotoPerfilPath: usuario.fotoPerfilPath || usuario.fotoRostroPath || null,
  });

  // ---- 7. Construir y enviar el UNICO correo (credenciales + carnet) --------
  const carnetHtml = construirHtmlCarnet({
    nombreCompleto,
    cedula,
    telefono: usuario.telefono,
    ciudad: usuario.ciudad,
    estadoProvincia: usuario.estadoProvincia,
    tieneFoto: !!bufferFoto,
  });

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #1f2937;">
      <h2 style="color:#0f766e;">Bienvenido(a) a ChildCare, ${escaparHtml(nombreCompleto)}</h2>
      <p>Tu registro como voluntario(a) fue <strong>aprobado</strong>. A continuacion encontraras tus credenciales de acceso y tu carnet digital.</p>

      <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:4px 0;"><strong>Usuario (tu cedula):</strong> ${escaparHtml(cedula)}</p>
        <p style="margin:4px 0;"><strong>Contrasena temporal:</strong> ${escaparHtml(passwordTemporal)}</p>
        <p style="margin:4px 0; font-size: 13px; color:#4b5563;">Por tu seguridad, te recomendamos cambiar esta contrasena despues de tu primer inicio de sesion (puedes hacerlo desde tu Perfil).</p>
      </div>

      <h3 style="color:#0f766e;">Tu carnet digital de voluntario(a)</h3>
      <p style="font-size:13px; color:#4b5563;">Preséntalo (o muestra el codigo QR) en el centro de cuidado donde colabores.</p>
      ${carnetHtml}

      <p style="margin-top:24px; font-size:13px; color:#6b7280;">
        Si tienes dudas, contacta a un coordinador de ChildCare. Gracias por ayudar a proteger a los ninos de los centros de cuidado.
      </p>
    </div>
  `;

  const adjuntos = [
    { filename: 'qr-voluntario.png', content: qrBuffer, cid: 'qr-voluntario' },
  ];
  if (bufferFoto) {
    adjuntos.push({
      filename: mimeFoto === 'image/png' ? 'foto-perfil.png' : 'foto-perfil.jpg',
      content: bufferFoto,
      cid: 'foto-perfil',
    });
  }

  const enviado = await enviarCorreoConAdjuntos({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Tu registro fue aprobado (credenciales y carnet)',
    html: cuerpoCorreo,
    attachments: adjuntos,
  });

  if (!enviado) {
    console.error(`ALERTA: no se pudo enviar el correo de aprobacion/credenciales a ${usuario.emailPersonal} (uid ${uid}). Revisa la configuracion de EMAIL_USER/EMAIL_PASS.`);
  }
}

/**
 * Construye el bloque HTML del "carnet" del voluntario: foto (referenciada
 * por cid:foto-perfil, resuelta por el correo que la adjunta), nombre,
 * cedula, telefono, ciudad/estado y el QR (cid:qr-voluntario).
 */
function construirHtmlCarnet({ nombreCompleto, cedula, telefono, ciudad, estadoProvincia, tieneFoto }) {
  const fotoHtml = tieneFoto
    ? `<img src="cid:foto-perfil" alt="Foto" style="width:96px; height:96px; object-fit:cover; border-radius:8px; border:2px solid #0f766e;" />`
    : `<div style="width:96px; height:96px; background:#e5e7eb; border-radius:8px; display:flex; align-items:center; justify-content:center; color:#9ca3af; font-size:11px; text-align:center;">Sin foto</div>`;

  return `
    <table style="width:100%; max-width:480px; border:2px solid #0f766e; border-radius:12px; overflow:hidden; border-collapse:collapse; font-family: Arial, sans-serif;">
      <tr>
        <td style="background:#0f766e; color:#ffffff; padding:10px 16px; font-weight:bold; font-size:14px;" colspan="3">
          CHILDCARE &middot; Carnet de Voluntario(a)
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
// (definido en la seccion de helpers generales, arriba)

// ------------------------------------------------------------------------------
// c) rechazarVoluntario(uid, motivo) — funcion interna (motivo "otro" / IA)
// ------------------------------------------------------------------------------
/**
 * Notifica por correo, en tono respetuoso y NUNCA acusatorio, que no fue
 * posible aprobar el registro. Se usa para el rechazo automatico de la IA y
 * para el motivo "otro" del panel manual (motivo libre). NO borra el
 * registro ni bloquea la cedula: la persona puede ser revisada de nuevo si
 * un coordinador decide reabrir el caso.
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
      <h2 style="color:#9a3412;">Resultado de tu registro en ChildCare</h2>
      <p>Hola ${escaparHtml(nombreCompleto)},</p>
      <p>
        Gracias por tu interes en colaborar con los centros de cuidado de ChildCare.
        Lamentablemente, en esta ocasion no fue posible aprobar tu registro
        como voluntario(a).
      </p>
      <div style="background:#fff7ed; border:1px solid #fdba74; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:0;"><strong>Motivo indicado:</strong> ${escaparHtml(motivoTexto)}</p>
      </div>
      <p>
        Si crees que esto se debio a un error o un malentendido (por ejemplo,
        una foto poco clara o un dato mal escrito), por favor contacta a un
        coordinador de ChildCare para revisar tu caso nuevamente. Entendemos que
        los procesos de verificacion pueden tener fallas y queremos darte la
        oportunidad de aclarar cualquier inconsistencia.
      </p>
      <p>Gracias por tu comprension y por tu interes en apoyar a los ninos de los centros de cuidado.</p>
      <p style="color:#6b7280; font-size:13px;">— Equipo de ChildCare</p>
    </div>
  `;

  await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Resultado de tu registro como voluntario',
    html: cuerpoCorreo,
  });
}

// ------------------------------------------------------------------------------
// c.1) manejarRechazoDatosNoCoinciden(uid) — motivo estructurado #1
// ------------------------------------------------------------------------------
/**
 * "Los datos suministrados no coinciden": se interpreta como un posible
 * error de la persona al registrarse (foto borrosa, documento equivocado,
 * dato mal escrito), NO como sospecha de mala intencion. Por eso se le da
 * la oportunidad de volver a intentarlo, pero no de inmediato (para evitar
 * reintentos en bucle): se borra el registro actual y se bloquea la cedula
 * por 24 horas, pasado ese tiempo puede volver a registrarse desde cero.
 */
async function manejarRechazoDatosNoCoinciden(uid, usuario) {
  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const cedula = usuario.cedula || '';
  const emailPersonal = usuario.emailPersonal;

  await bloquearCedulaTemporal(cedula, 'datos_no_coinciden');

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color:#1f2937;">
      <h2 style="color:#9a3412;">Resultado de tu registro en ChildCare</h2>
      <p>Hola ${escaparHtml(nombreCompleto)},</p>
      <p>
        Revisamos tu solicitud de registro como voluntario(a) y notamos que
        algunos de los datos suministrados (por ejemplo, las fotos o la
        informacion del documento de identidad) no coincidian entre si, por
        lo que no pudimos verificarla.
      </p>
      <div style="background:#fff7ed; border:1px solid #fdba74; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:0;">Esto suele pasar por fotos poco claras, con mala luz, o con algun dato escrito incorrectamente. Por eso tu registro fue eliminado de nuestra base de datos.</p>
      </div>
      <p>
        <strong>Puedes volver a intentar tu registro despues de 24 horas</strong>
        desde este correo, asegurandote de que las fotos de tu rostro y de tu
        cedula sean claras, bien iluminadas y legibles, y que los datos
        coincidan exactamente con tu documento de identidad.
      </p>
      <p>Si crees que esto se debio a un error de nuestro sistema, contacta a un coordinador de ChildCare.</p>
      <p style="color:#6b7280; font-size:13px;">— Equipo de ChildCare</p>
    </div>
  `;

  await enviarCorreo({
    to: emailPersonal,
    subject: 'ChildCare - No pudimos verificar tu registro',
    html: cuerpoCorreo,
  });

  // Borrado del registro: fotos en Storage (best-effort), doc de Firestore,
  // y el usuario de Auth si llego a crearse (best-effort, no deberia existir
  // todavia con password real en este punto del flujo, pero por seguridad).
  await Promise.all([
    borrarArchivoStorageSiExiste(usuario.fotoRostroPath || `voluntarios/${uid}/rostro.jpg`),
    borrarArchivoStorageSiExiste(usuario.fotoCedulaPath || `voluntarios/${uid}/cedula.jpg`),
    borrarArchivoStorageSiExiste(usuario.fotoPerfilPath || `voluntarios/${uid}/perfil.jpg`),
  ]);
  await db.collection('usuarios').doc(uid).delete().catch((e) => console.warn('No se pudo borrar usuarios/' + uid, e.message));
  await admin.auth().deleteUser(uid).catch((e) => console.warn('No se pudo borrar el usuario de Auth ' + uid, e.message));
}

// ------------------------------------------------------------------------------
// c.2) manejarRechazoNoElegible(uid) — motivo estructurado #2
// ------------------------------------------------------------------------------
/**
 * "Voluntario no elegible": a diferencia del caso anterior, aqui SI hay una
 * decision de fondo de que esta persona no debe tener acceso a los centros
 * de cuidado (por ejemplo, antecedentes, comportamiento sospechoso o
 * cualquier otra senal detectada por el equipo humano). Por la seguridad de
 * los ninos beneficiarios, esta cedula queda restringida PERMANENTEMENTE:
 * nunca podra volver a registrarse. El registro NO se borra (se conserva
 * como rechazado, para que quede constancia/auditoria), y se le responde
 * con un tono respetuoso, ofreciendo la alternativa de donar.
 */
async function manejarRechazoNoElegible(uid, usuario) {
  const refUsuario = db.collection('usuarios').doc(uid);
  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const cedula = usuario.cedula || '';
  const motivoTexto = 'Voluntario no elegible para colaborar directamente con los centros de cuidado.';

  await refUsuario.update({
    estado: 'rechazado',
    estadoVerificacion: 'rechazado',
    motivoRechazo: motivoTexto,
    restringido: true,
  });

  await bloquearCedulaPermanente(cedula, 'no_elegible');

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color:#1f2937;">
      <h2 style="color:#9a3412;">Resultado de tu registro en ChildCare</h2>
      <p>Hola ${escaparHtml(nombreCompleto)},</p>
      <p>
        Gracias por tu interes en colaborar con los centros de cuidado de
        ChildCare. Lamentablemente, despues de revisar tu solicitud, no fue
        posible aceptar tu registro como voluntario(a).
      </p>
      <p>
        Por la seguridad y proteccion de los ninos beneficiarios de nuestros
        centros de cuidado, debemos ser muy cuidadosos con quienes tienen
        acceso directo a ellos, y en este caso no podemos continuar con tu
        proceso de voluntariado. Lamentamos sinceramente las molestias que
        esto pueda ocasionarte.
      </p>
      <div style="background:#eff6ff; border:1px solid #93c5fd; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:0 0 8px 0;">
          Si aun deseas apoyar nuestra causa, existe la posibilidad de
          contribuir con una <strong>donacion</strong>, una forma igualmente
          valiosa de ayudarnos a seguir protegiendo y cuidando a estos ninos.
        </p>
        <p style="margin:0;">Si te interesa, contacta a un coordinador de ChildCare para mas informacion sobre como donar.</p>
      </div>
      <p>Gracias por tu comprension.</p>
      <p style="color:#6b7280; font-size:13px;">— Equipo de ChildCare</p>
    </div>
  `;

  await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Resultado de tu registro como voluntario',
    html: cuerpoCorreo,
  });
}

// ------------------------------------------------------------------------------
// d) enviarCodigoVerificacionEmail (callable)
// ------------------------------------------------------------------------------
/**
 * Genera un codigo de 6 digitos, lo guarda temporalmente en el doc del
 * usuario (campos codigoEmailTemp / codigoEmailExpira) y lo envia al
 * emailPersonal declarado.
 *
 * Proteccion anti-espera (refuerza en el servidor el contador de 1 minuto
 * que ya se muestra en el boton "Reenviar codigo" del cliente): si ya se
 * envio un codigo hace menos de 60 segundos, se rechaza con
 * 'resource-exhausted' en vez de generar/enviar uno nuevo. Esto evita que
 * alguien intente sortear el contador visual llamando a la funcion
 * directamente.
 */
const SEGUNDOS_ESPERA_REENVIO_CODIGO = 60;

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

  const ultimoEnvioMs = usuario.codigoEmailUltimoEnvio && usuario.codigoEmailUltimoEnvio.toMillis
    ? usuario.codigoEmailUltimoEnvio.toMillis()
    : 0;
  const segundosTranscurridos = (Date.now() - ultimoEnvioMs) / 1000;
  if (ultimoEnvioMs && segundosTranscurridos < SEGUNDOS_ESPERA_REENVIO_CODIGO) {
    throw new functions.https.HttpsError(
      'resource-exhausted',
      `Espera ${Math.ceil(SEGUNDOS_ESPERA_REENVIO_CODIGO - segundosTranscurridos)} segundos antes de solicitar otro codigo.`
    );
  }

  const codigo = generarCodigo6Digitos();
  const expiraEnMs = Date.now() + MINUTOS_EXPIRACION_CODIGO_EMAIL * 60 * 1000;

  await refUsuario.update({
    codigoEmailTemp: codigo,
    codigoEmailExpira: admin.firestore.Timestamp.fromMillis(expiraEnMs),
    codigoEmailUltimoEnvio: admin.firestore.FieldValue.serverTimestamp(),
  });

  const cuerpoCorreo = `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin:0 auto; color:#1f2937;">
      <h2 style="color:#0f766e;">Tu codigo de verificacion - ChildCare</h2>
      <p>Usa este codigo para verificar tu correo personal:</p>
      <p style="font-size:32px; font-weight:bold; letter-spacing:6px; text-align:center; background:#f0fdf4; padding:16px; border-radius:8px; color:#0f766e;">
        ${codigo}
      </p>
      <p style="font-size:13px; color:#6b7280;">Este codigo expira en ${MINUTOS_EXPIRACION_CODIGO_EMAIL} minutos. Si no solicitaste esto, puedes ignorar este correo.</p>
    </div>
  `;

  const enviado = await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Tu codigo de verificacion',
    html: cuerpoCorreo,
  });

  return { ok: true, enviado, esperaSegundos: SEGUNDOS_ESPERA_REENVIO_CODIGO };
});

// ------------------------------------------------------------------------------
// e) verificarCodigoEmail (callable)
// ------------------------------------------------------------------------------
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
// f) asignarRolAdmin / asignarRolVerificador / asignarRolVoluntario (admin)
// ------------------------------------------------------------------------------

function exigirRolAdmin(context) {
  if (!context.auth || !context.auth.token || context.auth.token.role !== 'admin') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un administrador puede realizar esta accion.'
    );
  }
}

function exigirRolAdminOVerificador(context) {
  const rol = context.auth && context.auth.token && context.auth.token.role;
  if (rol !== 'admin' && rol !== 'verificador') {
    throw new functions.https.HttpsError(
      'permission-denied',
      'Solo un administrador o verificador puede realizar esta accion.'
    );
  }
}

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

  // Tambien actualizamos el campo "rol" en Firestore (ademas del custom
  // claim, que es lo que realmente rige los permisos) para que el panel
  // de "todos los usuarios" pueda mostrar el rol actual sin tener que
  // consultar Auth por cada fila.
  await db.collection('usuarios').doc(uidObjetivo).update({ rol: 'verificador' }).catch(() => {});

  return { ok: true, uid: uidObjetivo, role: 'verificador' };
});

/**
 * asignarRolVoluntario: complemento de asignarRolVerificador, para "bajar"
 * a alguien de verificador a voluntario otra vez desde el modulo de
 * usuarios del panel (solo accesible al usuario master/admin).
 */
exports.asignarRolVoluntario = functions.https.onCall(async (data, context) => {
  exigirRolAdmin(context);

  const uidObjetivo = data && data.uid;
  if (!uidObjetivo) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar el uid del usuario.');
  }

  const usuarioObjetivo = await admin.auth().getUser(uidObjetivo);
  const claimsActuales = usuarioObjetivo.customClaims || {};

  await admin.auth().setCustomUserClaims(uidObjetivo, {
    ...claimsActuales,
    role: 'voluntario',
  });

  await db.collection('usuarios').doc(uidObjetivo).update({ rol: 'voluntario' }).catch(() => {});

  return { ok: true, uid: uidObjetivo, role: 'voluntario' };
});

// ------------------------------------------------------------------------------
// g) revisarVoluntario (callable, admin o verificador) — panel de administracion
// ------------------------------------------------------------------------------
/**
 * Permite que un admin/verificador, desde el panel, apruebe o rechace
 * MANUALMENTE el registro de un voluntario pendiente.
 *
 * Para "rechazado" ahora se admite un "motivoTipo" estructurado:
 *   - 'datos_no_coinciden': borra el registro y bloquea la cedula 24h.
 *   - 'no_elegible': bloquea la cedula PERMANENTEMENTE y envia el correo de
 *     "no aceptado, considera donar".
 *   - 'otro' (o sin motivoTipo, para compatibilidad): comportamiento previo,
 *     motivo libre via motivoRechazo/motivoTexto, sin borrar ni bloquear.
 */
exports.revisarVoluntario = functions.https.onCall(async (data, context) => {
  exigirRolAdminOVerificador(context);

  const uid = data && data.uid;
  const decision = data && data.decision; // 'aprobado' | 'rechazado'
  const motivoTipo = (data && data.motivoTipo) || 'otro'; // 'datos_no_coinciden' | 'no_elegible' | 'otro'
  const motivoTexto = (data && (data.motivoTexto || data.motivoRechazo)) || null;

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

  // Auditoria en verificaciones/{uid}. Se escribe ANTES de cualquier posible
  // borrado del doc de usuarios/{uid} (caso "datos_no_coinciden"), para que
  // quede constancia aunque el perfil deje de existir.
  await db.collection('verificaciones').doc(uid).set({
    metodo: 'manual',
    resultadoBruto: `Revision manual desde el panel por uid ${context.auth.uid} (rol: ${context.auth.token.role}). motivoTipo: ${decision === 'rechazado' ? motivoTipo : 'n/a'}.`,
    confianza: null,
    decision,
    motivoTipo: decision === 'rechazado' ? motivoTipo : null,
    revisadoPor: context.auth.uid,
    fecha: admin.firestore.FieldValue.serverTimestamp(),
  });

  if (decision === 'aprobado') {
    await refUsuario.update({
      estadoVerificacion: 'aprobado',
      confianzaIA: null,
      fechaVerificacion: admin.firestore.FieldValue.serverTimestamp(),
      motivoRechazo: null,
      verificadoPor: context.auth.uid,
    });
    await aprobarVoluntario(uid);
    return { ok: true, estado: 'aprobado', mensaje: 'Voluntario aprobado. Se le envio un correo con sus credenciales y carnet.' };
  }

  // decision === 'rechazado'
  if (motivoTipo === 'datos_no_coinciden') {
    await manejarRechazoDatosNoCoinciden(uid, usuarioActual);
    return {
      ok: true,
      estado: 'rechazado',
      motivoTipo,
      mensaje: 'Se elimino el registro y se le notifico que puede intentarlo de nuevo en 24 horas.',
    };
  }

  if (motivoTipo === 'no_elegible') {
    await manejarRechazoNoElegible(uid, usuarioActual);
    return {
      ok: true,
      estado: 'rechazado',
      motivoTipo,
      mensaje: 'El voluntario quedo restringido permanentemente y se le notifico por correo.',
    };
  }

  // 'otro': motivo libre, sin borrar ni bloquear.
  await refUsuario.update({
    estadoVerificacion: 'rechazado',
    confianzaIA: null,
    fechaVerificacion: admin.firestore.FieldValue.serverTimestamp(),
    motivoRechazo: motivoTexto || 'No se pudieron verificar correctamente los datos proporcionados.',
    verificadoPor: context.auth.uid,
  });
  await rechazarVoluntario(uid, motivoTexto);
  return { ok: true, estado: 'rechazado', motivoTipo: 'otro', mensaje: 'Voluntario rechazado. Se le notifico el motivo por correo.' };
});

// ------------------------------------------------------------------------------
// h) cambiarEstadoCuenta (callable, solo admin/master) — bloquear/inhabilitar
// ------------------------------------------------------------------------------
/**
 * Habilita o inhabilita la cuenta de un voluntario/verificador ya aprobado.
 * Inhabilitar:
 *   - marca usuarios/{uid}.deshabilitado = true (campo bloqueado para el
 *     propio usuario por firestore.rules, solo Cloud Functions lo cambia).
 *   - deshabilita la cuenta en Firebase Auth (impide login: Firebase
 *     devuelve el codigo "auth/user-disabled" automaticamente).
 *   - revoca tokens de refresco activos, para que una sesion ya iniciada
 *     no pueda seguir usandose mas alla de la expiracion del ID token actual.
 */
exports.cambiarEstadoCuenta = functions.https.onCall(async (data, context) => {
  exigirRolAdmin(context);

  const uidObjetivo = data && data.uid;
  const deshabilitado = !!(data && data.deshabilitado);
  if (!uidObjetivo) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar el uid del usuario.');
  }

  await admin.auth().updateUser(uidObjetivo, { disabled: deshabilitado });
  if (deshabilitado) {
    await admin.auth().revokeRefreshTokens(uidObjetivo).catch(() => {});
  }

  await db.collection('usuarios').doc(uidObjetivo).update({ deshabilitado }).catch((error) => {
    console.warn('No se pudo actualizar el campo deshabilitado en Firestore para', uidObjetivo, error.message);
  });

  return { ok: true, uid: uidObjetivo, deshabilitado };
});

// ------------------------------------------------------------------------------
// i) reenviarPassword (callable, solo admin/master)
// ------------------------------------------------------------------------------
/**
 * Genera una nueva contrasena temporal para un usuario ya aprobado y se la
 * envia a su correo personal registrado. Util cuando alguien olvido su
 * contrasena y necesita que un coordinador se la reenvie manualmente.
 */
exports.reenviarPassword = functions.https.onCall(async (data, context) => {
  exigirRolAdmin(context);

  const uidObjetivo = data && data.uid;
  if (!uidObjetivo) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar el uid del usuario.');
  }

  const refUsuario = db.collection('usuarios').doc(uidObjetivo);
  const snapUsuario = await refUsuario.get();
  if (!snapUsuario.exists) {
    throw new functions.https.HttpsError('not-found', 'No se encontro el perfil indicado.');
  }
  const usuario = snapUsuario.data();
  if (usuario.estadoVerificacion !== 'aprobado') {
    throw new functions.https.HttpsError('failed-precondition', 'Solo se puede reenviar contrasena a usuarios ya aprobados.');
  }

  const nuevaPassword = generarPasswordTemporal();
  await admin.auth().updateUser(uidObjetivo, { password: nuevaPassword });

  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const enviado = await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Tu nueva contrasena de acceso',
    html: construirCuerpoCorreoNuevaPassword({ nombreCompleto, cedula: usuario.cedula, nuevaPassword }),
  });

  return { ok: true, enviado };
});

function construirCuerpoCorreoNuevaPassword({ nombreCompleto, cedula, nuevaPassword }) {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 480px; margin:0 auto; color:#1f2937;">
      <h2 style="color:#0f766e;">Tu nueva contrasena - ChildCare</h2>
      <p>Hola ${escaparHtml(nombreCompleto)},</p>
      <p>Un coordinador de ChildCare (o tu solicitud de recuperacion) generaron una nueva contrasena de acceso para tu cuenta:</p>
      <div style="background:#f0fdf4; border:1px solid #86efac; border-radius:8px; padding:16px; margin:16px 0;">
        <p style="margin:4px 0;"><strong>Usuario (tu cedula):</strong> ${escaparHtml(cedula)}</p>
        <p style="margin:4px 0;"><strong>Nueva contrasena:</strong> ${escaparHtml(nuevaPassword)}</p>
      </div>
      <p style="font-size:13px; color:#6b7280;">Por tu seguridad, te recomendamos cambiarla despues de iniciar sesion (puedes hacerlo desde tu Perfil). Si no solicitaste este cambio, contacta de inmediato a un coordinador de ChildCare.</p>
    </div>
  `;
}

// ------------------------------------------------------------------------------
// j) solicitarRecuperacionPassword (callable, PUBLICO) — login: "olvide mi contrasena"
// ------------------------------------------------------------------------------
/**
 * Permite recuperar acceso SOLO si la cuenta ya esta (a) aprobada por un
 * admin/verificador y (b) con el correo personal ya verificado — exactamente
 * las dos condiciones que pidio Oswaldo. Antes de eso, no existe una cuenta
 * de Auth con password real a la que recuperar acceso de todas formas.
 *
 * Por privacidad, siempre responde con mensajes genericos que no confirman
 * ni niegan la existencia de una cedula especifica salvo en el caso de
 * exito (donde de todas formas el correo ya estaba verificado por el propio
 * dueno con anterioridad).
 */
exports.solicitarRecuperacionPassword = functions.https.onCall(async (data) => {
  const cedula = normalizarCedula(data && data.cedula);
  if (!cedula) {
    throw new functions.https.HttpsError('invalid-argument', 'Debes indicar tu cedula.');
  }

  const snap = await db.collection('usuarios').where('cedula', '==', cedula).limit(1).get();
  if (snap.empty) {
    return { ok: false, mensaje: 'No encontramos una cuenta registrada con esa cedula.' };
  }

  const docUsuario = snap.docs[0];
  const usuario = docUsuario.data();
  const uid = docUsuario.id;

  if (usuario.deshabilitado) {
    return { ok: false, mensaje: 'Tu cuenta esta inhabilitada. Contacta a un coordinador de ChildCare.' };
  }
  if (usuario.estadoVerificacion !== 'aprobado') {
    return { ok: false, mensaje: 'Tu cuenta todavia no ha sido aprobada por un coordinador. La recuperacion de contrasena solo esta disponible para cuentas ya aprobadas.' };
  }
  if (!usuario.emailVerificado) {
    return { ok: false, mensaje: 'Tu correo personal todavia no esta verificado. Contacta a un coordinador de ChildCare para verificarlo antes de poder recuperar tu contrasena.' };
  }
  if (!usuario.emailPersonal) {
    return { ok: false, mensaje: 'Tu cuenta no tiene un correo personal registrado. Contacta a un coordinador de ChildCare.' };
  }

  const nuevaPassword = generarPasswordTemporal();
  await admin.auth().updateUser(uid, { password: nuevaPassword });

  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  await enviarCorreo({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Recuperacion de contrasena',
    html: construirCuerpoCorreoNuevaPassword({ nombreCompleto, cedula: usuario.cedula, nuevaPassword }),
  });

  return { ok: true, mensaje: 'Te enviamos una nueva contrasena a tu correo personal registrado.' };
});

// ------------------------------------------------------------------------------
// k) regenerarCarnet (callable, cualquier voluntario aprobado, sobre si mismo)
// ------------------------------------------------------------------------------
/**
 * Permite que el propio voluntario (desde el modulo de Perfil) reenvie su
 * carnet por correo despues de cambiar su foto de perfil, usando la MISMA
 * logica/plantilla de aprobarVoluntario (adjuntos por cid, sin URLs
 * firmadas), pero sin tocar credenciales ni generar una password nueva.
 */
exports.regenerarCarnet = functions.https.onCall(async (data, context) => {
  if (!context.auth || !context.auth.uid) {
    throw new functions.https.HttpsError('unauthenticated', 'Debes iniciar sesion.');
  }
  const uid = context.auth.uid;
  const refUsuario = db.collection('usuarios').doc(uid);
  const snapUsuario = await refUsuario.get();
  if (!snapUsuario.exists) {
    throw new functions.https.HttpsError('not-found', 'No se encontro tu perfil.');
  }
  const usuario = snapUsuario.data();
  if (usuario.estadoVerificacion !== 'aprobado') {
    throw new functions.https.HttpsError('failed-precondition', 'Solo puedes generar tu carnet si tu registro ya fue aprobado.');
  }

  const nombreCompleto = `${usuario.nombre || ''} ${usuario.apellido || ''}`.trim();
  const qrToken = usuario.qrToken || uuidv4();
  if (!usuario.qrToken) {
    await refUsuario.update({ qrToken });
  }

  const qrBuffer = await QRCode.toBuffer(qrToken, { type: 'png', width: 300, margin: 2 });

  const rutaFoto = usuario.fotoPerfilPath || usuario.fotoRostroPath || `voluntarios/${uid}/rostro.jpg`;
  let bufferFoto = null;
  let mimeFoto = 'image/jpeg';
  try {
    bufferFoto = await descargarArchivoStorage(rutaFoto);
    mimeFoto = detectarMimeImagen(bufferFoto);
  } catch (error) {
    console.warn('regenerarCarnet: no se pudo descargar la foto para', uid, error.message);
  }

  const carnetHtml = construirHtmlCarnet({
    nombreCompleto,
    cedula: usuario.cedula,
    telefono: usuario.telefono,
    ciudad: usuario.ciudad,
    estadoProvincia: usuario.estadoProvincia,
    tieneFoto: !!bufferFoto,
  });

  const adjuntos = [{ filename: 'qr-voluntario.png', content: qrBuffer, cid: 'qr-voluntario' }];
  if (bufferFoto) {
    adjuntos.push({
      filename: mimeFoto === 'image/png' ? 'foto-perfil.png' : 'foto-perfil.jpg',
      content: bufferFoto,
      cid: 'foto-perfil',
    });
  }

  const enviado = await enviarCorreoConAdjuntos({
    to: usuario.emailPersonal,
    subject: 'ChildCare - Tu carnet de voluntario(a) actualizado',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin:0 auto; color:#1f2937;">
        <h2 style="color:#0f766e;">Carnet actualizado</h2>
        <p>Hola ${escaparHtml(nombreCompleto)}, aqui tienes tu carnet de voluntario(a) actualizado:</p>
        ${carnetHtml}
      </div>
    `,
    attachments: adjuntos,
  });

  return { ok: true, enviado };
});
