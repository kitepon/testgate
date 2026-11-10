import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { logPath } from './log.mjs'

// git の問い合わせ。失敗（git が無い、timeout、出力が上限超え、終了コード非0）は null。
// 上限は 64MB（既定の 1MB では未追跡の多い置き場で切れ、「変更なし」と誤る。トロニーの実機で出た）。
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

// 同じ問い合わせの生のバイト列版（diff --binary をそのまま hash する）。失敗は null。
function gitBytes(args, cwd) {
  const r = spawnSync('git', args, { cwd, timeout: 5000, maxBuffer: 64 * 1024 * 1024 })
  return r.error || r.status !== 0 ? null : r.stdout
}

const MAX_UNTRACKED_FILES = 2000
const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024

// 試験が走る時点の状態: HEAD と、未commit（追跡の差分と未追跡ファイル）の指紋。
// treeHash は「testedCommit と未commitの中身が同じなら同じ値」の識別子。不明（git 無し・初回commit前・上限超え・問い合わせ失敗）は null。
// 限界: .gitignore された物（生成物・node_modules）は指紋に入らない。
export function testedState(cwd) {
  const root = repoRoot(cwd)
  const head = root ? git(['rev-parse', '--verify', '-q', 'HEAD'], root)?.trim() : null
  if (!head || !/^[0-9a-f]{40}$/.test(head)) return { testedCommit: null, treeHash: null }
  const diff = gitBytes(['diff', 'HEAD', '--binary'], root)
  const listed = gitBytes(['ls-files', '--others', '--exclude-standard', '-z'], root)
  if (diff === null || listed === null) return { testedCommit: head, treeHash: null }
  const names = listed.toString('utf8').split('\0').filter(Boolean).sort()
  if (names.length > MAX_UNTRACKED_FILES) return { testedCommit: head, treeHash: null }
  const hash = createHash('sha256').update(head).update('\n').update(diff)
  let total = 0
  for (const name of names) {
    try {
      const info = lstatSync(`${root}/${name}`)
      if (!info.isFile()) { hash.update(`${name}\0${info.isSymbolicLink() ? 'link' : 'other'}\0`); continue }
      total += info.size
      if (total > MAX_UNTRACKED_BYTES) return { testedCommit: head, treeHash: null }
      hash.update(`${name}\0`).update(createHash('sha256').update(readFileSync(`${root}/${name}`)).digest())
    } catch { return { testedCommit: head, treeHash: null } }
  }
  return { testedCommit: head, treeHash: hash.digest('hex') }
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
  const others = untracked(root)
  if (others === null) return { root, error: 'git ls-files --others が失敗' }
  const hasHead = git(['rev-parse', '--verify', '-q', 'HEAD'], root) !== null
  if (!hasHead) {
    // HEAD が無い（初回commit前）: 全追跡ファイルを変更扱い
    const all = git(['ls-files'], root)
    if (all === null) return { root, error: 'git ls-files が失敗' }
    return { root, base: null, changed: uniq(all.split('\n').concat(others)) }
  }
  const diff = git(['diff', '--name-only', ref, '--'], root)
  if (diff === null) return { root, error: `git diff ${ref} が失敗` }
  return { root, base: ref === base ? base : null, changed: uniq(diff.split('\n').concat(others)) }
}

// 失敗は null（空配列ではない）。呼ぶ側は「変更なし」と区別する
function untracked(root) { const out = git(['ls-files', '--others', '--exclude-standard'], root); return out === null ? null : out.split('\n') }
function uniq(list) { return [...new Set(list.map(s => s.trim()).filter(Boolean))].sort() }

// 「最後に全部通った commit」の記録。リポジトリのルートごとに持つ。
export function statePath(env = process.env) { return join(dirname(logPath(env)), 'state.json') }
export function readState(env = process.env) {
  try { return JSON.parse(readFileSync(statePath(env), 'utf8')) } catch { return { lastFullPass: {} } }
}
export function lastFullPass(root, env = process.env) { return readState(env).lastFullPass?.[root] ?? null }
export function recordFullPass(root, env = process.env) {
  const head = git(['rev-parse', 'HEAD'], root)
  if (!head) return false
  const state = readState(env)
  state.lastFullPass = { ...(state.lastFullPass ?? {}), [root]: head.trim() }
  mkdirSync(dirname(statePath(env)), { recursive: true })
  writeFileSync(statePath(env), JSON.stringify(state, null, 2))
  return true
}
