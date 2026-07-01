/* =========================================================
   ChildCare — Configuración de Firebase
   =========================================================
   IMPORTANTE PARA OSVALDO:
   Estos son los valores REALES del proyecto de Firebase
   "lienzo-venezuela". Recordatorios de seguridad:

   1. El "apiKey" de un proyecto web de Firebase NO es secreto:
      identifica el proyecto, pero no otorga acceso por sí solo.
      La protección real de los datos vive en firestore.rules y
      storage.rules, confirma que ya estén desplegadas
      (firebase deploy --only firestore:rules,storage:rules)
      antes de anunciar la web públicamente.
   2. Si alguna vez necesitas rotar/restringir esta clave (por
      ejemplo, limitarla a tu dominio), hazlo desde Google Cloud
      Console > APIs y servicios > Credenciales.

   ESTE ARCHIVO ES JAVASCRIPT PLANO (sin import/export), pensado
   para cargarse con una etiqueta <script> normal, ANTES de los
   scripts que usan el SDK de Firebase. Es decir, en el HTML debe
   ir asi, en este orden:

     <script src="js/firebase-config.js"></script>
     <script type="module" src="js/login.js"></script>

   El objeto queda disponible globalmente como "window.firebaseConfig".
   La inicializacion real del SDK (initializeApp, getAuth, etc.) vive
   en js/firebase-init.js, que si es un modulo y lee este objeto.
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyBbRrGhwqt1kCHnkxANWumWrNG_X4vZaNs",
  authDomain: "lienzo-venezuela.firebaseapp.com",
  projectId: "lienzo-venezuela",
  storageBucket: "lienzo-venezuela.firebasestorage.app",
  messagingSenderId: "477629831279",
  appId: "1:477629831279:web:bf11ca430cc21a700a959a",
  measurementId: "G-G3ZJ62WD86"
};

window.firebaseConfig = firebaseConfig;
