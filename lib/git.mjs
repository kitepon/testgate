import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logPath } from './log.mjs'

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

export function repoRoot(cwd) {
  const out = git(['rev-parse', '--show-toplevel'], cwd)
  return out ? out.trim() : null
}

// 変更ファイル（リポジトリ相対）。base があれば base との差分、無ければ HEAD との差分。どちらも未追跡を含む。
export function changedFiles(cwd, base) {
  const root = repoRoot(cwd)
  if (!root) return null
  const ref = base && git(['cat-file', '-e', `${base}^{commit}`], root) !== null ? base : 'HEAD'
  const diff = git(['diff', '--name-only', ref, '--'], root)
  if (diff === null) {
    // HEAD が無い（初回commit前）: 全追跡ファイルを変更扱い
    const all = git(['ls-files'], root) ?? ''
    return { root, base: null, changed: uniq(all.split('\n').concat(untracked(root))) }
  }
  return { root, base: ref === base ? base : null, changed: uniq(diff.split('\n').concat(untracked(root))) }
}

function untracked(root) { return (git(['ls-files', '--others', '--exclude-standard'], root) ?? '').split('\n') }
function uniq(list) { return [...new Set(list.map(s => s.trim()).filter(Boolean))].sort() }

// 「最後に全部通った commit」の記録。リポジトリのルートごとに持つ。
export function statePath(env = process.env) { return join(dirname(logPath(env)), 'state.json') }
export function readState(env = process.env) {
  try { return JSON.parse(readFileSync(statePath(env), 'utf8')) } catch { return { lastFullPass: {} } }
}
export function lastFullPass(root, env = process.env) { return readState(env).lastFullPass?.[root] ?? null }
export function recordFullPass(root, env = process.env) {
  const head = git(['rev-parse', 'HEAD'], root)
  if (!head) return
  const state = readState(env)
  state.lastFullPass = { ...(state.lastFullPass ?? {}), [root]: head.trim() }
  mkdirSync(dirname(statePath(env)), { recursive: true })
  writeFileSync(statePath(env), JSON.stringify(state, null, 2))
}
