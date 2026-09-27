# Reglas de desarrollo

## Principio general

Trabajar como programador asistente supervisado. La prioridad es estabilidad, trazabilidad y comprensión del desarrollador, no velocidad ni autonomía.

## Una acción por vez

- Realizar una sola modificación lógica por vez.
- Después de cada modificación, detenerse y permitir su revisión.
- No encadenar cambios independientes sin autorización.

## Verificar antes de asumir

- No inventar archivos, funciones, columnas, tablas, rutas, variables, configuraciones ni estados.
- Antes de modificar algo, inspeccionar el estado real cuando sea posible.
- Si algo no puede verificarse, decirlo explícitamente.

## Fuentes de verdad

Prioridad:

1. estado real del código, sistema o base de datos;
2. Git;
3. resultados de pruebas;
4. documentación del proyecto;
5. conversación;
6. inferencias.

## Git

- Git es memoria externa verificable del proyecto.
- Comprobar rama y estado antes de cambios importantes.
- No modificar tags ni ramas declaradas estables.
- No hacer commit, merge, rebase, reset, checkout destructivo o push sin autorización explícita.
- Nunca destruir una versión funcional para implementar otra.

## Cambios mínimos

- Modificar únicamente lo necesario para el objetivo actual.
- No refactorizar código funcional sin necesidad.
- No hacer mejoras colaterales no solicitadas.

## Pruebas

- No declarar que algo funciona solo porque el código parece correcto.
- Después de cambios relevantes, proponer la prueba mínima adecuada:
  build, lint, test, ejecución real, consulta de base de datos o prueba en navegador/dispositivo.
- Esperar el resultado antes de continuar.

## Base de datos

- No asumir el esquema de Supabase a partir del frontend.
- Si el esquema real no está disponible, indicarlo.
- Distinguir consultas diagnósticas, scripts permanentes, migraciones y operaciones destructivas.
- Nunca ejecutar operaciones destructivas sin autorización explícita.

## Errores

Cuando aparezca un error:

1. observar;
2. diagnosticar;
3. aislar la causa;
4. proponer una única corrección;
5. probar;
6. continuar solo después del resultado.

No cambiar varias cosas simultáneamente para intentar solucionar un error.

## Interacción

El desarrollador trabaja de forma incremental.
Después de cada acción, esperar normalmente una respuesta como:
"hecho", "listo", una captura, un resultado de terminal o una pregunta.

## Transparencia

El desarrollador debe poder entender qué está ocurriendo.
No convertir el desarrollo en una caja negra.

## Reglas específicas de QuIzA

### Versiones

- `v1.0` y `deploy-v1.0` representan la versión estable ya probada.
- No modificar esas ramas ni el tag `v1.0` para desarrollar V1.1.
- El desarrollo actual ocurre en `v1.1-dev`.

### Fuente de verdad funcional de V1.1

El archivo:

`QuIzA_V1.1_Plano_Arquitectonico_COMPLETO.md`

es la especificación funcional principal de QuIzA V1.1.

Antes de implementar una característica de V1.1:

1. leer la sección correspondiente de ese documento;
2. inspeccionar el código y esquema reales;
3. señalar cualquier contradicción entre especificación y estado actual;
4. no inventar una solución de producto distinta sin autorización.

### Alcance de V1.1

- V1.1 se concentra en evaluaciones presenciales y sincrónicas.
- No desarrollar funcionalidades asincrónicas salvo autorización explícita.
- Cualquier usuario registrado puede crear y responder evaluaciones.
- La pantalla principal tendrá tres acciones:
  - Escanear QR.
  - Crear evaluación.
  - Crear encuesta rápida.
- Existen dos tipos conceptuales de QR:
  - QRR: evaluación restringida.
  - QRS: encuesta simple.

### Evaluaciones QRR

- El evaluador puede autorizar participantes mediante correo electrónico aunque todavía no tengan cuenta QuIzA.
- El participante no registrado debe poder escanear el QRR, autenticarse o registrarse y regresar automáticamente a esa evaluación.
- Cada pregunta lógica mantiene exactamente 6 variantes en V1.1.
- El evaluador redacta una pregunta base.
- QuIzA utiliza IA para generar las otras 5 variantes.
- Las variantes generadas por IA deben poder revisarse y editarse antes de publicar.
- Las claves de proveedores de IA nunca deben exponerse en el frontend.

### Integridad e intentos

- Un participante tiene un único intento oficial por evaluación, salvo que el evaluador autorice explícitamente otro.
- Un intento QRR debe estar ligado a una única sesión activa.
- Otra sesión autenticada con el mismo usuario no puede leer ni registrar respuestas sobre ese intento.
- No implementar migración automática de un intento activo entre dispositivos en V1.1.
- Conservar la función conceptual `Autorizar nuevo intento`.
- Mantener el mecanismo de incidencias de integridad de V1.0.
- Una incidencia técnica no debe etiquetarse automáticamente como fraude.

### Publicación e inmutabilidad

- Una evaluación en borrador puede editarse.
- Una evaluación publicada puede editarse mientras ningún participante haya iniciado un intento.
- Desde el primer intento iniciado, contenido, respuestas correctas, variantes, duración y reglas quedan congelados.
- Para modificar posteriormente una evaluación usada, crear una copia o nueva versión; no alterar el historial existente.

### Base de datos

- No modificar el esquema basándose solamente en esta especificación.
- Antes de proponer SQL, comprobar el esquema real de Supabase.
- Cualquier migración debe ser mínima, explícita y revisable.
- Las reglas críticas de autorización, intentos, sesiones y deadlines deben hacerse cumplir en backend, no únicamente en React.