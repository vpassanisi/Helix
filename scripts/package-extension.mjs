import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const staging = await mkdtemp(join(tmpdir(), 'helix-vscode-package-'))
const outputPath = join(root, `${packageManifest.publisher}.${packageManifest.name}-${packageManifest.version}.vsix`)

async function run(command, args, cwd) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${code}`}`))
    })
  })
}

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

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const localVsce = process.env.HELIX_VSCE_BIN
  const packageCommand = localVsce === undefined ? npx : localVsce
  const packageArgs = localVsce === undefined
    ? ['--yes', '@vscode/vsce', 'package', '--allow-missing-repository', '--out', outputPath]
    : ['package', '--allow-missing-repository', '--out', outputPath]
  await run(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], staging)
  await run(packageCommand, packageArgs, staging)
} finally {
  await rm(staging, { recursive: true, force: true })
}
