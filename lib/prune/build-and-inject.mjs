// Stryker の buildCommand（shell を通らないので && が使えない）: build script を流してから、製品コードへ変異番号のヘッダを注入する。
// 使い方: node build-and-inject.mjs [--script build] [--dir dist | --glob G ... --exclude G ...]  （cwd = sandbox の根）
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const args = process.argv.slice(2)
const opt = { script: null, globs: [], exclude: [] }
for (let i = 0; i < args.length; i++) { const a = args[i]; if (a === '--script') opt.script = args[++i]; else if (a === '--dir') opt.dir = args[++i]; else if (a === '--glob') opt.globs.push(args[++i]); else if (a === '--exclude') opt.exclude.push(args[++i]) }
if (opt.script) {
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', opt.script], { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
  if (r.status !== 0) process.exit(r.status ?? 1)
}
const injectArgs = [join(dirname(fileURLToPath(import.meta.url)), 'inject-active-mutant.mjs'), process.cwd()]
if (opt.dir) injectArgs.push('--dir', opt.dir)
for (const g of opt.globs) injectArgs.push('--glob', g)
for (const g of opt.exclude) injectArgs.push('--exclude', g)
const r2 = spawnSync(process.execPath, injectArgs, { stdio: 'inherit' })
process.exit(r2.status ?? 1)
