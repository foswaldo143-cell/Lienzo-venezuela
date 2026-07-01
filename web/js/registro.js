/* =========================================================
   ChildCare — Navegación de registro.html
   ========================================================= */

const opcionVoluntario = document.getElementById("opcion-voluntario");
const opcionCentro = document.getElementById("opcion-centro");
const mensajeProximamente = document.getElementById("mensaje-proximamente");

opcionVoluntario.addEventListener("click", () => {
  window.location.href = "registro-voluntario.html";
});

opcionCentro.addEventListener("click", () => {
  mensajeProximamente.textContent =
    "El registro de Centros de Cuidado estará disponible en una próxima entrega. Por ahora, si coordinas un centro, contacta directamente al equipo de ChildCare.";
  mensajeProximamente.classList.add("visible");
});
