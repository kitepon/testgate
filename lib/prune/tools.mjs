// 刈り込みの道具（Stryker 一式）の置き場。testgate 本体は無依存のまま保ち、初回に別の場所へ npm で導入する。
// 置き場: $TESTGATE_PRUNE_TOOLS > $XDG_DATA_HOME/testgate/prune-tools > ~/.local/share/testgate/prune-tools（作り直せる物なので state ではなく share）
// plugin（lib/prune/*.mjs）はそこへ複製する。bare import（@stryker-mutator/api など）を置き場の node_modules で解決するため。
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRUNE_DEPS = {
  '@stryker-mutator/core': '10.0.0',
  '@stryker-mutator/instrumenter': '10.0.0',
  '@stryker-mutator/jest-runner': '10.0.0',
  '@stryker-mutator/vitest-runner': '10.0.0',
  typescript: '6.0.3',
}
const here = dirname(fileURLToPath(import.meta.url))

export function toolsDir(env = process.env) {
  if (env.TESTGATE_PRUNE_TOOLS) return env.TESTGATE_PRUNE_TOOLS
  const base = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share')
  return join(base, 'testgate', 'prune-tools')
}

function installed(dir) {
  try {
    const want = JSON.stringify(PRUNE_DEPS)
    const have = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies
    if (JSON.stringify(have) !== want) return false
    return Object.keys(PRUNE_DEPS).every(n => existsSync(join(dir, 'node_modules', n, 'package.json')))
  } catch { return false }
}

/** 道具を揃えて、場所を返す。npm の導入は版が違う時か無い時だけ。plugin の複製は毎回（安い）。 */
export function ensurePruneTools({ env = process.env, log = () => {}, npm = 'npm' } = {}) {
  const dir = toolsDir(env)
  mkdirSync(dir, { recursive: true })
  if (!installed(dir)) {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'testgate-prune-tools', private: true, description: 'testgate prune が使う Stryker 一式。testgate が版を決めて導入する', dependencies: PRUNE_DEPS }, null, 2) + '\n')
    log(`testgate prune: 道具を ${dir} へ導入する（初回か版の更新。数分かかる）`)
    const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env, shell: process.platform === 'win32' })
    if (r.status !== 0) throw new Error(`道具の導入に失敗（${dir}）: ${(r.stderr || r.stdout || '').trim().slice(-2000)}`)
  }
  const plugins = join(dir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  for (const f of readdirSync(here)) if (f.endsWith('.mjs')) copyFileSync(join(here, f), join(plugins, f))
  writeFileSync(join(plugins, 'package.json'), '{ "type": "module" }\n')
  return { dir, plugins, stryker: join(dir, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js') }
}
