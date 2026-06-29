/* =========================================================
   Red Lienzo — Lógica del panel (dashboard.html)
   =========================================================
   Esta misma página sirve para DOS audiencias distintas, segun el
   custom claim "role" del usuario que inicio sesion:

     - voluntario (o sin claim):  ve el estado de su propia solicitud
       (pendiente / aprobado / rechazado), leido de su propio doc en
       usuarios/{uid}. Las reglas de Firestore ya permiten esta lectura
       (esPropietario(uid)).

     - admin / verificador: ve el panel de revision con la lista de
       voluntarios en estadoVerificacion "pendiente_manual" o
       "pendiente_ia", con botones para Aprobar/Rechazar. Esas acciones
       invocan el callable "revisarVoluntario" (Cloud Function), que es
       quien realmente crea la cuenta de Auth con password real, genera
       el carnet con QR y envia los correos — el cliente NUNCA hace eso
       directamente, solo dispara la Cloud Function.

   IMPORTANTE sobre custom claims: cuando a alguien se le asigna un rol
   nuevo (por ejemplo con bootstrapAdmin.js o asignarRolAdmin), ese
   cambio NO aparece en el ID token actual hasta que se refresca. Por
   eso aqui SIEMPRE forzamos getIdTokenResult(user, true) al cargar la
   pagina: asi, si Oswaldo (o cualquier admin) acaba de recibir el rol,
   ve el panel de inmediato sin tener que cerrar sesion manualmente.
   ========================================================= */

import { auth, db, storage } from "./firebase-init.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, query, where, getDocs, doc, getDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const vistaCargando = document.getElementById("vista-cargando");
const vistaVoluntario = document.getElementById("vista-voluntario");
const vistaAdmin = document.getElementById("vista-admin");

const funciones = getFunctions();
const revisarVoluntarioCallable = httpsCallable(funciones, "revisarVoluntario");

function mostrarSolo(elemento) {
  [vistaCargando, vistaVoluntario, vistaAdmin].forEach((el) => {
    el.classList.toggle("oculto", el !== elemento);
  });
}

async function cerrarSesionYRedirigir() {
  try {
    await signOut(auth);
  } finally {
    window.location.href = "index.html";
  }
}

document.getElementById("btn-cerrar-sesion-voluntario").addEventListener("click", cerrarSesionYRedirigir);
document.getElementById("btn-cerrar-sesion-admin").addEventListener("click", cerrarSesionYRedirigir);

// =============================================================
// Vista voluntario: estado de su propia solicitud
// =============================================================

const ICONOS_ESTADO = {
  pendiente: `<svg class="icono-estado" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="#c1672b" stroke-width="1.5"/>
    <path d="M12 7v5l3 3" stroke="#c1672b" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  aprobado: `<svg class="icono-estado" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="#2e6b46" stroke-width="1.5"/>
    <path d="M8 12l3 3 5-6" stroke="#2e6b46" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  rechazado: `<svg class="icono-estado" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="9" stroke="#b3261e" stroke-width="1.5"/>
    <path d="M9 9l6 6M15 9l-6 6" stroke="#b3261e" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`,
};

async function mostrarVistaVoluntario(uid) {
  mostrarSolo(vistaVoluntario);

  const contenedor = document.getElementById("tarjeta-estado-voluntario");
  try {
    const snap = await getDoc(doc(db, "usuarios", uid));
    if (!snap.exists()) {
      contenedor.innerHTML = `<p>No encontramos tu perfil. Si crees que esto es un error, contacta a un coordinador de Lienzo.</p>`;
      return;
    }
    const datos = snap.data();
    const estadoVerificacion = datos.estadoVerificacion || "pendiente_manual";

    if (estadoVerificacion === "aprobado") {
      contenedor.innerHTML = `
        ${ICONOS_ESTADO.aprobado}
        <h2 style="color:var(--exito); font-size:var(--texto-xl);">¡Tu registro fue aprobado!</h2>
        <p>Revisa tu correo personal (${escaparHtmlCliente(datos.emailPersonal || "")}): ahí te enviamos tu usuario, contraseña y tu carnet digital de voluntario(a).</p>
      `;
    } else if (estadoVerificacion === "rechazado") {
      contenedor.innerHTML = `
        ${ICONOS_ESTADO.rechazado}
        <h2 style="color:var(--error); font-size:var(--texto-xl);">No fue posible aprobar tu registro</h2>
        <p><strong>Motivo:</strong> ${escaparHtmlCliente(datos.motivoRechazo || "No se especificó un motivo.")}</p>
        <p style="font-size:14px;">Si crees que esto fue un error, contacta a un coordinador de Lienzo para que revisen tu caso.</p>
      `;
    } else {
      contenedor.innerHTML = `
        ${ICONOS_ESTADO.pendiente}
        <h2 style="color:var(--azul-profundo); font-size:var(--texto-xl);">Tu registro está en revisión</h2>
        <p>Un coordinador está verificando tus datos. Te avisaremos por correo personal en cuanto tengamos una respuesta.</p>
      `;
    }
  } catch (error) {
    console.error("Error leyendo el perfil del voluntario:", error);
    contenedor.innerHTML = `<p>Ocurrió un problema al cargar el estado de tu solicitud. Intenta recargar la página.</p>`;
  }
}

function escaparHtmlCliente(texto) {
  const div = document.createElement("div");
  div.textContent = texto == null ? "" : String(texto);
  return div.innerHTML;
}

// =============================================================
// Vista admin/verificador: panel de revisión
// =============================================================

const listaVoluntarios = document.getElementById("lista-voluntarios");
const estadoCargandoLista = document.getElementById("estado-cargando-lista");
const estadoVacioLista = document.getElementById("estado-vacio-lista");
const contadorPendientes = document.getElementById("contador-pendientes");
const mensajePanel = document.getElementById("mensaje-panel");
const plantillaTarjeta = document.getElementById("plantilla-tarjeta-voluntario");

function mostrarMensajePanel(texto, tipo) {
  mensajePanel.textContent = texto;
  mensajePanel.className = `mensaje mensaje-${tipo} visible`;
  window.setTimeout(() => {
    mensajePanel.classList.remove("visible");
  }, 6000);
}

function formatearFecha(timestamp) {
  if (!timestamp) return "—";
  try {
    const fecha = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return fecha.toLocaleString("es-VE", { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "—";
  }
}

async function obtenerUrlFoto(rutaStorage) {
  if (!rutaStorage) return null;
  try {
    return await getDownloadURL(ref(storage, rutaStorage));
  } catch (error) {
    console.warn("No se pudo cargar la foto en", rutaStorage, error);
    return null;
  }
}

function actualizarContador() {
  const cantidad = listaVoluntarios.querySelectorAll(".tarjeta-voluntario").length;
  contadorPendientes.textContent = cantidad === 1 ? "1 pendiente" : `${cantidad} pendientes`;
  estadoVacioLista.classList.toggle("oculto", cantidad !== 0);
}

async function construirTarjetaVoluntario(uid, datos) {
  const nodo = plantillaTarjeta.content.firstElementChild.cloneNode(true);
  nodo.dataset.uid = uid;

  const nombreCompleto = `${datos.nombre || ""} ${datos.apellido || ""}`.trim() || "(sin nombre)";
  nodo.querySelector(".nombre-completo").textContent = nombreCompleto;
  nodo.querySelector(".subtitulo-cedula").textContent = `Cédula: ${datos.cedula || "—"}`;
  nodo.querySelector(".dato-telefono").textContent = datos.telefono || "—";
  nodo.querySelector(".dato-telefono-emergencia").textContent = datos.telefonoEmergencia || "—";
  nodo.querySelector(".dato-correo").textContent = datos.emailPersonal || "—";
  nodo.querySelector(".dato-ubicacion").textContent = [datos.ciudad, datos.estadoProvincia].filter(Boolean).join(", ") || "—";
  nodo.querySelector(".dato-direccion").textContent = datos.direccionTexto || "—";
  nodo.querySelector(".dato-fecha").textContent = formatearFecha(datos.fechaRegistro);

  const insigniaEmail = nodo.querySelector(".dato-insignia-email");
  if (datos.emailVerificado) {
    insigniaEmail.textContent = "Correo verificado";
    insigniaEmail.className = "insignia-email-verificado dato-insignia-email ok";
  } else {
    insigniaEmail.textContent = "Correo sin verificar";
    insigniaEmail.className = "insignia-email-verificado dato-insignia-email aviso";
  }

  // Fotos: se cargan en paralelo, sin bloquear el resto de la tarjeta.
  const imgRostro = nodo.querySelector(".foto-rostro");
  const imgCedula = nodo.querySelector(".foto-cedula");
  obtenerUrlFoto(datos.fotoRostroPath).then((url) => { if (url) imgRostro.src = url; });
  obtenerUrlFoto(datos.fotoCedulaPath).then((url) => { if (url) imgCedula.src = url; });

  const btnAprobar = nodo.querySelector(".btn-aprobar");
  const btnRechazar = nodo.querySelector(".btn-rechazar");
  const btnConfirmarRechazo = nodo.querySelector(".btn-confirmar-rechazo");
  const btnCancelarRechazo = nodo.querySelector(".btn-cancelar-rechazo");
  const panelRechazo = nodo.querySelector(".panel-rechazo");
  const campoMotivo = nodo.querySelector(".campo-motivo-rechazo");
  const mensajeTarjeta = nodo.querySelector(".mensaje-tarjeta");

  function ponerCargandoTarjeta(cargando) {
    [btnAprobar, btnRechazar, btnConfirmarRechazo, btnCancelarRechazo].forEach((b) => { b.disabled = cargando; });
  }

  function mostrarErrorTarjeta(texto) {
    mensajeTarjeta.textContent = texto;
    mensajeTarjeta.style.color = "var(--error)";
    mensajeTarjeta.classList.remove("oculto");
  }

  async function enviarDecision(decision, motivoRechazo) {
    ponerCargandoTarjeta(true);
    mensajeTarjeta.classList.add("oculto");
    try {
      await revisarVoluntarioCallable({ uid, decision, motivoRechazo: motivoRechazo || null });
      nodo.remove();
      actualizarContador();
      mostrarMensajePanel(
        decision === "aprobado"
          ? `${nombreCompleto} fue aprobado(a). Se le envió un correo con sus credenciales y carnet.`
          : `${nombreCompleto} fue rechazado(a). Se le notificó el motivo por correo.`,
        decision === "aprobado" ? "exito" : "info"
      );
    } catch (error) {
      console.error("Error en revisarVoluntario:", error);
      mostrarErrorTarjeta(error.message || "Ocurrió un error al procesar esta revisión. Intenta de nuevo.");
    } finally {
      ponerCargandoTarjeta(false);
    }
  }

  btnAprobar.addEventListener("click", () => enviarDecision("aprobado", null));

  btnRechazar.addEventListener("click", () => {
    panelRechazo.classList.add("visible");
    btnAprobar.classList.add("oculto");
    btnRechazar.classList.add("oculto");
    btnConfirmarRechazo.classList.remove("oculto");
    btnCancelarRechazo.classList.remove("oculto");
    campoMotivo.focus();
  });

  btnCancelarRechazo.addEventListener("click", () => {
    panelRechazo.classList.remove("visible");
    btnAprobar.classList.remove("oculto");
    btnRechazar.classList.remove("oculto");
    btnConfirmarRechazo.classList.add("oculto");
    btnCancelarRechazo.classList.add("oculto");
    campoMotivo.value = "";
  });

  btnConfirmarRechazo.addEventListener("click", () => {
    const motivo = campoMotivo.value.trim();
    if (!motivo) {
      mostrarErrorTarjeta("Por favor escribe un motivo antes de confirmar el rechazo.");
      campoMotivo.focus();
      return;
    }
    enviarDecision("rechazado", motivo);
  });

  return nodo;
}

async function cargarListaPendientes() {
  estadoCargandoLista.classList.remove("oculto");
  estadoVacioLista.classList.add("oculto");
  listaVoluntarios.innerHTML = "";

  try {
    const consulta = query(
      collection(db, "usuarios"),
      where("estadoVerificacion", "in", ["pendiente_manual", "pendiente_ia"])
    );
    const snapshot = await getDocs(consulta);

    const tarjetas = await Promise.all(
      snapshot.docs.map((docSnap) => construirTarjetaVoluntario(docSnap.id, docSnap.data()))
    );
    tarjetas.forEach((nodo) => listaVoluntarios.appendChild(nodo));

    actualizarContador();
  } catch (error) {
    console.error("Error cargando voluntarios pendientes:", error);
    mostrarMensajePanel("No se pudo cargar la lista de voluntarios pendientes. Intenta recargar la página.", "error");
  } finally {
    estadoCargandoLista.classList.add("oculto");
  }
}

function mostrarVistaAdmin(rol) {
  mostrarSolo(vistaAdmin);
  document.getElementById("insignia-rol").textContent = rol === "admin" ? "Administrador" : "Verificador";
  cargarListaPendientes();
}

// =============================================================
// Punto de entrada: decidir qué vista mostrar según el rol
// =============================================================

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  try {
    // Forzamos refresco del ID token para que un rol recien asignado
    // (por ejemplo con bootstrapAdmin.js) se refleje sin pedirle a la
    // persona que cierre sesión manualmente.
    const resultadoToken = await user.getIdTokenResult(true);
    const rol = resultadoToken.claims.role;

    if (rol === "admin" || rol === "verificador") {
      mostrarVistaAdmin(rol);
    } else {
      await mostrarVistaVoluntario(user.uid);
    }
  } catch (error) {
    console.error("Error determinando el rol del usuario:", error);
    await mostrarVistaVoluntario(user.uid);
  }
});
