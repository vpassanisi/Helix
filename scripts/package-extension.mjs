import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const staging = await mkdtemp(join(tmpdir(), 'helix-vscode-package-'))
const outputPath = join(root, `${packageManifest.publisher}.${packageManifest.name}-${packageManifest.version}.vsix`)

async function run(command, args, cwd, label = command) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${label} exited with ${signal ?? `code ${code}`}`))
    })
  })
}

/**
 * Resolve an npm invocation that `spawn` can start with `shell: false`.
 *
 * Windows ships npm as `npm.cmd`, and Node refuses to spawn a `.cmd` shim
 * without a shell, so `npm run package` fails there with `spawn EINVAL`. The
 * npm lifecycle hands this script the CLI entrypoint in `npm_execpath`, and the
 * same file sits next to `node.exe` on a stock install, so running it through
 * the Node binary skips the shim on every platform.
 * @returns the executable and the arguments that precede the npm subcommand.
 */
function npmInvocation() {
  const fromLifecycle = process.env.npm_execpath
  if (fromLifecycle !== undefined && fromLifecycle.trim() !== '' && existsSync(fromLifecycle)) {
    return { executable: process.execPath, prefixArgs: [fromLifecycle] }
  }
  const bundledCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(bundledCli)) return { executable: process.execPath, prefixArgs: [bundledCli] }
  return { executable: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefixArgs: [] }
}

const npm = npmInvocation()

try {
  const productionManifest = { ...packageManifest }
  delete productionManifest.devDependencies
  delete productionManifest.scripts

  await writeFile(
    join(staging, 'package.json'),
    `${JSON.stringify(productionManifest, null, 2)}\n`,
    'utf8',
  )
  await cp(join(root, 'package-lock.json'), join(staging, 'package-lock.json'))
  await cp(join(root, 'out'), join(staging, 'out'), { recursive: true })
  await cp(join(root, 'media'), join(staging, 'media'), { recursive: true })
  await cp(join(root, 'README.md'), join(staging, 'README.md'))
  await writeFile(join(staging, '.vscodeignore'), [
    '.vscode/',
    'src/',
    'test/',
    'scripts/',
    'tsconfig.json',
    'tsconfig.webview.json',
    'vite.webview.config.ts',
    'svelte.config.js',
    'package-lock.json',
    '*.tsbuildinfo',
    '',
  ].join('\n'), 'utf8')

  // `npm exec` reaches the same package runner as `npx` without a `.cmd` shim.
  const localVsce = process.env.HELIX_VSCE_BIN
  const packageCommand = localVsce === undefined ? npm.executable : localVsce
  const packageArgs = localVsce === undefined
    ? [...npm.prefixArgs, 'exec', '--yes', '--', '@vscode/vsce', 'package', '--allow-missing-repository', '--out', outputPath]
    : ['package', '--allow-missing-repository', '--out', outputPath]
  await run(npm.executable, [...npm.prefixArgs, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging, 'npm ci')
  await run(packageCommand, packageArgs, staging, localVsce === undefined ? 'vsce package' : localVsce)
} finally {
  await rm(staging, { recursive: true, force: true })
}
