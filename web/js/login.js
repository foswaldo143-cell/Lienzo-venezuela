/* =========================================================
   ChildCare — Lógica de login (index.html)
   El usuario solo conoce su cédula. Internamente construimos
   el email sintético de Firebase Auth: CEDULA@voluntarios.lienzo.app
   ========================================================= */

import { auth, db, DOMINIO_AUTH_SINTETICO } from "./firebase-init.js";
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const formLogin = document.getElementById("form-login");
const cedulaTipo = document.getElementById("cedula-tipo");
const cedulaNumero = document.getElementById("cedula-numero");
const password = document.getElementById("password");
const mensajeError = document.getElementById("mensaje-error");
const btnLogin = document.getElementById("btn-login");
const textoBtnLogin = document.getElementById("texto-btn-login");

function mostrarError(texto) {
  mensajeError.textContent = texto;
  mensajeError.classList.add("visible");
}

function ocultarError() {
  mensajeError.classList.remove("visible");
  mensajeError.textContent = "";
}

function ponerCargando(cargando) {
  btnLogin.disabled = cargando;
  textoBtnLogin.textContent = cargando ? "Iniciando..." : "Iniciar sesión";
}

formLogin.addEventListener("submit", async (evento) => {
  evento.preventDefault();
  ocultarError();

  const numero = cedulaNumero.value.trim().replace(/\D/g, "");

  if (!numero) {
    mostrarError("Por favor escribe el número de tu cédula.");
    return;
  }
  if (!password.value) {
    mostrarError("Por favor escribe tu contraseña.");
    return;
  }

  const cedulaCompleta = cedulaTipo.value + numero;
  const emailSintetico = cedulaCompleta.toUpperCase() + DOMINIO_AUTH_SINTETICO;

  ponerCargando(true);

  try {
    const credencial = await signInWithEmailAndPassword(auth, emailSintetico, password.value);
    const uid = credencial.user.uid;

    // Buscamos el documento del usuario para decidir a dónde redirigir.
    let rol = null;
    try {
      const refUsuario = doc(db, "usuarios", uid);
      const snapUsuario = await getDoc(refUsuario);
      if (snapUsuario.exists()) {
        rol = snapUsuario.data().rol || null;
      }
    } catch (errorLectura) {
      // Si no se puede leer el documento, igual dejamos pasar al dashboard
      // genérico; el propio dashboard hará las validaciones que correspondan.
      console.warn("No se pudo leer el documento de usuario:", errorLectura);
    }

    // Por ahora solo existe una pantalla placeholder para todos los roles.
    // Cuando existan los dashboards específicos, aquí se ramificará según "rol".
    window.location.href = "dashboard.html";

  } catch (error) {
    console.error("Error de inicio de sesión:", error);
    if (error && error.code === "auth/user-disabled") {
      mostrarError("Tu cuenta fue inhabilitada por un coordinador de ChildCare. Si crees que esto es un error, contáctanos.");
    } else {
      mostrarError("No pudimos iniciar tu sesión. Revisa tu cédula y contraseña e intenta de nuevo.");
    }
  } finally {
    ponerCargando(false);
  }
});

// Solo permitir dígitos en el campo de cédula mientras se escribe.
cedulaNumero.addEventListener("input", () => {
  cedulaNumero.value = cedulaNumero.value.replace(/\D/g, "");
});

/* ---------------------- Recuperación de contraseña ---------------------- */

const btnMostrarRecuperacion = document.getElementById("btn-mostrar-recuperacion");
const panelRecuperacion = document.getElementById("panel-recuperacion");
const cedulaTipoRecuperacion = document.getElementById("cedula-tipo-recuperacion");
const cedulaNumeroRecuperacion = document.getElementById("cedula-numero-recuperacion");
const mensajeRecuperacion = document.getElementById("mensaje-recuperacion");
const btnCancelarRecuperacion = document.getElementById("btn-cancelar-recuperacion");
const btnEnviarRecuperacion = document.getElementById("btn-enviar-recuperacion");
const textoBtnRecuperacion = document.getElementById("texto-btn-recuperacion");

function mostrarMensajeRecuperacion(texto, tipo) {
  mensajeRecuperacion.textContent = texto;
  mensajeRecuperacion.className = `mensaje mensaje-${tipo} visible`;
}

btnMostrarRecuperacion.addEventListener("click", () => {
  panelRecuperacion.classList.remove("oculto");
  btnMostrarRecuperacion.classList.add("oculto");
  mensajeRecuperacion.className = "mensaje";
  mensajeRecuperacion.textContent = "";
});

btnCancelarRecuperacion.addEventListener("click", () => {
  panelRecuperacion.classList.add("oculto");
  btnMostrarRecuperacion.classList.remove("oculto");
  cedulaNumeroRecuperacion.value = "";
  mensajeRecuperacion.className = "mensaje";
  mensajeRecuperacion.textContent = "";
});

cedulaNumeroRecuperacion.addEventListener("input", () => {
  cedulaNumeroRecuperacion.value = cedulaNumeroRecuperacion.value.replace(/\D/g, "");
});

btnEnviarRecuperacion.addEventListener("click", async () => {
  const numero = cedulaNumeroRecuperacion.value.trim();
  if (!numero) {
    mostrarMensajeRecuperacion("Escribe tu número de cédula.", "error");
    return;
  }
  const cedulaCompleta = cedulaTipoRecuperacion.value + numero;

  btnEnviarRecuperacion.disabled = true;
  const textoOriginal = textoBtnRecuperacion.textContent;
  textoBtnRecuperacion.innerHTML = '<span class="cargando-spinner"></span> Enviando...';

  try {
    const functions = getFunctions();
    const solicitarRecuperacionPassword = httpsCallable(functions, "solicitarRecuperacionPassword");
    const resultado = await solicitarRecuperacionPassword({ cedula: cedulaCompleta });

    if (resultado && resultado.data && resultado.data.ok) {
      mostrarMensajeRecuperacion(
        resultado.data.mensaje || "Listo, te enviamos una nueva contraseña a tu correo registrado.",
        "exito"
      );
    } else {
      mostrarMensajeRecuperacion(
        (resultado && resultado.data && resultado.data.mensaje) || "No pudimos procesar tu solicitud.",
        "error"
      );
    }
  } catch (error) {
    console.error("Error en solicitarRecuperacionPassword:", error);
    mostrarMensajeRecuperacion("No pudimos conectar con el servidor. Intenta de nuevo en un momento.", "error");
  } finally {
    btnEnviarRecuperacion.disabled = false;
    textoBtnRecuperacion.textContent = textoOriginal;
  }
});
