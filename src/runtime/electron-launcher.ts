import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { HarnessClient, type HarnessClientOptions } from '@deepseek-ai/dsh-sdk-client'

export interface DshRuntimeProcessOptions {
  command: string
  args: string[]
  cwd?: string
  environment: () => NodeJS.ProcessEnv
  description: string
  initializeTimeoutMs: number
}

/**
 * The DSH CLI refuses to boot under Electron's patched Node. This launcher
 * runs it with ELECTRON_RUN_AS_NODE and shims the `node-addon-require-builtin`
 * module the SDK's native bridge tries to load, which does not exist in a
 * plain Node process.
 */
export const ELECTRON_DSH_LAUNCHER = `
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request !== 'node-addon-require-builtin') {
    return Reflect.apply(originalLoad, this, [request, parent, isMain])
  }

  const requireFromParent = createRequire(parent?.filename ?? import.meta.url)
  return {
    requireBuiltin: (moduleId) => requireFromParent(moduleId),
    isAllowedInternalId: () => true,
    getBindingInfo: () => ({ mode: 'expose-internals', product: 'require-builtin', backend: 'builtin' }),
  }
}

const [dshBin, ...dshArgs] = process.argv.slice(2)
if (dshBin === undefined) throw new Error('Helix DSH launcher requires a DSH entrypoint.')
process.argv = [process.argv[0], dshBin, ...dshArgs]
const { runCli } = await import(pathToFileURL(dshBin).href)
await runCli()
`

export function createElectronHarnessClient(
  options: HarnessClientOptions,
  launcherPath: string,
): HarnessClient {
  const callerCwd = process.cwd()
  const dshBin = options.dshBin === undefined
    ? resolveBundledDshBin()
    : resolve(callerCwd, options.dshBin)
  const profile = options.profile ?? 'sdk'
  const patches = (options.patches ?? []).map((patch) => resolve(callerCwd, patch))
  const args = [
    '--expose-internals',
    launcherPath,
    dshBin,
    '--profile',
    profile,
    ...patches.flatMap((patch) => ['--patch', patch]),
  ]
  const dshHome = options.dshHome === undefined ? undefined : resolve(callerCwd, options.dshHome)
  const runtime: DshRuntimeProcessOptions = {
    command: process.execPath,
    args,
    ...(options.processCwd === undefined ? {} : { cwd: resolve(callerCwd, options.processCwd) }),
    environment: () => ({
      ...(options.env ?? process.env),
      ELECTRON_RUN_AS_NODE: '1',
      ...(dshHome === undefined ? {} : { DSH_HOME: dshHome }),
    }),
    description: `dsh profile ${JSON.stringify(profile)}`,
    initializeTimeoutMs: options.initializeTimeoutMs ?? 10_000,
  }

  // rc.2's SDK client has a generic process-launch seam used by its own tests.
  // Its public constructor omits that seam, so keep this cast local to the
  // pinned rc.2 integration instead of changing the SDK's launch behavior.
  const ProcessHarnessClient = HarnessClient as unknown as new (
    clientOptions: HarnessClientOptions,
    processOptions: DshRuntimeProcessOptions,
  ) => HarnessClient
  return new ProcessHarnessClient(options, runtime)
}

export function resolveBundledDshBin(): string {
  const require = createRequire(import.meta.url)
  const manifestPath = require.resolve('@deepseek-ai/dsh/package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: { dsh?: string } }
  const entry = manifest.bin?.dsh
  if (entry === undefined) throw new Error('The bundled DSH package does not declare its CLI entrypoint.')
  return resolve(dirname(manifestPath), entry)
}
