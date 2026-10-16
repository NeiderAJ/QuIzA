# QuIzA

## Pruebas de integración V1.1

### Requisitos

- Node.js `>=22.13.0 <23`. La versión reproducible usada por el proyecto está en `.nvmrc` (`22.22.0`).
- npm 10, incluido con Node.js 22.
- Docker con el daemon en ejecución.
- Supabase CLI `2.118.0`. Se instala localmente y queda fijado por `package-lock.json`; no se requiere una instalación global.

### Instalación limpia

```bash
git clone <repositorio>
cd 01_QuIzA
nvm install
nvm use
npm ci
npm test
```

`npm test` no utiliza el proyecto Supabase habitual. El runner:

1. crea un directorio temporal y un `project_id` aleatorio con prefijo `quiza_ephemeral_`;
2. reserva puertos locales diferentes de los declarados en `supabase/config.toml`;
3. copia todas las migraciones existentes y construye una base nueva desde cero;
4. obtiene URL y claves locales mediante `supabase status -o env`;
5. ejecuta Vitest únicamente si la URL, el puerto y la marca efímera coinciden;
6. destruye ese proyecto con `supabase stop --project-id ... --no-backup`.

El runner no copia metadatos de enlace remoto ni archivos de `supabase/.temp`. También compara antes y después la identidad y fecha de inicio de los contenedores del proyecto Supabase configurado en el repositorio. Si alguna comprobación de aislamiento falla, las pruebas se abortan.

No se debe ejecutar `vitest` directamente: los helpers rechazan cualquier entorno que no haya sido creado por el runner efímero.

### Comandos

```bash
npm test
npm run test:coverage
npm audit
npm run lint
npm run build
```

Los fixtures crean seis variantes por slot y conservan la variante 1 como asignación determinista. Los datos no se eliminan fila por fila: desaparecen al destruir la base efímera completa, sin desactivar triggers ni políticas.
