#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_SUPABASE_CLI_VERSION = '2.118.0'
const EPHEMERAL_PROJECT_PREFIX = 'quiza_ephemeral_'
const TEMP_DIRECTORY_PREFIX = 'quiza-supabase-test-'
const MARKER_FILE = '.quiza-ephemeral-test.json'
const EXCLUDED_SERVICES = [
  'realtime',
  'storage-api',
  'imgproxy',
  'mailpit',
  'postgres-meta',
  'studio',
  'edge-runtime',
  'logflare',
  'vector',
  'supavisor',
]

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(scriptDirectory, '..')
const sourceSupabaseDirectory = join(projectRoot, 'supabase')
const sourceConfigPath = join(sourceSupabaseDirectory, 'config.toml')
const sourceMigrationsDirectory = join(
  sourceSupabaseDirectory,
  'migrations'
)
const supabaseCliPath = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'supabase.cmd' : 'supabase'
)
const vitestPath = join(
  projectRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
)

let activeChild = null
let interruptedSignal = null

function handleSignal(signal) {
  interruptedSignal = signal

  if (activeChild && !activeChild.killed) {
    activeChild.kill(signal)
  }
}

process.once('SIGINT', () => handleSignal('SIGINT'))
process.once('SIGTERM', () => handleSignal('SIGTERM'))

function sanitizeOutput(output) {
  return output
    .replace(
      /^(ANON_KEY|JWT_SECRET|PUBLISHABLE_KEY|SECRET_KEY|SERVICE_ROLE_KEY)=.*$/gim,
      '$1=<redacted>'
    )
    .replace(
      /^([^\n]*(?:anon key|publishable key|secret key|service_role key)[^:]*:).*$/gim,
      '$1 <redacted>'
    )
    .replace(/postgres(?:ql)?:\/\/[^@\s]+@/gi, 'postgresql://<redacted>@')
    .replace(
      /eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/g,
      '<redacted-jwt>'
    )
}

function runCaptured(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    activeChild = child
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.once('error', (error) => {
      activeChild = null
      rejectPromise(error)
    })

    child.once('close', (code, signal) => {
      activeChild = null

      if (code !== 0) {
        const error = new Error(
          `${options.label ?? command} terminó con código ${code ?? signal}.`
        )
        error.commandOutput = sanitizeOutput(`${stdout}\n${stderr}`)
        rejectPromise(error)
        return
      }

      resolvePromise({ stdout, stderr })
    })
  })
}

function runInherited(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })
    activeChild = child

    child.once('error', (error) => {
      activeChild = null
      rejectPromise(error)
    })

    child.once('close', (code, signal) => {
      activeChild = null

      if (code !== 0) {
        rejectPromise(
          new Error(
            `${options.label ?? command} terminó con código ${code ?? signal}.`
          )
        )
        return
      }

      resolvePromise()
    })
  })
}

function assertSupportedNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number)

  if (major !== 22 || minor < 13) {
    throw new Error(
      `Node.js ${process.versions.node} no es compatible. Usa Node.js >=22.13.0 <23.`
    )
  }
}

async function assertSupabaseCliVersion() {
  const packagePath = join(
    projectRoot,
    'node_modules',
    'supabase',
    'package.json'
  )
  const packageData = JSON.parse(await readFile(packagePath, 'utf8'))

  if (packageData.version !== REQUIRED_SUPABASE_CLI_VERSION) {
    throw new Error(
      `Supabase CLI ${packageData.version} no coincide con la versión requerida ${REQUIRED_SUPABASE_CLI_VERSION}. Ejecuta npm ci.`
    )
  }
}

function parseProjectId(config) {
  const match = config.match(/^project_id\s*=\s*"([^"]+)"\s*$/m)

  if (!match) {
    throw new Error('No fue posible leer project_id de supabase/config.toml.')
  }

  return match[1]
}

function readConfiguredPorts(config) {
  const ports = new Set()

  for (const line of config.split(/\r?\n/)) {
    if (line.trimStart().startsWith('#')) {
      continue
    }

    const match = line.match(
      /^\s*(?:port|shadow_port|inspector_port)\s*=\s*(\d+)\s*$/
    )

    if (match) {
      ports.add(Number(match[1]))
    }
  }

  return ports
}

function reserveFreePort(excludedPorts) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.unref()
    server.once('error', rejectPromise)
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address()
      const port = typeof address === 'object' ? address.port : null

      server.close((error) => {
        if (error) {
          rejectPromise(error)
          return
        }

        if (!port || excludedPorts.has(port)) {
          reserveFreePort(excludedPorts).then(resolvePromise, rejectPromise)
          return
        }

        excludedPorts.add(port)
        resolvePromise(port)
      })
    })
  })
}

async function allocatePorts(sourceConfig) {
  const excludedPorts = readConfiguredPorts(sourceConfig)
  const names = [
    'api.port',
    'db.port',
    'db.shadow_port',
    'db.pooler.port',
    'studio.port',
    'local_smtp.port',
    'edge_runtime.inspector_port',
    'analytics.port',
  ]
  const ports = {}

  for (const name of names) {
    ports[name] = await reserveFreePort(excludedPorts)
  }

  return ports
}

function buildEphemeralConfig(sourceConfig, projectId, ports) {
  const overrides = new Map([
    ['project_id', JSON.stringify(projectId)],
    ['api.port', String(ports['api.port'])],
    ['db.port', String(ports['db.port'])],
    ['db.shadow_port', String(ports['db.shadow_port'])],
    ['db.pooler.port', String(ports['db.pooler.port'])],
    ['db.seed.enabled', 'false'],
    ['studio.port', String(ports['studio.port'])],
    ['local_smtp.port', String(ports['local_smtp.port'])],
    [
      'edge_runtime.inspector_port',
      String(ports['edge_runtime.inspector_port']),
    ],
    ['analytics.port', String(ports['analytics.port'])],
  ])
  const replaced = new Set()
  let section = ''

  const config = sourceConfig
    .split(/\r?\n/)
    .map((line) => {
      const sectionMatch = line.match(/^\s*\[([^\]]+)]\s*$/)

      if (sectionMatch) {
        section = sectionMatch[1]
        return line
      }

      if (line.trimStart().startsWith('#')) {
        return line
      }

      const assignmentMatch = line.match(/^(\s*)([A-Za-z0-9_]+)\s*=.*$/)

      if (!assignmentMatch) {
        return line
      }

      const [, indentation, key] = assignmentMatch
      const qualifiedKey = section ? `${section}.${key}` : key

      if (!overrides.has(qualifiedKey)) {
        return line
      }

      replaced.add(qualifiedKey)
      return `${indentation}${key} = ${overrides.get(qualifiedKey)}`
    })
    .join('\n')

  const missingOverrides = [...overrides.keys()].filter(
    (key) => !replaced.has(key)
  )

  if (missingOverrides.length > 0) {
    throw new Error(
      `No se pudieron aislar estas opciones de Supabase: ${missingOverrides.join(', ')}.`
    )
  }

  return `${config}\n`
}

function parseStatusEnvironment(output) {
  const values = {}

  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)

    if (!match) {
      continue
    }

    const [, key, rawValue] = match
    let value = rawValue.trim()

    if (value.startsWith('"') && value.endsWith('"')) {
      value = JSON.parse(value)
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1)
    }

    values[key] = value
  }

  return values
}

function assertLocalEndpoint(rawUrl, expectedPort, label) {
  const url = new URL(rawUrl)

  if (
    url.protocol !== 'http:' &&
    url.protocol !== 'postgres:' &&
    url.protocol !== 'postgresql:'
  ) {
    throw new Error(`${label} usa un protocolo no permitido: ${url.protocol}`)
  }

  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`${label} no apunta al host local: ${url.hostname}`)
  }

  if (Number(url.port) !== expectedPort) {
    throw new Error(
      `${label} usa el puerto ${url.port}, pero el entorno efímero reservó ${expectedPort}.`
    )
  }
}

async function assertPortsRemainFree(ports) {
  for (const port of Object.values(ports)) {
    const server = createServer()

    await new Promise((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise)
      server.listen(
        { host: '127.0.0.1', port, exclusive: true },
        resolvePromise
      )
    })

    await new Promise((resolvePromise, rejectPromise) => {
      server.close((error) => {
        if (error) {
          rejectPromise(error)
          return
        }

        resolvePromise()
      })
    })
  }
}

async function listDockerResources(projectId) {
  const commands = [
    ['containers', ['ps', '-a', '--format', '{{.Names}}']],
    ['volumes', ['volume', 'ls', '--format', '{{.Name}}']],
    ['networks', ['network', 'ls', '--format', '{{.Name}}']],
  ]
  const resources = []

  for (const [kind, args] of commands) {
    const { stdout } = await runCaptured('docker', args, {
      label: `docker ${args.join(' ')}`,
    })

    for (const name of stdout.split(/\r?\n/).filter(Boolean)) {
      if (name.includes(projectId)) {
        resources.push(`${kind}:${name}`)
      }
    }
  }

  return resources.sort()
}

async function snapshotProtectedProject(projectId) {
  const { stdout } = await runCaptured(
    'docker',
    ['ps', '-a', '--format', '{{.Names}}'],
    { label: 'listar contenedores protegidos' }
  )
  const names = stdout
    .split(/\r?\n/)
    .filter((name) => name.endsWith(`_${projectId}`))
    .sort()

  if (names.length === 0) {
    return []
  }

  const inspection = await runCaptured(
    'docker',
    [
      'inspect',
      '--format',
      '{{.Id}}|{{.Name}}|{{.State.StartedAt}}|{{.State.Running}}',
      ...names,
    ],
    { label: 'inspeccionar contenedores protegidos' }
  )

  return inspection.stdout.split(/\r?\n/).filter(Boolean).sort()
}

async function assertSafeTemporaryDirectory(temporaryRoot, projectId) {
  const resolvedTemporaryRoot = await realpath(temporaryRoot)
  const resolvedSystemTemp = await realpath(tmpdir())
  const relativeToSystemTemp = relative(
    resolvedSystemTemp,
    resolvedTemporaryRoot
  )

  if (
    !relativeToSystemTemp ||
    relativeToSystemTemp.startsWith(`..${sep}`) ||
    relativeToSystemTemp === '..' ||
    !resolvedTemporaryRoot
      .split(sep)
      .at(-1)
      ?.startsWith(TEMP_DIRECTORY_PREFIX)
  ) {
    throw new Error(
      `Directorio temporal inseguro; se rechaza continuar: ${resolvedTemporaryRoot}`
    )
  }

  const marker = JSON.parse(
    await readFile(join(resolvedTemporaryRoot, MARKER_FILE), 'utf8')
  )

  if (
    marker.projectId !== projectId ||
    marker.purpose !== 'quiza-v1.1-ephemeral-tests'
  ) {
    throw new Error('La marca de seguridad del entorno efímero no coincide.')
  }
}

async function main() {
  assertSupportedNodeVersion()
  await assertSupabaseCliVersion()

  const localCliEnvironment = { ...process.env }
  delete localCliEnvironment.SUPABASE_ACCESS_TOKEN
  delete localCliEnvironment.SUPABASE_DB_PASSWORD

  const sourceConfig = await readFile(sourceConfigPath, 'utf8')
  const protectedProjectId = parseProjectId(sourceConfig)
  const protectedSnapshotBefore = await snapshotProtectedProject(
    protectedProjectId
  )
  const projectId = `${EPHEMERAL_PROJECT_PREFIX}${randomUUID()
    .replaceAll('-', '')
    .slice(0, 16)}`

  if (projectId === protectedProjectId) {
    throw new Error('El project_id efímero coincide con el proyecto protegido.')
  }

  const existingResources = await listDockerResources(projectId)

  if (existingResources.length > 0) {
    throw new Error(
      `El identificador efímero ya tiene recursos Docker: ${existingResources.join(', ')}`
    )
  }

  const temporaryRoot = await mkdtemp(
    join(await realpath(tmpdir()), TEMP_DIRECTORY_PREFIX)
  )
  const temporarySupabaseDirectory = join(temporaryRoot, 'supabase')
  const temporaryMigrationsDirectory = join(
    temporarySupabaseDirectory,
    'migrations'
  )
  let startAttempted = false
  let primaryError = null

  await writeFile(
    join(temporaryRoot, MARKER_FILE),
    JSON.stringify({
      purpose: 'quiza-v1.1-ephemeral-tests',
      projectId,
      createdByPid: process.pid,
    })
  )

  try {
    const ports = await allocatePorts(sourceConfig)
    const ephemeralConfig = buildEphemeralConfig(
      sourceConfig,
      projectId,
      ports
    )
    const migrationFiles = (await readdir(sourceMigrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort()

    if (migrationFiles.length === 0) {
      throw new Error('No hay migraciones para construir la base efímera.')
    }

    await mkdir(temporaryMigrationsDirectory, { recursive: true })
    await writeFile(
      join(temporarySupabaseDirectory, 'config.toml'),
      ephemeralConfig
    )

    for (const migrationFile of migrationFiles) {
      await copyFile(
        join(sourceMigrationsDirectory, migrationFile),
        join(temporaryMigrationsDirectory, migrationFile)
      )
    }

    await assertSafeTemporaryDirectory(temporaryRoot, projectId)
    await assertPortsRemainFree(ports)

    console.log(`[ephemeral] Proyecto: ${projectId}`)
    console.log(
      `[ephemeral] Puertos API/DB: ${ports['api.port']}/${ports['db.port']}`
    )
    console.log(
      `[ephemeral] Migraciones desde cero: ${migrationFiles.length}`
    )

    startAttempted = true
    const startResult = await runCaptured(
      supabaseCliPath,
      [
        'start',
        '--workdir',
        temporaryRoot,
        '--exclude',
        EXCLUDED_SERVICES.join(','),
        '--yes',
      ],
      {
        label: 'supabase start efímero',
        env: localCliEnvironment,
      }
    )
    const migrationLog = sanitizeOutput(
      `${startResult.stdout}\n${startResult.stderr}`
    )
      .split(/\r?\n/)
      .filter((line) => /Applying migration|Started supabase/i.test(line))
      .join('\n')

    if (migrationLog) {
      console.log(migrationLog)
    }

    const migrationResult = await runCaptured(
      supabaseCliPath,
      ['migration', 'list', '--local', '--workdir', temporaryRoot],
      {
        label: 'verificar migraciones efímeras',
        env: localCliEnvironment,
      }
    )

    for (const migrationFile of migrationFiles) {
      const version = migrationFile.split('_', 1)[0]

      if (!migrationResult.stdout.includes(version)) {
        throw new Error(
          `La migración ${migrationFile} no aparece aplicada en el entorno efímero.`
        )
      }
    }

    const statusResult = await runCaptured(
      supabaseCliPath,
      ['status', '-o', 'env', '--workdir', temporaryRoot],
      {
        label: 'obtener credenciales efímeras',
        env: localCliEnvironment,
      }
    )
    const status = parseStatusEnvironment(statusResult.stdout)

    if (!status.API_URL || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) {
      throw new Error(
        'Supabase CLI no entregó todas las credenciales efímeras requeridas.'
      )
    }

    assertLocalEndpoint(
      status.API_URL,
      ports['api.port'],
      'API_URL efímera'
    )

    if (status.DB_URL) {
      assertLocalEndpoint(
        status.DB_URL,
        ports['db.port'],
        'DB_URL efímera'
      )
    }

    console.log('[ephemeral] Credenciales obtenidas mediante Supabase CLI.')
    console.log('[ephemeral] Ejecutando Vitest en el entorno aislado...')

    const vitestArguments = ['run']

    if (process.argv.includes('--coverage')) {
      vitestArguments.push('--coverage')
    }

    await runInherited(vitestPath, vitestArguments, {
      label: 'Vitest',
      env: {
        ...process.env,
        TEST_SUPABASE_EPHEMERAL: '1',
        TEST_SUPABASE_PROJECT_ID: projectId,
        TEST_SUPABASE_URL: status.API_URL,
        TEST_SUPABASE_API_PORT: String(ports['api.port']),
        TEST_SUPABASE_ANON_KEY: status.ANON_KEY,
        TEST_SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
        VITE_SUPABASE_URL: status.API_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: status.ANON_KEY,
      },
    })
  } catch (error) {
    primaryError = error
  }

  let cleanupError = null

  try {
    await assertSafeTemporaryDirectory(temporaryRoot, projectId)

    if (startAttempted) {
      console.log(
        `[ephemeral] Destruyendo exclusivamente ${projectId}...`
      )
      await runCaptured(
        supabaseCliPath,
        [
          'stop',
          '--project-id',
          projectId,
          '--no-backup',
          '--workdir',
          temporaryRoot,
          '--yes',
        ],
        {
          label: 'supabase stop efímero',
          env: localCliEnvironment,
        }
      )
    }

    const remainingResources = await listDockerResources(projectId)

    if (remainingResources.length > 0) {
      throw new Error(
        `Quedaron recursos efímeros: ${remainingResources.join(', ')}`
      )
    }

    const protectedSnapshotAfter = await snapshotProtectedProject(
      protectedProjectId
    )

    if (
      JSON.stringify(protectedSnapshotAfter) !==
      JSON.stringify(protectedSnapshotBefore)
    ) {
      throw new Error(
        `El estado del proyecto protegido ${protectedProjectId} cambió durante la prueba.`
      )
    }

    await rm(temporaryRoot, { recursive: true, force: true })
    console.log('[ephemeral] Entorno eliminado; proyecto local protegido intacto.')
  } catch (error) {
    cleanupError = error
  }

  if (primaryError) {
    if (primaryError.commandOutput) {
      console.error(primaryError.commandOutput)
    }

    if (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        'Fallaron la ejecución y la limpieza del entorno efímero.'
      )
    }

    throw primaryError
  }

  if (cleanupError) {
    throw cleanupError
  }
}

main()
  .then(() => {
    if (interruptedSignal) {
      process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
    }
  })
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
