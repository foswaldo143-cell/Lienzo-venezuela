/* =========================================================
   Red Lienzo — Lógica del wizard de registro de voluntario
   ========================================================= */

import { auth, db, storage } from "./firebase-init.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const DOMINIO_AUTH_SINTETICO = "@voluntarios.lienzo.app";
const TOTAL_PASOS = 6;

let pasoActual = 1;

/* Estado acumulado del formulario, llenado a medida que el usuario avanza. */
const estado = {
  nombre: "",
  apellido: "",
  cedula: "",
  telefono: "",
  telefonoEmergencia: "",
  emailPersonal: "",
  emailVerificado: false,
  lat: null,
  lng: null,
  ciudad: "",
  estadoProvincia: "",
  direccionTexto: "",
  fotoRostroArchivo: null,
  fotoCedulaArchivo: null,
};

/* ---------------------- Navegación entre pasos ---------------------- */

const textoPaso = document.getElementById("texto-paso");
const rellenoProgreso = document.getElementById("relleno-progreso");

function mostrarPaso(numero) {
  document.querySelectorAll(".paso").forEach((seccion) => seccion.classList.remove("activo"));
  const seccionDestino = document.getElementById("paso-" + numero) || document.getElementById("paso-exito");
  seccionDestino.classList.add("activo");

  if (numero >= 1 && numero <= TOTAL_PASOS) {
    pasoActual = numero;
    textoPaso.textContent = `Paso ${numero} de ${TOTAL_PASOS}`;
    rellenoProgreso.style.width = (numero / TOTAL_PASOS * 100) + "%";
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function limpiarError(idError) {
  const el = document.getElementById(idError);
  el.classList.remove("visible");
  el.textContent = "";
}

function mostrarErrorPaso(idError, texto) {
  const el = document.getElementById(idError);
  el.textContent = texto;
  el.classList.add("visible");
}

/* Validación + recolección de datos de cada paso antes de avanzar. */
function validarYGuardarPaso(numero) {
  if (numero === 1) {
    limpiarError("error-paso-1");
    const nombre = document.getElementById("nombre").value.trim();
    const apellido = document.getElementById("apellido").value.trim();
    const tipoCedula = document.getElementById("cedula-tipo-reg").value;
    const numeroCedula = document.getElementById("cedula-numero-reg").value.trim();

    if (!nombre || !apellido) {
      mostrarErrorPaso("error-paso-1", "Por favor completa tu nombre y apellido.");
      return false;
    }
    if (!/^\d{6,9}$/.test(numeroCedula)) {
      mostrarErrorPaso("error-paso-1", "El número de cédula debe tener solo dígitos (entre 6 y 9 números).");
      return false;
    }
    estado.nombre = nombre;
    estado.apellido = apellido;
    estado.cedula = tipoCedula + numeroCedula;
    return true;
  }

  if (numero === 2) {
    limpiarError("error-paso-2");
    const telefono = document.getElementById("telefono").value.trim();
    const telefonoEmergencia = document.getElementById("telefono-emergencia").value.trim();

    if (!/^\d{10}$/.test(telefono)) {
      mostrarErrorPaso("error-paso-2", "Escribe los 10 dígitos de tu número de WhatsApp.");
      return false;
    }
    if (!/^\d{10}$/.test(telefonoEmergencia)) {
      mostrarErrorPaso("error-paso-2", "Escribe los 10 dígitos del número de la persona de contacto.");
      return false;
    }
    estado.telefono = "+58" + telefono;
    estado.telefonoEmergencia = "+58" + telefonoEmergencia;
    return true;
  }

  if (numero === 3) {
    limpiarError("error-paso-3");
    const email = document.getElementById("email-personal").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      mostrarErrorPaso("error-paso-3", "Escribe un correo electrónico válido.");
      return false;
    }
    estado.emailPersonal = email;
    return true;
  }

  if (numero === 4) {
    limpiarError("error-paso-4");
    const ciudad = document.getElementById("ciudad").value.trim();
    const estadoProvincia = document.getElementById("estado-provincia").value;
    const direccionTexto = document.getElementById("direccion-texto").value.trim();

    if (!ciudad || !estadoProvincia || !direccionTexto) {
      mostrarErrorPaso("error-paso-4", "Completa ciudad, estado y dirección detallada.");
      return false;
    }
    if (estado.lat === null || estado.lng === null) {
      mostrarErrorPaso("error-paso-4", "Marca tu ubicación en el mapa buscando tu dirección o tocando el punto exacto.");
      return false;
    }
    estado.ciudad = ciudad;
    estado.estadoProvincia = estadoProvincia;
    estado.direccionTexto = direccionTexto;
    return true;
  }

  if (numero === 5) {
    limpiarError("error-paso-5");
    if (!estado.fotoRostroArchivo) {
      mostrarErrorPaso("error-paso-5", "Falta la foto de tu rostro.");
      return false;
    }
    if (!estado.fotoCedulaArchivo) {
      mostrarErrorPaso("error-paso-5", "Falta la foto de tu cédula.");
      return false;
    }
    return true;
  }

  return true;
}

document.querySelectorAll("[data-siguiente]").forEach((boton) => {
  boton.addEventListener("click", () => {
    const destino = parseInt(boton.dataset.siguiente, 10);
    if (validarYGuardarPaso(pasoActual)) {
      if (destino === 6) {
        construirResumen();
      }
      mostrarPaso(destino);
    }
  });
});

document.querySelectorAll("[data-anterior]").forEach((boton) => {
  boton.addEventListener("click", () => {
    mostrarPaso(parseInt(boton.dataset.anterior, 10));
  });
});

/* ---------------------- Paso 2: máscara simple de teléfono ---------------------- */

["telefono", "telefono-emergencia"].forEach((id) => {
  const input = document.getElementById(id);
  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 10);
  });
});

document.getElementById("cedula-numero-reg").addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/\D/g, "");
});

/* ---------------------- Cuenta y perfil parcial ----------------------
   El código de verificación solo puede enviarse a un usuario autenticado
   con un perfil en Firestore (la Cloud Function enviarCodigoVerificacionEmail
   lo exige). Por eso, en cuanto el voluntario pide el código en el paso 3,
   creamos su cuenta y un perfil parcial con lo que ya sabemos (pasos 1 y 2).
   Si el voluntario nunca pide el código, la cuenta se crea de todas formas
   al enviar el formulario completo (paso 6), como respaldo. ---------------------- */

async function asegurarCuentaYPerfilParcial() {
  if (auth.currentUser) {
    // La cuenta ya existe (se creó al pedir el código). Si el correo
    // cambió desde entonces, lo actualizamos antes de reenviar el código.
    await setDoc(doc(db, "usuarios", auth.currentUser.uid), {
      emailPersonal: estado.emailPersonal,
    }, { merge: true });
    return auth.currentUser.uid;
  }

  const passwordTemporal = generarPasswordTemporal();
  const emailSintetico = estado.cedula.toUpperCase() + DOMINIO_AUTH_SINTETICO;

  const credencial = await createUserWithEmailAndPassword(auth, emailSintetico, passwordTemporal);
  const uid = credencial.user.uid;

  // Perfil parcial: solo los campos que ya conocemos en este punto del
  // formulario. El envío final (paso 6) sobrescribe el documento completo
  // con el resto de los datos (dirección, fotos, etc.).
  await setDoc(doc(db, "usuarios", uid), {
    cedula: estado.cedula.toUpperCase(),
    nombre: estado.nombre,
    apellido: estado.apellido,
    telefono: estado.telefono,
    telefonoEmergencia: estado.telefonoEmergencia,
    emailPersonal: estado.emailPersonal,
    emailVerificado: false,
    rolSolicitado: "voluntario",
    rol: "voluntario_pendiente",
    estado: "pendiente_verificacion",
    fechaRegistro: serverTimestamp(),
  });

  return uid;
}

/* ---------------------- Paso 3: envío y verificación de código de email ---------------------- */

const btnEnviarCodigo = document.getElementById("btn-enviar-codigo");
const estadoEnvioCodigo = document.getElementById("estado-envio-codigo");
const bloqueCodigo = document.getElementById("bloque-codigo");
const btnVerificarCodigo = document.getElementById("btn-verificar-codigo");
const estadoVerificacionEmail = document.getElementById("estado-verificacion-email");

btnEnviarCodigo.addEventListener("click", async () => {
  limpiarError("error-paso-3");
  const email = document.getElementById("email-personal").value.trim();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    mostrarErrorPaso("error-paso-3", "Escribe un correo electrónico válido antes de enviar el código.");
    return;
  }
  if (!estado.cedula || !estado.nombre) {
    mostrarErrorPaso("error-paso-3", "Falta completar el paso 1 (tus datos) antes de continuar.");
    return;
  }

  estado.emailPersonal = email;

  btnEnviarCodigo.disabled = true;
  const textoOriginalBoton = btnEnviarCodigo.textContent;
  btnEnviarCodigo.textContent = "Enviando...";
  estadoEnvioCodigo.textContent = "";
  estadoEnvioCodigo.className = "estado-verificacion-email pendiente";

  try {
    await asegurarCuentaYPerfilParcial();

    const functions = getFunctions();
    const enviarCodigoVerificacionEmail = httpsCallable(functions, "enviarCodigoVerificacionEmail");
    const resultado = await enviarCodigoVerificacionEmail();

    // IMPORTANTE: la función puede responder "ok" sin haber enviado el
    // correo de verdad (por ejemplo, si el servidor todavía no tiene
    // configurado el envío de correos). Por eso revisamos el campo
    // "enviado" en vez de asumir éxito solo porque no hubo excepción.
    if (resultado && resultado.data && resultado.data.enviado) {
      estadoEnvioCodigo.textContent = "Listo, te enviamos un código de 6 dígitos a tu correo. Si no lo ves en unos minutos, revisa también la carpeta de spam o no deseado.";
      estadoEnvioCodigo.className = "estado-verificacion-email ok";
      bloqueCodigo.classList.remove("oculto");
    } else {
      estadoEnvioCodigo.textContent = "Tu solicitud se registró, pero el sistema de envío de correos todavía no está activo en el servidor. Puedes continuar sin verificar tu correo por ahora; lo verificaremos más adelante.";
      estadoEnvioCodigo.className = "estado-verificacion-email aviso";
    }
  } catch (error) {
    console.warn("No se pudo enviar el código de verificación todavía:", error);
    estadoEnvioCodigo.textContent = "No pudimos conectar con el servidor para enviar el código. Puedes continuar e intentarlo más adelante.";
    estadoEnvioCodigo.className = "estado-verificacion-email aviso";
  } finally {
    btnEnviarCodigo.disabled = false;
    btnEnviarCodigo.textContent = textoOriginalBoton;
  }
});

btnVerificarCodigo.addEventListener("click", async () => {
  const codigo = document.getElementById("codigo-verificacion").value.trim();
  if (!/^\d{6}$/.test(codigo)) {
    estadoVerificacionEmail.textContent = "Escribe el código de 6 dígitos que recibiste por correo.";
    estadoVerificacionEmail.className = "estado-verificacion-email aviso";
    return;
  }

  estadoVerificacionEmail.textContent = "Verificando...";
  estadoVerificacionEmail.className = "estado-verificacion-email pendiente";

  try {
    const functions = getFunctions();
    const verificarCodigoEmail = httpsCallable(functions, "verificarCodigoEmail");
    const resultado = await verificarCodigoEmail({ codigo });

    if (resultado && resultado.data && resultado.data.emailVerificado) {
      estado.emailVerificado = true;
      estadoVerificacionEmail.textContent = "¡Correo verificado correctamente!";
      estadoVerificacionEmail.className = "estado-verificacion-email ok";
    } else {
      estadoVerificacionEmail.textContent = "El código no es correcto. Puedes intentar de nuevo o continuar; lo verificaremos más adelante.";
      estadoVerificacionEmail.className = "estado-verificacion-email aviso";
    }
  } catch (error) {
    console.warn("verificarCodigoEmail no disponible todavía:", error);
    estadoVerificacionEmail.textContent = "Esta función estará disponible próximamente. Puedes continuar sin problema.";
    estadoVerificacionEmail.className = "estado-verificacion-email aviso";
  }
});

/* ---------------------- Paso 4: mapa Leaflet + Nominatim ---------------------- */

const COORD_INICIAL = { lat: 10.0678, lng: -69.3467 }; // Barquisimeto, referencia inicial

const mapa = L.map("mapa").setView([COORD_INICIAL.lat, COORD_INICIAL.lng], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; colaboradores de OpenStreetMap',
  maxZoom: 19,
}).addTo(mapa);

let marcador = null;
const infoCoordenadas = document.getElementById("info-coordenadas");

function colocarMarcador(lat, lng) {
  estado.lat = lat;
  estado.lng = lng;

  if (marcador) {
    marcador.setLatLng([lat, lng]);
  } else {
    marcador = L.marker([lat, lng], { draggable: true }).addTo(mapa);
    marcador.on("dragend", (evento) => {
      const posicion = evento.target.getLatLng();
      estado.lat = posicion.lat;
      estado.lng = posicion.lng;
      actualizarInfoCoordenadas();
    });
  }
  mapa.setView([lat, lng], 16);
  actualizarInfoCoordenadas();
}

function actualizarInfoCoordenadas() {
  infoCoordenadas.textContent = `Ubicación marcada: ${estado.lat.toFixed(5)}, ${estado.lng.toFixed(5)}. Puedes arrastrar el pin para ajustar.`;
}

mapa.on("click", (evento) => {
  colocarMarcador(evento.latlng.lat, evento.latlng.lng);
});

const inputBuscarDireccion = document.getElementById("buscar-direccion");
const btnBuscarDireccion = document.getElementById("btn-buscar-direccion");

async function buscarDireccion() {
  const consulta = inputBuscarDireccion.value.trim();
  if (!consulta) return;

  btnBuscarDireccion.disabled = true;
  const textoOriginal = btnBuscarDireccion.textContent;
  btnBuscarDireccion.textContent = "Buscando...";

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(consulta + ", Venezuela")}`;
    const respuesta = await fetch(url, {
      headers: { "Accept-Language": "es" },
    });
    const resultados = await respuesta.json();

    if (resultados && resultados.length > 0) {
      const primero = resultados[0];
      colocarMarcador(parseFloat(primero.lat), parseFloat(primero.lon));
    } else {
      infoCoordenadas.textContent = "No encontramos esa dirección. Intenta con más detalle o marca el punto manualmente en el mapa.";
    }
  } catch (error) {
    console.warn("Error buscando dirección en Nominatim:", error);
    infoCoordenadas.textContent = "No se pudo buscar en este momento. Marca el punto manualmente tocando el mapa.";
  } finally {
    btnBuscarDireccion.disabled = false;
    btnBuscarDireccion.textContent = textoOriginal;
  }
}

btnBuscarDireccion.addEventListener("click", buscarDireccion);
inputBuscarDireccion.addEventListener("keydown", (evento) => {
  if (evento.key === "Enter") {
    evento.preventDefault();
    buscarDireccion();
  }
});

/* ---------------------- Paso 5: fotos con vista previa ---------------------- */

function configurarInputFoto(idInput, idPreview, propiedadEstado) {
  const input = document.getElementById(idInput);
  const preview = document.getElementById(idPreview);

  input.addEventListener("change", () => {
    const archivo = input.files && input.files[0];
    if (!archivo) return;

    estado[propiedadEstado] = archivo;

    const lector = new FileReader();
    lector.onload = (evento) => {
      preview.src = evento.target.result;
      preview.classList.add("visible");
    };
    lector.readAsDataURL(archivo);
  });
}

configurarInputFoto("foto-rostro", "preview-rostro", "fotoRostroArchivo");
configurarInputFoto("foto-cedula", "preview-cedula", "fotoCedulaArchivo");

/* ---------------------- Paso 6: resumen ---------------------- */

function construirResumen() {
  const resumenDatos = document.getElementById("resumen-datos");
  resumenDatos.innerHTML = `
    <dt>Nombre completo</dt>
    <dd>${escaparTexto(estado.nombre)} ${escaparTexto(estado.apellido)}</dd>

    <dt>Cédula</dt>
    <dd>${escaparTexto(estado.cedula)}</dd>

    <dt>Tu WhatsApp</dt>
    <dd>${escaparTexto(estado.telefono)}</dd>

    <dt>Contacto de emergencia</dt>
    <dd>${escaparTexto(estado.telefonoEmergencia)}</dd>

    <dt>Correo personal</dt>
    <dd>${escaparTexto(estado.emailPersonal)}</dd>

    <dt>Ubicación</dt>
    <dd>${escaparTexto(estado.direccionTexto)}, ${escaparTexto(estado.ciudad)}, ${escaparTexto(estado.estadoProvincia)}</dd>
  `;

  const resumenFotos = document.getElementById("resumen-fotos");
  resumenFotos.innerHTML = "";

  const previewRostro = document.getElementById("preview-rostro");
  const previewCedula = document.getElementById("preview-cedula");

  if (previewRostro.src) {
    const imgR = document.createElement("img");
    imgR.src = previewRostro.src;
    imgR.alt = "Miniatura foto de rostro";
    resumenFotos.appendChild(imgR);
  }
  if (previewCedula.src) {
    const imgC = document.createElement("img");
    imgC.src = previewCedula.src;
    imgC.alt = "Miniatura foto de cédula";
    resumenFotos.appendChild(imgC);
  }
}

function escaparTexto(texto) {
  const div = document.createElement("div");
  div.textContent = texto || "";
  return div.innerHTML;
}

/* ---------------------- Envío final ---------------------- */

const formVoluntario = document.getElementById("form-voluntario");
const btnEnviar = document.getElementById("btn-enviar");
const textoBtnEnviar = document.getElementById("texto-btn-enviar");

formVoluntario.addEventListener("submit", async (evento) => {
  evento.preventDefault();

  limpiarError("error-paso-6");
  document.getElementById("info-paso-6").classList.remove("visible");

  const consentimiento = document.getElementById("consentimiento");
  if (!consentimiento.checked) {
    mostrarErrorPaso("error-paso-6", "Debes confirmar el consentimiento para continuar.");
    return;
  }

  btnEnviar.disabled = true;
  textoBtnEnviar.innerHTML = '<span class="cargando-spinner"></span> Enviando...';

  try {
    // 1. Si el voluntario ya pidió el código de verificación en el paso 3,
    //    su cuenta y perfil parcial ya existen: los reutilizamos. Si no,
    //    los creamos ahora (con una contraseña temporal aleatoria; el
    //    backend entrega las credenciales reales una vez aprobado).
    const uid = await asegurarCuentaYPerfilParcial();

    // 2. Subir fotos a Storage.
    const refRostro = ref(storage, `voluntarios/${uid}/rostro.jpg`);
    const refCedula = ref(storage, `voluntarios/${uid}/cedula.jpg`);

    await uploadBytes(refRostro, estado.fotoRostroArchivo);
    await uploadBytes(refCedula, estado.fotoCedulaArchivo);

    // 3. Crear el documento en usuarios/{uid} con exactamente los campos
    //    que el cliente puede escribir según el documento de arquitectura.
    //    "rol" y "estado" SIEMPRE van fijos: el cliente no puede auto-aprobarse.
    await setDoc(doc(db, "usuarios", uid), {
      cedula: estado.cedula.toUpperCase(),
      nombre: estado.nombre,
      apellido: estado.apellido,
      telefono: estado.telefono,
      telefonoEmergencia: estado.telefonoEmergencia,
      emailPersonal: estado.emailPersonal,
      emailVerificado: estado.emailVerificado,
      rolSolicitado: "voluntario",
      rol: "voluntario_pendiente",
      estado: "pendiente_verificacion",
      ciudad: estado.ciudad,
      estadoProvincia: estado.estadoProvincia,
      direccionTexto: estado.direccionTexto,
      lat: estado.lat,
      lng: estado.lng,
      fotoRostroPath: `voluntarios/${uid}/rostro.jpg`,
      fotoCedulaPath: `voluntarios/${uid}/cedula.jpg`,
      fechaRegistro: serverTimestamp(),
    });

    // 4. Si existe la función callable que dispara la verificación, la
    //    invocamos. Si no existe todavía, no rompemos el flujo: el trigger
    //    onCreate del backend puede encargarse de todas formas.
    try {
      const functions = getFunctions();
      const enviarParaVerificacion = httpsCallable(functions, "enviarParaVerificacion");
      await enviarParaVerificacion({ uid });
    } catch (errorFuncion) {
      console.warn("enviarParaVerificacion no disponible todavía, continuando igualmente:", errorFuncion);
    }

    mostrarPaso(99); // fuerza a mostrar la pantalla de éxito (paso-exito)

  } catch (error) {
    console.error("Error al enviar el registro:", error);
    mostrarErrorPaso("error-paso-6", "No pudimos completar tu registro en este momento. Verifica tu conexión a internet e intenta de nuevo.");
  } finally {
    btnEnviar.disabled = false;
    textoBtnEnviar.textContent = "Enviar para verificación";
  }
});

function generarPasswordTemporal() {
  const caracteres = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let resultado = "";
  for (let i = 0; i < 16; i++) {
    resultado += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
  }
  return resultado;
}
