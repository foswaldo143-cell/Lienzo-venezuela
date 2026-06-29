/* =========================================================
   Red Lienzo — Lógica del panel (dashboard.html)
   =========================================================
   Esta misma página sirve para TRES audiencias distintas, segun el
   custom claim "role" del usuario que inicio sesion:

     - voluntario (o sin claim):  ve el estado de su propia solicitud
       (pendiente / aprobado / rechazado), leido de su propio doc en
       usuarios/{uid}.

     - verificador: ve el panel de revision con la cola de pendientes
       (Aprobar/Denegar mediante el modal de revision), pero NO ve el
       menu lateral ni la tabla de "todos los usuarios" (eso es solo
       para el usuario master/admin).

     - admin (usuario master): ve TODO lo del verificador, ademas del
       menu lateral con la seccion "Todos los usuarios registrados"
       (tabla filtrable/ordenable con un modal de gestion por usuario:
       bloquear/inhabilitar, cambiar rol, contactar por WhatsApp,
       reenviar contraseña).

   Ademas, las TRES audiencias ven la barra de "Perfil" flotante
   (arriba a la derecha), que abre un modal para: cambiar foto de
   perfil, ver nombre/cédula (solo lectura), editar su zona
   (estado/ciudad), cambiar su contraseña y regenerar su carnet.

   IMPORTANTE sobre custom claims: cuando a alguien se le asigna un rol
   nuevo, ese cambio NO aparece en el ID token actual hasta que se
   refresca. Por eso aqui SIEMPRE forzamos getIdTokenResult(user, true)
   al cargar la pagina.
   ========================================================= */

import { auth, db, storage } from "./firebase-init.js";
import {
  onAuthStateChanged, signOut, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection, getDocs, doc, getDoc, updateDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { ref, getDownloadURL, uploadBytes } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";
import { poblarSelectEstados, poblarSelectCiudades } from "./venezuela-datos.js";

const vistaCargando = document.getElementById("vista-cargando");
const vistaVoluntario = document.getElementById("vista-voluntario");
const vistaAdmin = document.getElementById("vista-admin");

const funciones = getFunctions();
const revisarVoluntarioCallable = httpsCallable(funciones, "revisarVoluntario");
const cambiarEstadoCuentaCallable = httpsCallable(funciones, "cambiarEstadoCuenta");
const reenviarPasswordCallable = httpsCallable(funciones, "reenviarPassword");
const asignarRolVerificadorCallable = httpsCallable(funciones, "asignarRolVerificador");
const asignarRolVoluntarioCallable = httpsCallable(funciones, "asignarRolVoluntario");
const regenerarCarnetCallable = httpsCallable(funciones, "regenerarCarnet");

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

function escaparHtmlCliente(texto) {
  const div = document.createElement("div");
  div.textContent = texto == null ? "" : String(texto);
  return div.innerHTML;
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

/* =============================================================
   Modal genérico (overlay-modal / modal-contenido)
   ============================================================= */

const overlayModal = document.getElementById("overlay-modal");
const modalContenido = document.getElementById("modal-contenido");
const btnCerrarModal = document.getElementById("btn-cerrar-modal");

function abrirModal(html) {
  modalContenido.innerHTML = html;
  overlayModal.classList.remove("oculto");
  document.body.style.overflow = "hidden";
}

function cerrarModal() {
  overlayModal.classList.add("oculto");
  modalContenido.innerHTML = "";
  document.body.style.overflow = "";
}

btnCerrarModal.addEventListener("click", cerrarModal);
overlayModal.addEventListener("click", (evento) => {
  if (evento.target === overlayModal) cerrarModal();
});

/* =============================================================
   Barra de perfil flotante + Modal de Perfil (TODAS las vistas)
   ============================================================= */

const barraPerfil = document.getElementById("barra-perfil");
const btnAbrirPerfil = document.getElementById("btn-abrir-perfil");
const avatarPerfilImg = document.getElementById("avatar-perfil-img");
const avatarPerfilInicial = document.getElementById("avatar-perfil-inicial");

/** Cache en memoria de los datos propios, para no releerlos del servidor
 * cada vez que se abre el modal de perfil. Se refresca tras cada cambio. */
let miUid = null;
let misDatos = null;

async function inicializarBarraPerfil(uid, datos) {
  miUid = uid;
  misDatos = datos;

  const nombreCompleto = `${(datos && datos.nombre) || ""} ${(datos && datos.apellido) || ""}`.trim();
  avatarPerfilInicial.textContent = (nombreCompleto.trim()[0] || (auth.currentUser && auth.currentUser.email[0]) || "?").toUpperCase();
  avatarPerfilImg.classList.add("oculto");
  avatarPerfilInicial.classList.remove("oculto");

  const rutaFoto = datos && (datos.fotoPerfilPath || datos.fotoRostroPath);
  if (rutaFoto) {
    const url = await obtenerUrlFoto(rutaFoto);
    if (url) {
      avatarPerfilImg.src = url;
      avatarPerfilImg.classList.remove("oculto");
      avatarPerfilInicial.classList.add("oculto");
    }
  }

  barraPerfil.classList.remove("oculto");
  btnAbrirPerfil.onclick = () => abrirModalPerfil();
}

function plantillaModalPerfil() {
  const datos = misDatos || {};
  const nombreCompleto = `${datos.nombre || ""} ${datos.apellido || ""}`.trim() || "(sin nombre registrado)";
  const cedula = datos.cedula || "—";
  const estadoActual = datos.estadoProvincia || "";
  const tieneDatosPerfil = !!(datos.nombre || datos.cedula);

  return `
    <h2 style="margin-top:0;">Mi perfil</h2>

    <div style="display:flex; align-items:center; gap:var(--espacio-md); margin-bottom:var(--espacio-md);">
      <div class="avatar-modal-perfil" id="contenedor-avatar-modal-perfil">
        <img id="avatar-modal-perfil-img" class="oculto" alt="Tu foto de perfil">
        <span id="avatar-modal-perfil-inicial">${escaparHtmlCliente((nombreCompleto[0] || "?").toUpperCase())}</span>
      </div>
      <div>
        <label class="boton boton-secundario boton-cambiar-foto" for="input-foto-perfil" style="cursor:pointer;">Cambiar foto</label>
        <input type="file" id="input-foto-perfil" accept="image/*" class="oculto">
        <p class="ayuda-campo" id="mensaje-foto-perfil"></p>
      </div>
    </div>

    ${tieneDatosPerfil ? `
      <div class="campo">
        <label>Nombre completo</label>
        <input type="text" value="${escaparHtmlCliente(nombreCompleto)}" disabled>
      </div>
      <div class="campo">
        <label>Cédula</label>
        <input type="text" value="${escaparHtmlCliente(cedula)}" disabled>
      </div>

      <div class="campo">
        <label for="select-estado-perfil">Estado</label>
        <select id="select-estado-perfil"></select>
      </div>
      <div class="campo">
        <label for="select-ciudad-perfil">Ciudad</label>
        <select id="select-ciudad-perfil"></select>
      </div>
      <div class="grupo-botones">
        <button type="button" class="boton boton-secundario" id="btn-guardar-zona">Guardar zona</button>
      </div>
      <p class="ayuda-campo" id="mensaje-zona-perfil"></p>
    ` : `
      <p class="ayuda-campo">Tu cuenta no tiene un perfil de voluntario asociado (cuenta administrativa).</p>
    `}

    <hr style="border:none; border-top:1px solid var(--borde); margin:var(--espacio-md) 0;">

    <button type="button" class="boton boton-texto" id="btn-mostrar-cambiar-password">Cambiar contraseña</button>
    <div class="oculto" id="panel-cambiar-password" style="margin-top:var(--espacio-sm);">
      <div class="campo">
        <label for="password-actual-perfil">Contraseña actual</label>
        <input type="password" id="password-actual-perfil" autocomplete="current-password">
      </div>
      <div class="campo">
        <label for="password-nueva-perfil">Nueva contraseña</label>
        <input type="password" id="password-nueva-perfil" autocomplete="new-password">
      </div>
      <div class="campo">
        <label for="password-nueva-confirmar-perfil">Confirmar nueva contraseña</label>
        <input type="password" id="password-nueva-confirmar-perfil" autocomplete="new-password">
      </div>
      <div class="grupo-botones">
        <button type="button" class="boton boton-primario" id="btn-guardar-password">Guardar nueva contraseña</button>
      </div>
      <p class="ayuda-campo" id="mensaje-password-perfil"></p>
    </div>

    <hr style="border:none; border-top:1px solid var(--borde); margin:var(--espacio-md) 0;">

    <button type="button" class="boton boton-secundario" id="btn-regenerar-carnet">Regenerar mi carnet (con foto actualizada)</button>
    <p class="ayuda-campo" id="mensaje-carnet-perfil"></p>
  `;
}

function abrirModalPerfil() {
  abrirModal(plantillaModalPerfil());

  const datos = misDatos || {};

  // ---- Foto de perfil --------------------------------------------------
  const imgModal = document.getElementById("avatar-modal-perfil-img");
  const rutaFotoActual = datos.fotoPerfilPath || datos.fotoRostroPath;
  if (rutaFotoActual) {
    obtenerUrlFoto(rutaFotoActual).then((url) => {
      if (url) {
        imgModal.src = url;
        imgModal.classList.remove("oculto");
        document.getElementById("avatar-modal-perfil-inicial").classList.add("oculto");
      }
    });
  }

  document.getElementById("input-foto-perfil").addEventListener("change", async (evento) => {
    const archivo = evento.target.files && evento.target.files[0];
    const mensaje = document.getElementById("mensaje-foto-perfil");
    if (!archivo) return;
    if (!archivo.type.startsWith("image/")) {
      mensaje.textContent = "Selecciona un archivo de imagen válido.";
      mensaje.style.color = "var(--error)";
      return;
    }
    if (archivo.size > 10 * 1024 * 1024) {
      mensaje.textContent = "La imagen no debe superar 10 MB.";
      mensaje.style.color = "var(--error)";
      return;
    }
    mensaje.textContent = "Subiendo foto...";
    mensaje.style.color = "var(--texto-secundario)";
    try {
      const rutaPerfil = `voluntarios/${miUid}/perfil.jpg`;
      await uploadBytes(ref(storage, rutaPerfil), archivo);
      await updateDoc(doc(db, "usuarios", miUid), { fotoPerfilPath: rutaPerfil });
      misDatos.fotoPerfilPath = rutaPerfil;
      const url = await getDownloadURL(ref(storage, rutaPerfil));
      imgModal.src = url;
      imgModal.classList.remove("oculto");
      document.getElementById("avatar-modal-perfil-inicial").classList.add("oculto");
      avatarPerfilImg.src = url;
      avatarPerfilImg.classList.remove("oculto");
      avatarPerfilInicial.classList.add("oculto");
      mensaje.textContent = "Foto actualizada. Recuerda regenerar tu carnet para que la nueva foto aparezca en él.";
      mensaje.style.color = "var(--exito)";
    } catch (error) {
      console.error("Error subiendo foto de perfil:", error);
      mensaje.textContent = "No se pudo subir la foto. Intenta de nuevo.";
      mensaje.style.color = "var(--error)";
    }
  });

  // ---- Zona (estado/ciudad) --------------------------------------------
  const selectEstado = document.getElementById("select-estado-perfil");
  const selectCiudad = document.getElementById("select-ciudad-perfil");
  if (selectEstado && selectCiudad) {
    poblarSelectEstados(selectEstado, "Selecciona tu estado");
    selectEstado.value = datos.estadoProvincia || "";
    poblarSelectCiudades(selectCiudad, datos.estadoProvincia || "", "Selecciona tu ciudad");
    selectCiudad.value = datos.ciudad || "";

    selectEstado.addEventListener("change", () => {
      poblarSelectCiudades(selectCiudad, selectEstado.value, "Selecciona tu ciudad");
    });

    document.getElementById("btn-guardar-zona").addEventListener("click", async () => {
      const mensaje = document.getElementById("mensaje-zona-perfil");
      const nuevoEstado = selectEstado.value;
      const nuevaCiudad = selectCiudad.value;
      if (!nuevoEstado || !nuevaCiudad) {
        mensaje.textContent = "Selecciona estado y ciudad.";
        mensaje.style.color = "var(--error)";
        return;
      }
      mensaje.textContent = "Guardando...";
      mensaje.style.color = "var(--texto-secundario)";
      try {
        await updateDoc(doc(db, "usuarios", miUid), { estadoProvincia: nuevoEstado, ciudad: nuevaCiudad });
        misDatos.estadoProvincia = nuevoEstado;
        misDatos.ciudad = nuevaCiudad;
        mensaje.textContent = "Zona actualizada correctamente.";
        mensaje.style.color = "var(--exito)";
      } catch (error) {
        console.error("Error guardando zona:", error);
        mensaje.textContent = "No se pudo guardar tu zona. Intenta de nuevo.";
        mensaje.style.color = "var(--error)";
      }
    });
  }

  // ---- Cambiar contraseña -----------------------------------------------
  document.getElementById("btn-mostrar-cambiar-password").addEventListener("click", () => {
    document.getElementById("panel-cambiar-password").classList.toggle("oculto");
  });

  document.getElementById("btn-guardar-password").addEventListener("click", async () => {
    const mensaje = document.getElementById("mensaje-password-perfil");
    const actual = document.getElementById("password-actual-perfil").value;
    const nueva = document.getElementById("password-nueva-perfil").value;
    const confirmar = document.getElementById("password-nueva-confirmar-perfil").value;

    if (!actual || !nueva || !confirmar) {
      mensaje.textContent = "Completa los tres campos.";
      mensaje.style.color = "var(--error)";
      return;
    }
    if (nueva.length < 8) {
      mensaje.textContent = "La nueva contraseña debe tener al menos 8 caracteres.";
      mensaje.style.color = "var(--error)";
      return;
    }
    if (nueva !== confirmar) {
      mensaje.textContent = "La confirmación no coincide con la nueva contraseña.";
      mensaje.style.color = "var(--error)";
      return;
    }

    mensaje.textContent = "Guardando...";
    mensaje.style.color = "var(--texto-secundario)";
    try {
      const credencial = EmailAuthProvider.credential(auth.currentUser.email, actual);
      await reauthenticateWithCredential(auth.currentUser, credencial);
      await updatePassword(auth.currentUser, nueva);
      mensaje.textContent = "Contraseña actualizada correctamente.";
      mensaje.style.color = "var(--exito)";
      document.getElementById("password-actual-perfil").value = "";
      document.getElementById("password-nueva-perfil").value = "";
      document.getElementById("password-nueva-confirmar-perfil").value = "";
    } catch (error) {
      console.error("Error cambiando contraseña:", error);
      if (error.code === "auth/wrong-password" || error.code === "auth/invalid-credential") {
        mensaje.textContent = "Tu contraseña actual no es correcta.";
      } else {
        mensaje.textContent = "No se pudo cambiar la contraseña. Intenta de nuevo.";
      }
      mensaje.style.color = "var(--error)";
    }
  });

  // ---- Regenerar carnet ---------------------------------------------------
  document.getElementById("btn-regenerar-carnet").addEventListener("click", async (evento) => {
    const boton = evento.currentTarget;
    const mensaje = document.getElementById("mensaje-carnet-perfil");
    boton.disabled = true;
    mensaje.textContent = "Generando y enviando tu carnet...";
    mensaje.style.color = "var(--texto-secundario)";
    try {
      await regenerarCarnetCallable();
      mensaje.textContent = "Listo. Revisa tu correo personal: te enviamos tu carnet actualizado.";
      mensaje.style.color = "var(--exito)";
    } catch (error) {
      console.error("Error regenerando carnet:", error);
      mensaje.textContent = error.message || "No se pudo generar tu carnet. ¿Ya fue aprobado tu registro?";
      mensaje.style.color = "var(--error)";
    } finally {
      boton.disabled = false;
    }
  });
}

/* =============================================================
   Vista voluntario: estado de su propia solicitud
   ============================================================= */

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

async function mostrarVistaVoluntario(uid, datos) {
  mostrarSolo(vistaVoluntario);
  await inicializarBarraPerfil(uid, datos);

  const contenedor = document.getElementById("tarjeta-estado-voluntario");
  if (!datos) {
    contenedor.innerHTML = `<p>No encontramos tu perfil. Si crees que esto es un error, contacta a un coordinador de Lienzo.</p>`;
    return;
  }

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
}

/* =============================================================
   Vista admin/verificador: cola de revisión (pendientes)
   ============================================================= */

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

function actualizarContador() {
  const cantidad = listaVoluntarios.querySelectorAll(".tarjeta-voluntario-resumen").length;
  contadorPendientes.textContent = cantidad === 1 ? "1 pendiente" : `${cantidad} pendientes`;
  estadoVacioLista.classList.toggle("oculto", cantidad !== 0);
}

function construirTarjetaVoluntario(uid, datos) {
  const nodo = plantillaTarjeta.content.firstElementChild.cloneNode(true);
  nodo.dataset.uid = uid;

  const nombreCompleto = `${datos.nombre || ""} ${datos.apellido || ""}`.trim() || "(sin nombre)";
  nodo.querySelector(".nombre-completo").textContent = nombreCompleto;
  nodo.querySelector(".subtitulo-cedula").textContent = `Cédula: ${datos.cedula || "—"}`;

  const insigniaEmail = nodo.querySelector(".dato-insignia-email");
  if (datos.emailVerificado) {
    insigniaEmail.textContent = "Correo verificado";
    insigniaEmail.classList.add("ok");
  } else {
    insigniaEmail.textContent = "Correo sin verificar";
    insigniaEmail.classList.add("aviso");
  }

  const imgRostro = nodo.querySelector(".foto-rostro-mini");
  obtenerUrlFoto(datos.fotoRostroPath).then((url) => { if (url) imgRostro.src = url; });

  nodo.querySelector(".btn-ver-revision").addEventListener("click", () => abrirModalRevision(uid, datos, nodo, nombreCompleto));

  return nodo;
}

async function cargarListaPendientes() {
  estadoCargandoLista.classList.remove("oculto");
  estadoVacioLista.classList.add("oculto");
  listaVoluntarios.innerHTML = "";

  try {
    const snapshot = await getDocs(collection(db, "usuarios"));
    const pendientes = snapshot.docs.filter((docSnap) => {
      const estado = docSnap.data().estadoVerificacion;
      return estado === "pendiente_manual" || estado === "pendiente_ia";
    });

    pendientes.forEach((docSnap) => {
      listaVoluntarios.appendChild(construirTarjetaVoluntario(docSnap.id, docSnap.data()));
    });

    actualizarContador();
  } catch (error) {
    console.error("Error cargando voluntarios pendientes:", error);
    mostrarMensajePanel("No se pudo cargar la lista de voluntarios pendientes. Intenta recargar la página.", "error");
  } finally {
    estadoCargandoLista.classList.add("oculto");
  }
}

/* =============================================================
   Modal de revisión ("Ver"): imágenes grandes + Aprobar/Denegar
   con motivos estructurados.
   ============================================================= */

const MOTIVOS_RECHAZO = [
  { valor: "datos_no_coinciden", etiqueta: "Los datos suministrados no coinciden" },
  { valor: "no_elegible", etiqueta: "Voluntario no elegible" },
  { valor: "otro", etiqueta: "Otro motivo (especificar)" },
];

function plantillaModalRevision(uid, datos, nombreCompleto) {
  return `
    <h2 style="margin-top:0;">Revisión de voluntario</h2>

    <div class="galeria-revision">
      <figure>
        <figcaption>Foto de rostro</figcaption>
        <img id="modal-foto-rostro" class="foto-revision-grande" alt="Foto de rostro de ${escaparHtmlCliente(nombreCompleto)}">
      </figure>
      <figure>
        <figcaption>Foto de cédula</figcaption>
        <img id="modal-foto-cedula" class="foto-revision-grande" alt="Foto de cédula de ${escaparHtmlCliente(nombreCompleto)}">
      </figure>
    </div>

    <dl class="resumen-bloque">
      <div><dt>Nombre completo</dt><dd>${escaparHtmlCliente(nombreCompleto)}</dd></div>
      <div><dt>Cédula</dt><dd>${escaparHtmlCliente(datos.cedula || "—")}</dd></div>
      <div><dt>Edad</dt><dd>${datos.edad != null ? escaparHtmlCliente(datos.edad) + " años" : "—"}</dd></div>
      <div><dt>Teléfono</dt><dd>${escaparHtmlCliente(datos.telefono || "—")}</dd></div>
      <div><dt>Contacto de emergencia</dt><dd>${escaparHtmlCliente(datos.telefonoEmergencia || "—")}</dd></div>
      <div><dt>Correo personal</dt><dd>${escaparHtmlCliente(datos.emailPersonal || "—")} ${datos.emailVerificado ? "(verificado)" : "(sin verificar)"}</dd></div>
      <div><dt>Ubicación</dt><dd>${escaparHtmlCliente([datos.direccionTexto, datos.ciudad, datos.estadoProvincia].filter(Boolean).join(", ") || "—")}</dd></div>
      <div><dt>Fecha de registro</dt><dd>${formatearFecha(datos.fechaRegistro)}</dd></div>
    </dl>

    <div id="mensaje-modal-revision" class="mensaje"></div>

    <div class="grupo-botones" id="botones-decision-revision">
      <button type="button" class="boton boton-secundario" id="btn-denegar-revision">Denegar</button>
      <button type="button" class="boton boton-primario" id="btn-aprobar-revision">Aprobar</button>
    </div>

    <div class="oculto" id="panel-motivos-rechazo" style="margin-top:var(--espacio-md);">
      <p class="ayuda-campo">Selecciona el motivo de la denegación:</p>
      ${MOTIVOS_RECHAZO.map((m, i) => `
        <label style="display:block; margin-bottom:var(--espacio-xs);">
          <input type="radio" name="motivo-rechazo" value="${m.valor}" ${i === 0 ? "checked" : ""}> ${escaparHtmlCliente(m.etiqueta)}
        </label>
      `).join("")}
      <textarea id="texto-motivo-otro" class="oculto" placeholder="Describe el motivo..." style="width:100%; margin-top:var(--espacio-sm);" rows="3"></textarea>
      <div class="grupo-botones" style="margin-top:var(--espacio-sm);">
        <button type="button" class="boton boton-secundario" id="btn-cancelar-motivo">Cancelar</button>
        <button type="button" class="boton boton-acento" id="btn-confirmar-denegar">Confirmar denegación</button>
      </div>
    </div>
  `;
}

function abrirModalRevision(uid, datos, nodoTarjeta, nombreCompleto) {
  abrirModal(plantillaModalRevision(uid, datos, nombreCompleto));

  obtenerUrlFoto(datos.fotoRostroPath).then((url) => { if (url) document.getElementById("modal-foto-rostro").src = url; });
  obtenerUrlFoto(datos.fotoCedulaPath).then((url) => { if (url) document.getElementById("modal-foto-cedula").src = url; });

  const mensajeModal = document.getElementById("mensaje-modal-revision");
  const botonesDecision = document.getElementById("botones-decision-revision");
  const panelMotivos = document.getElementById("panel-motivos-rechazo");
  const btnAprobar = document.getElementById("btn-aprobar-revision");
  const btnDenegar = document.getElementById("btn-denegar-revision");
  const btnCancelarMotivo = document.getElementById("btn-cancelar-motivo");
  const btnConfirmarDenegar = document.getElementById("btn-confirmar-denegar");
  const textoMotivoOtro = document.getElementById("texto-motivo-otro");

  function mostrarErrorModal(texto) {
    mensajeModal.textContent = texto;
    mensajeModal.className = "mensaje mensaje-error visible";
  }

  function ponerCargando(cargando) {
    [btnAprobar, btnDenegar, btnConfirmarDenegar, btnCancelarMotivo].forEach((b) => { if (b) b.disabled = cargando; });
  }

  async function enviarDecision(decision, motivoTipo, motivoTexto) {
    ponerCargando(true);
    mensajeModal.classList.remove("visible");
    try {
      const resultado = await revisarVoluntarioCallable({ uid, decision, motivoTipo, motivoTexto });
      nodoTarjeta.remove();
      actualizarContador();
      cerrarModal();
      mostrarMensajePanel(
        (resultado.data && resultado.data.mensaje) ||
          (decision === "aprobado" ? `${nombreCompleto} fue aprobado(a).` : `${nombreCompleto} fue denegado(a).`),
        decision === "aprobado" ? "exito" : "info"
      );
    } catch (error) {
      console.error("Error en revisarVoluntario:", error);
      mostrarErrorModal(error.message || "Ocurrió un error al procesar esta revisión. Intenta de nuevo.");
    } finally {
      ponerCargando(false);
    }
  }

  btnAprobar.addEventListener("click", () => enviarDecision("aprobado", null, null));

  btnDenegar.addEventListener("click", () => {
    botonesDecision.classList.add("oculto");
    panelMotivos.classList.remove("oculto");
  });

  btnCancelarMotivo.addEventListener("click", () => {
    panelMotivos.classList.add("oculto");
    botonesDecision.classList.remove("oculto");
  });

  panelMotivos.querySelectorAll('input[name="motivo-rechazo"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      textoMotivoOtro.classList.toggle("oculto", radio.value !== "otro" || !radio.checked);
    });
  });

  btnConfirmarDenegar.addEventListener("click", () => {
    const seleccionado = panelMotivos.querySelector('input[name="motivo-rechazo"]:checked');
    const motivoTipo = seleccionado ? seleccionado.value : "otro";
    let motivoTexto = null;
    if (motivoTipo === "otro") {
      motivoTexto = textoMotivoOtro.value.trim();
      if (!motivoTexto) {
        mostrarErrorModal("Escribe el motivo antes de confirmar.");
        textoMotivoOtro.focus();
        return;
      }
    }
    enviarDecision("rechazado", motivoTipo, motivoTexto);
  });
}

/* =============================================================
   Menú lateral (solo admin) + Tabla "todos los usuarios"
   ============================================================= */

const panelNav = document.getElementById("panel-nav");
const seccionPendientes = document.getElementById("seccion-pendientes");
const seccionTodos = document.getElementById("seccion-todos");
const buscarUsuarioInput = document.getElementById("buscar-usuario");
const filtroAprobacionSelect = document.getElementById("filtro-aprobacion");
const cuerpoTablaUsuarios = document.getElementById("cuerpo-tabla-usuarios");
const tablaUsuariosVacia = document.getElementById("tabla-usuarios-vacia");

let todosLosUsuariosCache = null; // null = aún no cargado
let ordenActual = { campo: "nombreCompleto", asc: true };

function configurarNavegacionPanel(esAdmin) {
  if (!esAdmin) {
    panelNav.classList.add("oculto");
    return;
  }
  panelNav.classList.remove("oculto");

  panelNav.querySelectorAll(".panel-nav-item").forEach((boton) => {
    boton.addEventListener("click", () => {
      panelNav.querySelectorAll(".panel-nav-item").forEach((b) => b.classList.remove("activo"));
      boton.classList.add("activo");

      const seccion = boton.dataset.seccion;
      seccionPendientes.classList.toggle("oculto", seccion !== "pendientes");
      seccionTodos.classList.toggle("oculto", seccion !== "todos");

      if (seccion === "todos" && todosLosUsuariosCache === null) {
        cargarTablaTodosUsuarios();
      }
    });
  });
}

async function cargarTablaTodosUsuarios() {
  cuerpoTablaUsuarios.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:var(--espacio-md);">Cargando usuarios...</td></tr>`;
  try {
    const snapshot = await getDocs(collection(db, "usuarios"));
    todosLosUsuariosCache = snapshot.docs.map((docSnap) => {
      const datos = docSnap.data();
      return {
        uid: docSnap.id,
        ...datos,
        nombreCompleto: `${datos.nombre || ""} ${datos.apellido || ""}`.trim() || "(sin nombre)",
      };
    });
    renderTablaUsuarios();
  } catch (error) {
    console.error("Error cargando la lista de todos los usuarios:", error);
    cuerpoTablaUsuarios.innerHTML = "";
    tablaUsuariosVacia.textContent = "No se pudo cargar la lista de usuarios. Intenta recargar la página.";
    tablaUsuariosVacia.classList.remove("oculto");
  }
}

function renderTablaUsuarios() {
  if (!todosLosUsuariosCache) return;

  const textoBusqueda = (buscarUsuarioInput.value || "").trim().toLowerCase();
  const filtroAprobacion = filtroAprobacionSelect.value;

  let filtrados = todosLosUsuariosCache.filter((u) => {
    if (textoBusqueda) {
      const haystack = `${u.nombreCompleto} ${u.cedula || ""}`.toLowerCase();
      if (!haystack.includes(textoBusqueda)) return false;
    }
    if (filtroAprobacion === "aprobado" && u.estadoVerificacion !== "aprobado") return false;
    if (filtroAprobacion === "no_aprobado" && u.estadoVerificacion === "aprobado") return false;
    return true;
  });

  filtrados.sort((a, b) => {
    const campo = ordenActual.campo;
    let va = a[campo];
    let vb = b[campo];
    if (campo === "edad") {
      va = typeof va === "number" ? va : -1;
      vb = typeof vb === "number" ? vb : -1;
    } else {
      va = (va || "").toString().toLowerCase();
      vb = (vb || "").toString().toLowerCase();
    }
    if (va < vb) return ordenActual.asc ? -1 : 1;
    if (va > vb) return ordenActual.asc ? 1 : -1;
    return 0;
  });

  cuerpoTablaUsuarios.innerHTML = "";
  tablaUsuariosVacia.classList.toggle("oculto", filtrados.length !== 0);

  filtrados.forEach((u) => {
    const fila = document.createElement("tr");
    fila.className = "fila-usuario-tabla";
    fila.dataset.uid = u.uid;

    const celdaFoto = document.createElement("td");
    const img = document.createElement("img");
    img.className = "foto-fila-mini";
    img.alt = "";
    celdaFoto.appendChild(img);
    obtenerUrlFoto(u.fotoPerfilPath || u.fotoRostroPath).then((url) => { if (url) img.src = url; });

    const celdaNombre = document.createElement("td");
    celdaNombre.textContent = u.nombreCompleto;

    const celdaCiudad = document.createElement("td");
    celdaCiudad.textContent = u.ciudad || "—";

    const celdaEstado = document.createElement("td");
    celdaEstado.textContent = u.estadoProvincia || "—";

    const celdaEdad = document.createElement("td");
    celdaEdad.textContent = u.edad != null ? u.edad : "—";

    const celdaAprobacion = document.createElement("td");
    const insignia = document.createElement("span");
    if (u.estadoVerificacion === "aprobado") {
      insignia.textContent = u.deshabilitado ? "Aprobado (inhabilitado)" : "Aprobado";
      insignia.className = `insignia-aprobacion ${u.deshabilitado ? "aviso" : "ok"}`;
    } else if (u.estadoVerificacion === "rechazado") {
      insignia.textContent = "Rechazado";
      insignia.className = "insignia-aprobacion error";
    } else {
      insignia.textContent = "Pendiente";
      insignia.className = "insignia-aprobacion pendiente";
    }
    celdaAprobacion.appendChild(insignia);

    fila.append(celdaFoto, celdaNombre, celdaCiudad, celdaEstado, celdaEdad, celdaAprobacion);
    fila.addEventListener("click", () => abrirModalUsuario(u.uid));
    cuerpoTablaUsuarios.appendChild(fila);
  });
}

document.querySelectorAll(".th-ordenable").forEach((th) => {
  th.addEventListener("click", () => {
    const campo = th.dataset.orden;
    if (ordenActual.campo === campo) {
      ordenActual.asc = !ordenActual.asc;
    } else {
      ordenActual = { campo, asc: true };
    }
    document.querySelectorAll(".th-ordenable").forEach((t) => t.classList.remove("orden-asc", "orden-desc"));
    th.classList.add(ordenActual.asc ? "orden-asc" : "orden-desc");
    renderTablaUsuarios();
  });
});

buscarUsuarioInput.addEventListener("input", renderTablaUsuarios);
filtroAprobacionSelect.addEventListener("change", renderTablaUsuarios);

/* =============================================================
   Modal de gestión de usuario (desde la tabla "todos los usuarios")
   ============================================================= */

function plantillaModalUsuario(u) {
  return `
    <h2 style="margin-top:0;">${escaparHtmlCliente(u.nombreCompleto)}</h2>
    <dl class="resumen-bloque">
      <div><dt>Cédula</dt><dd>${escaparHtmlCliente(u.cedula || "—")}</dd></div>
      <div><dt>Edad</dt><dd>${u.edad != null ? escaparHtmlCliente(u.edad) + " años" : "—"}</dd></div>
      <div><dt>Ubicación</dt><dd>${escaparHtmlCliente([u.ciudad, u.estadoProvincia].filter(Boolean).join(", ") || "—")}</dd></div>
      <div><dt>Rol actual</dt><dd id="dato-rol-usuario">${escaparHtmlCliente(u.rol || "voluntario")}</dd></div>
      <div><dt>Estado</dt><dd id="dato-estado-usuario">${escaparHtmlCliente(u.estadoVerificacion || "pendiente_manual")}${u.deshabilitado ? " (cuenta inhabilitada)" : ""}</dd></div>
    </dl>

    <div id="mensaje-modal-usuario" class="mensaje"></div>

    <div class="grupo-botones-modal-usuario">
      <button type="button" class="boton boton-secundario" id="btn-toggle-bloqueo">${u.deshabilitado ? "Habilitar cuenta" : "Bloquear / inhabilitar"}</button>
      ${u.rol === "verificador"
        ? `<button type="button" class="boton boton-secundario" id="btn-toggle-rol">Quitar rol de verificador</button>`
        : u.rol === "admin"
          ? ""
          : `<button type="button" class="boton boton-secundario" id="btn-toggle-rol">Hacer verificador</button>`}
      <button type="button" class="boton boton-secundario" id="btn-contactar-usuario">Contactar (WhatsApp)</button>
      <button type="button" class="boton boton-secundario" id="btn-reenviar-password-usuario">Reenviar contraseña</button>
    </div>
  `;
}

function abrirModalUsuario(uid) {
  const u = todosLosUsuariosCache.find((x) => x.uid === uid);
  if (!u) return;

  abrirModal(plantillaModalUsuario(u));
  const mensajeModal = document.getElementById("mensaje-modal-usuario");

  function mostrarMensajeModal(texto, tipo) {
    mensajeModal.textContent = texto;
    mensajeModal.className = `mensaje mensaje-${tipo} visible`;
  }

  function reabrirConDatosActualizados() {
    abrirModalUsuario(uid);
  }

  const btnToggleBloqueo = document.getElementById("btn-toggle-bloqueo");
  if (btnToggleBloqueo) {
    btnToggleBloqueo.addEventListener("click", async () => {
      btnToggleBloqueo.disabled = true;
      try {
        const nuevoEstado = !u.deshabilitado;
        await cambiarEstadoCuentaCallable({ uid, deshabilitado: nuevoEstado });
        u.deshabilitado = nuevoEstado;
        mostrarMensajeModal(nuevoEstado ? "Cuenta inhabilitada." : "Cuenta habilitada de nuevo.", "exito");
        renderTablaUsuarios();
        reabrirConDatosActualizados();
      } catch (error) {
        console.error("Error cambiando estado de cuenta:", error);
        mostrarMensajeModal(error.message || "No se pudo cambiar el estado de la cuenta.", "error");
        btnToggleBloqueo.disabled = false;
      }
    });
  }

  const btnToggleRol = document.getElementById("btn-toggle-rol");
  if (btnToggleRol) {
    btnToggleRol.addEventListener("click", async () => {
      btnToggleRol.disabled = true;
      try {
        if (u.rol === "verificador") {
          await asignarRolVoluntarioCallable({ uid });
          u.rol = "voluntario";
          mostrarMensajeModal("Ahora es voluntario (se le quitó el rol de verificador).", "exito");
        } else {
          await asignarRolVerificadorCallable({ uid });
          u.rol = "verificador";
          mostrarMensajeModal("Ahora es verificador.", "exito");
        }
        renderTablaUsuarios();
        reabrirConDatosActualizados();
      } catch (error) {
        console.error("Error cambiando rol:", error);
        mostrarMensajeModal(error.message || "No se pudo cambiar el rol.", "error");
        btnToggleRol.disabled = false;
      }
    });
  }

  document.getElementById("btn-contactar-usuario").addEventListener("click", () => {
    const telefono = (u.telefono || "").replace(/\D/g, "");
    if (!telefono) {
      mostrarMensajeModal("Este usuario no tiene un número de teléfono registrado.", "error");
      return;
    }
    window.open(`https://wa.me/58${telefono}`, "_blank", "noopener");
  });

  document.getElementById("btn-reenviar-password-usuario").addEventListener("click", async (evento) => {
    const boton = evento.currentTarget;
    boton.disabled = true;
    try {
      await reenviarPasswordCallable({ uid });
      mostrarMensajeModal("Se generó y envió una nueva contraseña a su correo personal.", "exito");
    } catch (error) {
      console.error("Error reenviando contraseña:", error);
      mostrarMensajeModal(error.message || "No se pudo reenviar la contraseña.", "error");
    } finally {
      boton.disabled = false;
    }
  });
}

/* =============================================================
   Vista admin/verificador: punto de entrada
   ============================================================= */

async function mostrarVistaAdmin(rol, uid, datos) {
  mostrarSolo(vistaAdmin);
  document.getElementById("insignia-rol").textContent = rol === "admin" ? "Administrador" : "Verificador";
  await inicializarBarraPerfil(uid, datos);
  configurarNavegacionPanel(rol === "admin");
  cargarListaPendientes();
}

/* =============================================================
   Punto de entrada: decidir qué vista mostrar según el rol
   ============================================================= */

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }

  try {
    // Forzamos refresco del ID token para que un rol recien asignado se
    // refleje sin pedirle a la persona que cierre sesión manualmente.
    const resultadoToken = await user.getIdTokenResult(true);
    const rol = resultadoToken.claims.role;

    let datosPropios = null;
    try {
      const snapPropio = await getDoc(doc(db, "usuarios", user.uid));
      if (snapPropio.exists()) datosPropios = snapPropio.data();
    } catch (error) {
      console.warn("No se pudo leer el perfil propio:", error);
    }

    if (rol === "admin" || rol === "verificador") {
      await mostrarVistaAdmin(rol, user.uid, datosPropios);
    } else {
      await mostrarVistaVoluntario(user.uid, datosPropios);
    }
  } catch (error) {
    console.error("Error determinando el rol del usuario:", error);
    await mostrarVistaVoluntario(user.uid, null);
  }
});
