# Estado de desarrollo de QuIzA V1.1

**Fecha de corte:** 2026-10-16
**Rama:** `v1.1-dev`
**Fuente funcional:** `QuIzA_V1.1_Plano_Arquitectonico_COMPLETO.md`

Este registro distingue código probado localmente de integraciones que requieren
configuración o dispositivos externos. No acredita despliegue ni producción.

## Línea base verificada

- Suite reproducible: 23 archivos, 57 pruebas aprobadas, 0 fallidas.
- Supabase efímero: 14 migraciones aplicadas desde cero y entorno destruido al
  terminar; el proyecto local habitual permaneció intacto.
- Rama local: 24 commits por delante de `origin/v1.1-dev` antes del commit de
  aislamiento por sesión documentado en este corte.
- `KI-01` quedó corregido y probado: se puede eliminar un quiz sin intentos con
  sus variantes por cascada, y se conserva todo quiz que ya tenga historial.

## Matriz de requisitos

| Área V1.1 | Estado | Evidencia local |
|---|---|---|
| Cuenta sin rol rígido | Implementado | Un perfil con `is_teacher = false` crea curso, quiz y pregunta canónica, y responde un quiz ajeno. |
| Autorregistro tradicional y retorno QRR | Implementado | Prueba UI registra la cuenta, conserva el token y entra automáticamente al QRR autorizado. |
| Google OAuth | Implementado, no validado externamente | Flujo y retorno QRR existen; proveedor, redirect y credenciales remotas no se ejecutaron localmente. |
| Dashboard y tres acciones | Implementado | Escáner QRR/QRS, creación de evaluación y encuesta rápida tienen flujos funcionales. |
| Evaluación presencial y edición | Implementado | Crea borrador, edita datos/preguntas mientras no hay intentos y publica solo contenido completo. |
| Participantes y autorizaciones | Implementado | Previsualiza nombre+correo, normaliza, deduplica y permite autorizar correos aún no registrados. |
| QRR y ventana de acceso | Implementado | Token opaco, apertura/cierre/expiración de acceso y duración independiente del intento están probados. |
| Intento único y nuevo intento autorizado | Implementado | Conserva historial, audita autorización y consume una sola autorización bajo concurrencia. |
| Sesión única por intento | Implementado | Otro login no puede leer ni ejecutar pregunta, respuesta, heartbeat o incidencia; el historial terminado sigue visible al titular. |
| Deadline, reconexión y `expired` | Implementado | Backend conserva deadline, F5 no crea incidencia y expiración recupera la calificación persistida en envío, heartbeat y entrega concurrentes. |
| Incidencias de integridad | Implementado | Cinco reemplazos asignan seis variantes distintas; la sexta incidencia bloquea y cierra el intento sin etiquetarla como fraude. |
| Orden visual de opciones | Implementado | Orden determinista por respuesta, estable tras F5; la respuesta enviada conserva el ID interno. |
| Variantes IA | Implementado localmente | Reserva transaccional, Edge Function, proveedor, validación, edición y regeneración individual tienen pruebas con proveedor simulado. |
| Publicación e inmutabilidad | Implementado | Exige seis variantes válidas, devuelve a borrador al editar sin intentos y congela/elimina de forma segura cuando existe historial. |
| Duplicar evaluación | Implementado | Copia reglas y variantes sin copiar intentos ni alterar resultados anteriores. |
| Panel y resultados | Implementado | Métricas en vivo, tabla, detalle e incidencias se restringen al propietario. |
| QRS anónimo | Implementado | Dominio separado, token opaco, respuesta sin `user_id`, anti-duplicado y agregados para el creador. |
| Pruebas reproducibles | Implementado | Node.js `>=22.13.0 <23`, Supabase CLI `2.118.0`, puertos aislados, credenciales CLI y destrucción segura. |

## Trabajo completado en la reanudación

- `10a9e20`: aleatorización visual sin alterar la identidad de la respuesta.
- `09db31f`: prueba integral del límite de incidencias y bloqueo.
- `73159a0`: prueba de una cuenta sin rol académico rígido.
- En curso al escribir este corte: consolidar el rechazo de escrituras desde una
  segunda sesión autenticada; suite completa aprobada con 57/57 pruebas.

## Pendientes y riesgos externos

- Ejecutar una vez el cierre integral: cobertura, `npm audit`, lint y build.
- Probar Google OAuth y confirmación de correo con la configuración real del
  proyecto antes de liberar.
- Probar cámara/`BarcodeDetector` en dispositivos objetivo; la ruta manual y el
  reconocimiento de enlaces QRR/QRS sí están automatizados.
- Ejecutar una generación contra el proveedor LLM real con secretos configurados
  en Supabase; ninguna clave debe llegar al frontend ni al repositorio.
- Probar desde teléfonos y redes distintas solo en un entorno de piloto aprobado.

## Siguiente acción exacta

Finalizar el commit local de aislamiento por sesión y ejecutar una única pasada
de `npm run test:coverage`, `npm audit`, `npm run lint` y `npm run build`. Después,
revisar el árbol Git y documentar únicamente riesgos no ejecutables localmente.
