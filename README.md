# Guía de configuración — ChildCare (primera entrega)

Esta entrega incluye: login, elección de rol, y el flujo completo de registro de voluntarios (formulario, fotos, verificación con fallback manual, correos, carnet con QR). El módulo de Centros de Cuidado queda para la siguiente entrega.

## 1. Crear el proyecto de Firebase

1. Ve a https://console.firebase.google.com → "Agregar proyecto". Nómbralo, por ejemplo, `lienzo-venezuela`.
2. Dentro del proyecto, activa:
   - **Authentication** → pestaña "Sign-in method" → habilita "Correo electrónico/contraseña".
   - **Firestore Database** → "Crear base de datos" → modo producción → elige una región cercana (ej. `us-east1`).
   - **Storage** → "Comenzar" → modo producción, misma región.
3. En "Configuración del proyecto" (ícono de engranaje) → "Tus apps" → agrega una app web (`</>`). Copia el bloque `firebaseConfig` que te muestra (apiKey, authDomain, projectId, storageBucket, etc.).
4. Abre `web/js/firebase-config.js` y pega esos valores donde dice `PEGA_AQUI_TU_API_KEY`, etc.

## 2. Desplegar las reglas de seguridad

Este repositorio ya incluye `firebase.json`, `firestore.rules`, `storage.rules` y `firestore.indexes.json` listos para usar. Solo falta indicar a qué proyecto de Firebase apuntan:

```
npm install -g firebase-tools
firebase login
cp .firebaserc.example .firebaserc
# edita .firebaserc y reemplaza "TU-PROJECT-ID-AQUI" por el projectId real de tu proyecto Firebase
firebase deploy --only firestore:rules,storage:rules
```

(`.firebaserc` está en `.gitignore` a propósito — cada quien lo genera localmente con su propio projectId, así nunca queda un projectId real subido a GitHub por error).

**No saltes este paso.** Sin estas reglas, cualquier persona podría leer fotos y datos de los voluntarios.

## 3. Configurar y desplegar las Cloud Functions

```
cd functions
npm install
```

Crea el archivo de variables de entorno reales (copia `.env.example` y complétalo):

- `EMAIL_USER` / `EMAIL_PASS`: usa una cuenta de Gmail (puede ser `foswaldo143@gmail.com` u otra dedicada al proyecto) + una "Contraseña de aplicación" (no tu clave normal): Cuenta de Google → Seguridad → Verificación en dos pasos (activarla primero) → Contraseñas de aplicaciones → genera una para "Correo".
- `ANTHROPIC_API_KEY`: **déjala vacía por ahora.** Mientras no la configures, el sistema marca automáticamente cada registro como "pendiente de revisión manual" — es el modo seguro que pediste para esta etapa, mientras conseguimos la clave de Anthropic. Cuando la tengas, solo agrégala aquí y el análisis con Claude se activa solo.

Sube las variables a Firebase (Functions de 2ª generación usan `.env` automáticamente si lo colocas en `functions/.env`; si usas Functions de 1ª generación, usa `firebase functions:config:set`).

Despliega:

```
firebase deploy --only functions
```

## 4. Crear el primer administrador (tú, Osvaldo)

Como todavía no existe ningún admin que pueda asignarte el rol, hazlo una sola vez manualmente:

1. Descarga una clave de cuenta de servicio: Configuración del proyecto → Cuentas de servicio → "Generar nueva clave privada" → guarda el JSON como `functions/serviceAccountKey.json` (**no lo subas a ningún repositorio público**).
2. Regístrate normalmente como voluntario en la web para que se cree tu usuario de Auth.
3. Ejecuta:

```
cd functions
node bootstrapAdmin.js --email=TU_EMAIL_SINTETICO@voluntarios.lienzo.app
```

(El email sintético es tu cédula en mayúsculas + `@voluntarios.lienzo.app`, ej. `V12345678@voluntarios.lienzo.app`).

Desde ese momento tu cuenta tiene el rol `admin` y, cuando construyamos el dashboard, podrás aprobar manualmente a los voluntarios marcados como "pendiente_manual" y asignar el rol `verificador` a quien quieras.

## 5. Publicar el sitio (Vercel o Netlify)

El contenido a publicar es la carpeta `web/`.

**Netlify (más simple):** arrastra la carpeta `web/` a https://app.netlify.com/drop, o conecta un repositorio de Git y configura "Publish directory" = `web`.

**Vercel:** `npm install -g vercel`, luego dentro de `web/` ejecuta `vercel` y sigue las instrucciones (framework: "Other"/estático).

No requiere build step — son archivos estáticos.

## 6. Probar el flujo completo

1. Abre el sitio publicado (o `web/index.html` localmente con un servidor simple, ej. `npx serve web`, para que los módulos JS funcionen).
2. Entra a "Registrarme" → "Quiero ser Voluntario" y completa el wizard con datos de prueba.
3. Verifica en la consola de Firebase (Firestore → `usuarios`) que se creó el documento con `estado: "pendiente_verificacion"`.
4. Revisa Storage para confirmar que las dos fotos se subieron.
5. Si configuraste `EMAIL_USER`/`EMAIL_PASS`, deberías recibir el correo con el código de verificación de email al llegar a ese paso.

## Pendiente para la próxima entrega (no incluido aún)

- Dashboard de administrador/verificador para revisar manualmente los registros en `pendiente_manual` y aprobarlos/rechazarlos.
- Módulo de registro de Centros de Cuidado (mapa de centros, capacidad, necesidades).
- Escáner de QR para verificadores en la puerta de los centros.
- Integración real con la API de Anthropic en cuanto tengas la clave.

## Lo que YA está activo aunque falten esos módulos

Por ahora, todo voluntario que se registre queda en `pendiente_manual` — nadie es aprobado automáticamente sin revisión humana. Hasta que el dashboard esté listo, Osvaldo (como admin) puede revisar manualmente los documentos directamente desde la consola de Firebase (Firestore → colección `usuarios`, filtrar por `estadoVerificacion == "pendiente_manual"`) y, si decide aprobar a alguien, puede llamar la función `aprobarVoluntario` editando el estado y disparando el envío de correo manualmente — o decirme cuando quieras que construyamos ese dashboard como siguiente paso.
