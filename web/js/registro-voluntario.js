/* =========================================================
   ChildCare — Lógica del wizard de registro de voluntario
   ========================================================= */

import { auth, db, storage } from "./firebase-init.js";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, uploadBytes } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";
import { poblarSelectEstados, poblarSelectCiudades } from "./venezuela-datos.js";

const DOMINIO_AUTH_SINTETICO = "@voluntarios.lienzo.app";
const TOTAL_PASOS = 6;
const SEGUNDOS_ESPERA_REENVIO_CODIGO = 60;

let pasoActual = 1;

/* Estado acumulado del formulario, llenado a medida que el usuario avanza. */
const estado = {
  nombre: "",
  apellido: "",
  cedula: "",
  fechaNacimiento: "",
  edad: null,
  telefono: "",
  telefonoEmergencia: "",
  emailPersonal: "",
  emailVerificado: false,
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

/* ---------------------- Paso 1: cálculo de edad ---------------------- */

function calcularEdadDesdeFecha(fechaStr) {
  if (!fechaStr) return null;
  const partes = fechaStr.split("-");
  if (partes.length !== 3) return null;
  const anioNac = parseInt(partes[0], 10);
  const mesNac = parseInt(partes[1], 10);
  const diaNac = parseInt(partes[2], 10);
  if (!anioNac || !mesNac || !diaNac) return null;

  const hoy = new Date();
  let edad = hoy.getUTCFullYear() - anioNac;
  const mesActual = hoy.getUTCMonth() + 1;
  const diaActual = hoy.getUTCDate();
  if (mesActual < mesNac || (mesActual === mesNac && diaActual < diaNac)) {
    edad -= 1;
  }
  return edad;
}

const inputFechaNacimiento = document.getElementById("fecha-nacimiento");
const edadCalculadaTexto = document.getElementById("edad-calculada");
const avisoMenorEdad = document.getElementById("aviso-menor-edad");

inputFechaNacimiento.addEventListener("change", () => {
  const edad = calcularEdadDesdeFecha(inputFechaNacimiento.value);
  if (edad === null) {
    edadCalculadaTexto.textContent = "";
    avisoMenorEdad.classList.add("oculto");
    return;
  }
  edadCalculadaTexto.textContent = `Edad: ${edad} años`;
  if (edad < 18) {
    avisoMenorEdad.textContent = "Por razones de seguridad, en este momento no podemos aceptar voluntarios menores de 18 años.";
    avisoMenorEdad.classList.remove("oculto");
  } else {
    avisoMenorEdad.classList.add("oculto");
  }
});

/* ---------------------- Validación + recolección de cada paso ---------------------- */
/* Devuelve true/false o una Promise<boolean> (paso 1 necesita verificar la
   cédula contra el servidor antes de permitir avanzar). */
function validarYGuardarPaso(numero) {
  if (numero === 1) {
    return validarYGuardarPaso1();
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
    if (!estado.emailVerificado) {
      mostrarErrorPaso("error-paso-3", "Debes verificar tu correo antes de continuar.");
      return false;
    }
    estado.emailPersonal = email;
    return true;
  }

  if (numero === 4) {
    limpiarError("error-paso-4");
    const estadoProvincia = document.getElementById("estado-provincia").value;
    const ciudad = document.getElementById("ciudad").value;
    const direccionTexto = document.getElementById("direccion-texto").value.trim();

    if (!estadoProvincia || !ciudad || !direccionTexto) {
      mostrarErrorPaso("error-paso-4", "Completa estado, ciudad y dirección.");
      return false;
    }
    if (direccionTexto.length > 50) {
      mostrarErrorPaso("error-paso-4", "La dirección no puede tener más de 50 caracteres.");
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

const btnSiguiente1 = document.getElementById("btn-siguiente-1");
const textoBtnSiguiente1 = document.getElementById("texto-btn-siguiente-1");

async function validarYGuardarPaso1() {
  limpiarError("error-paso-1");
  avisoMenorEdad.classList.add("oculto");

  const nombre = document.getElementById("nombre").value.trim();
  const apellido = document.getElementById("apellido").value.trim();
  const tipoCedula = document.getElementById("cedula-tipo-reg").value;
  const numeroCedula = document.getElementById("cedula-numero-reg").value.trim();
  const fechaNacimiento = inputFechaNacimiento.value;

  if (!nombre || !apellido) {
    mostrarErrorPaso("error-paso-1", "Por favor completa tu nombre y apellido.");
    return false;
  }
  if (!/^\d{6,9}$/.test(numeroCedula)) {
    mostrarErrorPaso("error-paso-1", "El número de cédula debe tener solo dígitos (entre 6 y 9 números).");
    return false;
  }
  if (!fechaNacimiento) {
    mostrarErrorPaso("error-paso-1", "Por favor indica tu fecha de nacimiento.");
    return false;
  }

  const edad = calcularEdadDesdeFecha(fechaNacimiento);
  if (edad === null) {
    mostrarErrorPaso("error-paso-1", "La fecha de nacimiento no es válida.");
    return false;
  }
  if (edad < 18) {
    avisoMenorEdad.textContent = "Por razones de seguridad, en este momento no podemos aceptar voluntarios menores de 18 años.";
    avisoMenorEdad.classList.remove("oculto");
    return false;
  }

  const cedulaCompleta = tipoCedula + numeroCedula;

  btnSiguiente1.disabled = true;
  const textoOriginal = textoBtnSiguiente1.textContent;
  textoBtnSiguiente1.innerHTML = '<span class="cargando-spinner"></span> Verificando...';

  try {
    const functions = getFunctions();
    const verificarCedulaDisponible = httpsCallable(functions, "verificarCedulaDisponible");
    const resultado = await verificarCedulaDisponible({ cedula: cedulaCompleta });

    if (resultado && resultado.data && resultado.data.disponible === false) {
      mostrarErrorPaso(
        "error-paso-1",
        resultado.data.mensaje || "Esta cédula ya está registrada y no puede continuar."
      );
      return false;
    }
  } catch (error) {
    console.warn("No se pudo verificar la cédula contra el servidor todavía:", error);
    // No bloqueamos el avance si el servidor no está disponible: el backend
    // vuelve a validar la cédula de todas formas al enviar el registro final.
  } finally {
    btnSiguiente1.disabled = false;
    textoBtnSiguiente1.textContent = textoOriginal;
  }

  estado.nombre = nombre;
  estado.apellido = apellido;
  estado.cedula = cedulaCompleta;
  estado.fechaNacimiento = fechaNacimiento;
  estado.edad = edad;
  return true;
}

document.querySelectorAll("[data-siguiente]").forEach((boton) => {
  boton.addEventListener("click", async () => {
    const destino = parseInt(boton.dataset.siguiente, 10);
    boton.disabled = true;
    try {
      const ok = await validarYGuardarPaso(pasoActual);
      if (ok) {
        if (destino === 6) {
          construirResumen();
        }
        mostrarPaso(destino);
      }
    } finally {
      boton.disabled = false;
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
    fechaNacimiento: estado.fechaNacimiento,
    edad: estado.edad,
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
const btnReenviarCodigo = document.getElementById("btn-reenviar-codigo");
const contadorReenvio = document.getElementById("contador-reenvio");
const btnSiguiente3 = document.getElementById("btn-siguiente-3");

let intervaloReenvio = null;

function iniciarCooldownReenvio(segundosIniciales) {
  let restante = segundosIniciales;
  btnReenviarCodigo.classList.remove("oculto");
  btnReenviarCodigo.disabled = true;
  contadorReenvio.classList.remove("oculto");

  if (intervaloReenvio) {
    window.clearInterval(intervaloReenvio);
  }

  function pintar() {
    contadorReenvio.textContent = `Podrás reenviar el código en ${restante}s.`;
  }
  pintar();

  intervaloReenvio = window.setInterval(() => {
    restante -= 1;
    if (restante <= 0) {
      window.clearInterval(intervaloReenvio);
      intervaloReenvio = null;
      btnReenviarCodigo.disabled = false;
      contadorReenvio.classList.add("oculto");
      contadorReenvio.textContent = "";
      return;
    }
    pintar();
  }, 1000);
}

async function solicitarCodigoVerificacion(boton) {
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

  boton.disabled = true;
  const textoOriginalBoton = boton.textContent;
  boton.textContent = "Enviando...";
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
      btnEnviarCodigo.classList.add("oculto");
      const espera = (resultado.data.esperaSegundos) || SEGUNDOS_ESPERA_REENVIO_CODIGO;
      iniciarCooldownReenvio(espera);
    } else {
      estadoEnvioCodigo.textContent = "Tu solicitud se registró, pero el sistema de envío de correos todavía no está activo en el servidor. Intenta de nuevo en un momento.";
      estadoEnvioCodigo.className = "estado-verificacion-email aviso";
    }
  } catch (error) {
    console.warn("No se pudo enviar el código de verificación todavía:", error);
    if (error && error.code === "auth/email-already-in-use") {
      estadoEnvioCodigo.textContent = "Esta cédula ya fue registrada anteriormente. No es posible registrarse dos veces con la misma cédula. Si necesitas ayuda con tu cuenta, contacta a un coordinador.";
    } else if (error && error.code === "functions/resource-exhausted") {
      estadoEnvioCodigo.textContent = "Ya enviamos un código hace poco. Espera un momento antes de pedir otro.";
    } else {
      estadoEnvioCodigo.textContent = "No pudimos conectar con el servidor para enviar el código. Intenta de nuevo en un momento.";
    }
    estadoEnvioCodigo.className = "estado-verificacion-email aviso";
  } finally {
    boton.disabled = false;
    boton.textContent = textoOriginalBoton;
  }
}

btnEnviarCodigo.addEventListener("click", () => solicitarCodigoVerificacion(btnEnviarCodigo));
btnReenviarCodigo.addEventListener("click", () => solicitarCodigoVerificacion(btnReenviarCodigo));

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
      btnSiguiente3.disabled = false;
      if (intervaloReenvio) {
        window.clearInterval(intervaloReenvio);
        intervaloReenvio = null;
      }
      btnReenviarCodigo.classList.add("oculto");
      contadorReenvio.classList.add("oculto");
    } else {
      estadoVerificacionEmail.textContent = "El código no es correcto. Puedes intentar de nuevo o pedir uno nuevo.";
      estadoVerificacionEmail.className = "estado-verificacion-email aviso";
    }
  } catch (error) {
    console.warn("Error verificando el código:", error);
    estadoVerificacionEmail.textContent = "No pudimos verificar el código en este momento. Intenta de nuevo.";
    estadoVerificacionEmail.className = "estado-verificacion-email aviso";
  }
});

/* ---------------------- Paso 4: estado y ciudad (Venezuela) ---------------------- */

const selectEstadoProvincia = document.getElementById("estado-provincia");
const selectCiudad = document.getElementById("ciudad");
const inputDireccionTexto = document.getElementById("direccion-texto");
const contadorDireccion = document.getElementById("contador-direccion");

poblarSelectEstados(selectEstadoProvincia, "Selecciona tu estado");
poblarSelectCiudades(selectCiudad, "", "Selecciona primero tu estado");

selectEstadoProvincia.addEventListener("change", () => {
  poblarSelectCiudades(selectCiudad, selectEstadoProvincia.value, "Selecciona tu ciudad");
});

inputDireccionTexto.addEventListener("input", () => {
  contadorDireccion.textContent = String(inputDireccionTexto.value.length);
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

    <dt>Edad</dt>
    <dd>${escaparTexto(String(estado.edad != null ? estado.edad : ""))} años</dd>

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
      fechaNacimiento: estado.fechaNacimiento,
      edad: estado.edad,
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
    if (error && error.code === "auth/email-already-in-use") {
      mostrarErrorPaso("error-paso-6", "Esta cédula ya fue registrada anteriormente. No es posible registrarse dos veces con la misma cédula. Si necesitas ayuda con tu cuenta, contacta a un coordinador.");
    } else {
      mostrarErrorPaso("error-paso-6", "No pudimos completar tu registro en este momento. Verifica tu conexión a internet e intenta de nuevo.");
    }
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
