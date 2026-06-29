/**
 * bootstrapAdmin.js
 * ==============================================================================
 * SCRIPT STANDALONE -- NO ES UNA CLOUD FUNCTION.
 * Se ejecuta UNA SOLA VEZ, manualmente, desde una maquina/consola de confianza
 * (por ejemplo la laptop de Osvaldo Farias) con credenciales de servicio.
 *
 * Por que existe esto?
 * ------------------------------------------------------------------------------
 * Las funciones "asignarRolAdmin" y "asignarRolVerificador" del backend exigen
 * que quien las invoque YA tenga el custom claim role === 'admin'. Pero al
 * arrancar el proyecto no existe NINGUN usuario con ese rol todavia: es un
 * problema de "huevo y gallina". Este script rompe ese ciclo asignando el rol
 * 'admin' directamente con el Admin SDK (que ignora las reglas de seguridad y
 * las Cloud Functions), usando credenciales de servicio con acceso total.
 *
 * Usalo SOLO para dar de alta al primer admin (Osvaldo). Despues de eso, los
 * demas admins/verificadores se asignan desde la app usando las funciones
 * callable normales (asignarRolAdmin / asignarRolVerificador), invocadas por
 * un admin ya autenticado.
 *
 * ------------------------------------------------------------------------------
 * REQUISITOS PREVIOS:
 * 1. Descargar la clave de cuenta de servicio del proyecto Firebase:
 *      Firebase Console > Configuracion del proyecto > Cuentas de servicio
 *      > "Generar nueva clave privada" -> descarga un archivo JSON.
 *    Guardalo localmente, por ejemplo como "serviceAccountKey.json", en esta
 *    misma carpeta (functions/). NUNCA lo subas a un repositorio publico.
 *
 * 2. El usuario al que se le va a asignar el rol admin debe EXISTIR YA en
 *    Firebase Authentication (por ejemplo porque ya completo el registro
 *    normal como voluntario y fue aprobado, o porque fue creado manualmente
 *    desde la consola de Firebase Auth).
 *
 * ------------------------------------------------------------------------------
 * USO:
 *   node bootstrapAdmin.js --uid=<UID_DEL_USUARIO>
 *   node bootstrapAdmin.js --email=<email_de_auth_o_personal>
 *
 * Ejemplos:
 *   node bootstrapAdmin.js --uid=ab12CD34ef56
 *   node bootstrapAdmin.js --email=V12345678@voluntarios.lienzo.app
 *
 * Variable de entorno opcional GOOGLE_APPLICATION_CREDENTIALS para indicar la
 * ruta del JSON de credenciales en vez de hardcodearla aqui:
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccountKey.json node bootstrapAdmin.js --uid=...
 * ==============================================================================
 */

'use strict';

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// --- 1. Inicializar Admin SDK con credenciales de servicio -------------------
// Prioridad: GOOGLE_APPLICATION_CREDENTIALS (variable de entorno estandar de
// Google Cloud) > archivo local "serviceAccountKey.json" en esta carpeta.
function inicializarAdminSDK() {
  const rutaPorEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const rutaLocal = path.join(__dirname, 'serviceAccountKey.json');

  if (rutaPorEnv && fs.existsSync(rutaPorEnv)) {
    const serviceAccount = require(path.resolve(rutaPorEnv));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Credenciales cargadas desde GOOGLE_APPLICATION_CREDENTIALS: ' + rutaPorEnv);
    return;
  }

  if (fs.existsSync(rutaLocal)) {
    const serviceAccount = require(rutaLocal);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log('Credenciales cargadas desde functions/serviceAccountKey.json');
    return;
  }

  console.error(
    'ERROR: No se encontraron credenciales de servicio.\n' +
    'Coloca el archivo "serviceAccountKey.json" en esta carpeta, o define\n' +
    'GOOGLE_APPLICATION_CREDENTIALS apuntando a tu archivo de credenciales.'
  );
  process.exit(1);
}

// --- 2. Parseo simple de argumentos de linea de comandos ----------------------
function parsearArgumentos() {
  const args = process.argv.slice(2);
  const resultado = {};
  for (const arg of args) {
    const partes = arg.replace(/^--/, '').split('=');
    const clave = partes[0];
    const valor = partes[1];
    resultado[clave] = valor;
  }
  return resultado;
}

// --- 3. Logica principal -------------------------------------------------------
async function main() {
  const argumentos = parsearArgumentos();
  const uid = argumentos.uid;
  const email = argumentos.email;

  if (!uid && !email) {
    console.error(
      'Uso: node bootstrapAdmin.js --uid=<UID>\n' +
      '  o: node bootstrapAdmin.js --email=<email>'
    );
    process.exit(1);
  }

  inicializarAdminSDK();

  try {
    // Resolver el usuario por uid o por email, segun lo que se haya pasado.
    const userRecord = uid
      ? await admin.auth().getUser(uid)
      : await admin.auth().getUserByEmail(email);

    const claimsActuales = userRecord.customClaims || {};

    // Asignamos el rol admin preservando cualquier otro claim existente.
    await admin.auth().setCustomUserClaims(userRecord.uid, Object.assign(
      {},
      claimsActuales,
      { role: 'admin' }
    ));

    console.log('------------------------------------------------------------');
    console.log('Rol "admin" asignado correctamente.');
    console.log('   UID:   ' + userRecord.uid);
    console.log('   Email: ' + userRecord.email);
    console.log('------------------------------------------------------------');
    console.log(
      'IMPORTANTE: el usuario debe cerrar sesion y volver a iniciar sesion\n' +
      '(o refrescar su ID token) para que el nuevo custom claim "role"\n' +
      'este disponible en el cliente.'
    );
    process.exit(0);
  } catch (error) {
    console.error('ERROR al asignar el rol admin:', error.message);
    process.exit(1);
  }
}

main();
