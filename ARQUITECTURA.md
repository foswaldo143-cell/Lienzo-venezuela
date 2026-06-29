# Arquitectura — Plataforma Lienzo / Red de Apoyo a Centros de Cuidado

Documento de referencia compartido. Frontend y backend deben respetar exactamente estos nombres de campos y colecciones para que ambos lados encajen sin fricción.

## Roles (custom claims en Firebase Auth, NUNCA en el cliente)

- `admin` — control total. El primero (Osvaldo) se asigna manualmente vía script de bootstrap (ver guía de despliegue). Los admins pueden crear otros admins y asignar el rol `verificador`.
- `verificador` — un voluntario YA aprobado al que un admin le otorga este poder. Puede leer datos de voluntarios pendientes y aprobar/rechazar manualmente.
- `voluntario` — rol base de quien se registra como voluntario.
- `centro` — rol base de quien registra un centro de cuidado (módulo futuro, no se construye aún).

El rol y el estado de verificación **nunca son editables por el propio usuario**. Solo se cambian server-side (Cloud Functions con Admin SDK), que ignoran las reglas de seguridad de Firestore.

## Colección `usuarios/{uid}`

Documento creado por el cliente en el registro, pero con campos restringidos por reglas (ver abajo).

```
{
  cedula: string,              // "V12345678" o "E12345678"
  nombre: string,
  apellido: string,
  telefono: string,            // formato E.164: "+584121234567"
  telefonoEmergencia: string,  // mismo formato
  emailVerificado: boolean,    // true solo cuando Firebase Auth confirma el email
  rolSolicitado: "voluntario" | "centro",
  rol: "voluntario_pendiente", // el cliente SIEMPRE debe enviar este valor fijo; la regla de Firestore lo exige
  estado: "pendiente_verificacion", // el cliente SIEMPRE debe enviar este valor fijo
  ciudad: string,
  estadoProvincia: string,     // estado de Venezuela, ej "Lara"
  direccionTexto: string,
  lat: number,
  lng: number,
  fotoRostroPath: string,      // ruta en Storage, no URL pública directa
  fotoCedulaPath: string,
  fechaRegistro: timestamp (serverTimestamp),

  // Campos que SOLO Cloud Functions puede escribir (las reglas deben bloquear al cliente):
  estadoVerificacion: "pendiente_ia" | "pendiente_manual" | "aprobado" | "rechazado",
  motivoRechazo: string | null,
  verificadoPor: string | null,   // uid del admin/verificador o "claude-ia"
  fechaVerificacion: timestamp | null,
  confianzaIA: number | null,     // 0-100
  qrToken: string | null          // token único generado al aprobar, para el carnet/QR
}
```

## Colección `verificaciones/{uid}` (auditoría, solo lectura para admin/verificador)

```
{
  metodo: "claude-ia" | "manual",
  resultadoBruto: string,    // respuesta cruda del análisis, para trazabilidad
  confianza: number,
  decision: "aprobado" | "rechazado" | "pendiente_manual",
  fecha: timestamp
}
```

## Storage

- `/voluntarios/{uid}/rostro.jpg`
- `/voluntarios/{uid}/cedula.jpg`

Solo el propio `uid` puede subir. Solo el propio usuario, admins y verificadores pueden leer (nunca público).

## Reglas de seguridad (resumen — el backend debe entregar los archivos reales)

**Firestore (`firestore.rules`)**
- `create` en `usuarios/{uid}`: solo si `request.auth.uid == uid`, y solo si `estado == 'pendiente_verificacion'` y `rol == 'voluntario_pendiente'` (el cliente no puede auto-aprobarse).
- `update` en `usuarios/{uid}`: el propietario solo puede editar campos no sensibles (no `estado`, `estadoVerificacion`, `rol`, `verificadoPor`, `confianzaIA`, `qrToken`). Admin/verificador pueden actualizar todo.
- `read` en `usuarios/{uid}`: el propietario puede leer su propio doc. Admin y verificador pueden leer todos. Nadie más.
- `verificaciones/*`: solo admin/verificador leen; solo Cloud Functions escriben (cliente sin permiso de escritura).

**Storage (`storage.rules)**
- `write` en `/voluntarios/{uid}/*`: solo `request.auth.uid == uid`.
- `read` en `/voluntarios/{uid}/*`: propietario, admin o verificador (chequear `request.auth.token.role`).

## Flujo de verificación (backend, Cloud Functions)

1. Trigger `onCreate` en `usuarios/{uid}` (o función *callable* `enviarParaVerificacion` invocada por el cliente tras subir fotos).
2. Si existe `ANTHROPIC_API_KEY` configurada: llamar a la API de Claude (modelo con visión) enviando la foto de rostro + foto de cédula + nombre/apellido/cédula declarados, pidiendo un JSON con `{coincideNombre: bool, coincideRostro: bool, confianza: 0-100, observaciones: string}`.
   - Si `confianza >= 80` y ambas coinciden → `estadoVerificacion = "aprobado"`.
   - Si `confianza` entre 50-79 o hay inconsistencias menores → `"pendiente_manual"`.
   - Si claramente no coincide → `"rechazado"` con `motivoRechazo`.
3. Si **no** existe `ANTHROPIC_API_KEY` (caso actual): marcar siempre `estadoVerificacion = "pendiente_manual"`, `metodo = "manual"`, y dejar el registro visible en el futuro dashboard de coordinador para revisión humana. Este es el modo activo por ahora.
4. Si `aprobado`: generar `qrToken` (uuid), crear contraseña temporal, dar de alta en Firebase Auth (o actualizar), enviar correo con usuario (cédula) + contraseña + carnet (imagen con foto, nombre, cédula, teléfono, ciudad, código QR).
5. Si `rechazado`: enviar correo explicando el motivo.
6. Todo intento queda registrado en `verificaciones/{uid}`.

## Notas de diseño UX (para el frontend)

- Mobile-first, español, tipografía grande y clara, mínimo texto por pantalla, wizard de pasos cortos con barra de progreso (no un formulario largo intimidante).
- Captura de fotos: usar `<input type="file" accept="image/*" capture="user">` para el rostro y `capture="environment"` para la cédula — funciona en cualquier teléfono sin pedir permisos complejos de cámara en vivo, ideal para conectividad/dispositivos limitados. Mostrar vista previa antes de enviar.
- Mapa: Leaflet.js + OpenStreetMap (Nominatim para autocompletar dirección) — NO Google Maps, para respetar la regla de "sin APIs de pago" del stack definido. El usuario puede arrastrar un pin o buscar su dirección.
- Teléfono: input con máscara que fuerza formato `+58` + 10 dígitos.
- Mensaje claro de privacidad: "Tus datos y fotos solo serán vistos por coordinadores verificados. No se comparten públicamente."

## Estrategia de login con cédula (decisión de arquitectura)

Firebase Auth exige email+password para `signInWithEmailAndPassword`. Como el usuario final solo conoce su **cédula**, usamos un correo sintético interno como identidad de Auth, y el correo personal real se guarda aparte para comunicaciones:

- Email de Auth (interno, no se le muestra ni se le pide al usuario que lo recuerde): `V12345678@voluntarios.lienzo.app` (cédula en mayúsculas + dominio fijo).
- Email personal real: campo `emailPersonal` en `usuarios/{uid}`, usado solo para enviar el carnet, credenciales y notificaciones. Su verificación se hace con un código de 6 dígitos enviado por Cloud Function (no con el flow nativo de Firebase Auth, porque ese flow verifica el email de Auth, no el personal).
- Pantalla de login: el campo se llama "Cédula" y el campo "Contraseña". Internamente el JS construye `cedula.toUpperCase() + '@voluntarios.lienzo.app'` y llama a `signInWithEmailAndPassword`.
- Frontend NUNCA debe exponer el dominio interno en la interfaz visible al usuario, solo en el código.
- Al aprobar a un voluntario, la Cloud Function crea/actualiza el usuario de Auth con ese email sintético + una contraseña temporal generada, y la envía por `emailPersonal`.
