/* =========================================================
   ChildCare — Inicialización del SDK de Firebase
   =========================================================
   Este archivo SÍ es un módulo ES (usa import/export) y es el
   único lugar donde se llama a initializeApp(). Lee la
   configuración desde "window.firebaseConfig", que es definida
   por js/firebase-config.js (cargado como <script> normal, sin
   type="module", ANTES de cualquier script que importe este
   archivo).

   Orden correcto en el HTML:
     <script src="js/firebase-config.js"></script>
     <script type="module" src="js/login.js"></script>
       (login.js hace: import { auth, db } from "./firebase-init.js")
   ========================================================= */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";

if (!window.firebaseConfig) {
  throw new Error(
    "firebase-config.js no se cargó antes de firebase-init.js. " +
    "Revisa que el <script src=\"js/firebase-config.js\"></script> " +
    "esté en el HTML ANTES del script que usa type=\"module\"."
  );
}

// Dominio interno usado para construir el email sintético de Auth a partir
// de la cédula. NO se muestra nunca al usuario en la interfaz.
export const DOMINIO_AUTH_SINTETICO = "@voluntarios.lienzo.app";

const app = initializeApp(window.firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
