// testgate アダプタ: .NET（dotnet test）。契約 v0.5。外部依存なし。
// 変更ファイル → 所属プロジェクト → ProjectReference の逆引き → 影響するテストプロジェクト、
// さらにプロジェクト内は「型名の言及」の逆引きで --filter（テストクラス単位）まで絞る。
// 選択のために外部コマンドは呼ばない（solution と csproj と .cs を読むだけ）。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'

export const id = 'dotnet'
export const runners = ['dotnet test']

const DEADLINE_MS = 4500
const MAX_FAILURES = 50
const MAX_TERMS = 300
const MAX_FILTER_CHARS = 7000
const MAX_SOURCE_BYTES = 160 * 1024 * 1024

// ---------- コマンドの見分け ----------

const WRAPPERS = new Set(['rtk', 'time', 'command', 'nice', 'exec'])
const HELP_FLAGS = new Set(['-h', '--help', '-?', '--version', '-t', '--list-tests'])
const VALUE_OPTS = new Set([
  '-s', '--settings', '--filter', '-a', '--test-adapter-path', '-l', '--logger', '-c', '--configuration',
  '-f', '--framework', '-r', '--runtime', '-o', '--output', '-d', '--diag', '--results-directory',
  '--collect', '-e', '--environment', '-v', '--verbosity', '--arch', '--os', '--artifacts-path',
  '--blame-crash-dump-type', '--blame-hang-dump-type', '--blame-hang-timeout', '--property',
])

function baseName(s) {
  return path.basename(String(s).replace(/\\/g, '/')).replace(/\.exe$/i, '')
}

// argv → { sub } | null。sub は test の位置。
function classify(argv) {
  if (!Array.isArray(argv)) return null
  let i = 0
  while (i < argv.length) {
    const t = argv[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++
    else if (baseName(t) === 'env' || WRAPPERS.has(baseName(t))) i++
    else break
  }
  if (argv[i] === undefined || baseName(argv[i]) !== 'dotnet') return null
  if (argv[i + 1] !== 'test') return null
  for (let k = i + 2; k < argv.length; k++) {
    if (argv[k] === '--') break
    if (HELP_FLAGS.has(argv[k])) return null
  }
  return { sub: i + 1 }
}

export function detect(argv, { cwd, env } = {}) {
  void cwd; void env
  return classify(argv) !== null
}

// ---------- 小物 ----------

const passthrough = (argv, reason) => ({ argv, mode: 'passthrough', reason })
const unavailable = (msg) => Object.assign(new Error(msg), { unavailable: true })
const toPosix = (p) => p.split(path.sep).join('/')
const WIN = process.platform === 'win32'
const K = (p) => (WIN ? p.toLowerCase() : p)

function inside(dir, file) {
  const d = dir.endsWith(path.sep) ? dir : dir + path.sep
  return file === dir || K(file).startsWith(K(d))
}

function findRoot(cwd) {
  let d = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(d, '.git'))) return d
    const up = path.dirname(d)
    if (up === d) return path.resolve(cwd)
    d = up
  }
}

const readText = (f) => readFileSync(f, 'utf8').replace(/^﻿/, '')

function globToRegex(pat) {
  let r = ''
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]
    if (c === '*') {
      if (pat[i + 1] === '*') { r += '.*'; i++; if (pat[i + 1] === '/') i++ } else r += '[^/]*'
    } else if (c === '?') r += '[^/]'
    else r += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + r + '$', WIN ? 'i' : '')
}

// ---------- 選択 ----------

export async function select({ argv, cwd = process.cwd(), env = process.env, changed, base, full } = {}) {
  void base; void env
  const kind = classify(argv)
  if (!kind) return passthrough(argv, 'dotnet test: dotnet test ではない')
  if (full) return { argv, mode: 'full', reason: 'dotnet test: 全部流す指定（TESTGATE_FULL）' }
  if (!changed || changed.length === 0) return { argv, mode: 'none', reason: 'dotnet test: 変更ファイルが無い' }
  const label = 'dotnet test: '
  try {
    const r = selectDotnet({ argv, sub: kind.sub, cwd, changed, deadline: Date.now() + DEADLINE_MS })
    return { ...r, reason: label + r.reason }
  } catch (e) {
    if (e.unavailable) return passthrough(argv, `${label}選べない: ${e.message}`)
    return { argv, mode: 'full', reason: `${label}依存の解決に失敗したので全部流す: ${e.message}` }
  }
}

// 人が何を指定したか。{ positional, hasFilter, positionalIdx, error }
function readArgs(argv, sub) {
  const pos = []
  let hasFilter = false
  for (let k = sub + 1; k < argv.length; k++) {
    const t = argv[k]
    if (t === '--') break
    if (t.startsWith('-')) {
      const nm = t.split(/[=:]/)[0]
      if (nm === '--filter') hasFilter = true
      if (!/[=:]/.test(t) && VALUE_OPTS.has(t)) k++
      continue
    }
    pos.push(k)
  }
  return { pos, hasFilter }
}

const SLN_EXT = /\.(sln|slnx|slnf)$/i
const PROJ_EXT = /\.(cs|fs|vb)proj$/i
const SOURCE_EXT = /\.(cs|xaml|axaml|razor)$/i
const GLOBAL_NAMES = new Set([
  'directory.build.props', 'directory.build.targets', 'directory.build.rsp', 'directory.packages.props',
  'global.json', 'nuget.config', '.editorconfig', 'packages.config',
])
const SKIP_DIRS = new Set(['bin', 'obj', '.git', '.vs', 'node_modules', '.idea', 'packages'])

function listSolutionProjects(slnFile) {
  const dir = path.dirname(slnFile)
  const text = readText(slnFile)
  const out = []
  if (/\.slnf$/i.test(slnFile)) {
    const j = JSON.parse(text)
    const solFile = path.resolve(dir, String(j.solution.path).replace(/\\/g, '/'))
    const sdir = path.dirname(solFile)
    for (const p of j.solution.projects ?? []) out.push(path.resolve(sdir, p.replace(/\\/g, '/')))
    return { projects: out, solutionFile: solFile }
  }
  if (/\.slnx$/i.test(slnFile)) {
    for (const m of text.matchAll(/<Project\b[^>]*?\bPath="([^"]+)"/g)) out.push(path.resolve(dir, m[1].replace(/\\/g, '/')))
  } else {
    for (const m of text.matchAll(/^Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/gm)) {
      if (PROJ_EXT.test(m[1])) out.push(path.resolve(dir, m[1].replace(/\\/g, '/')))
    }
  }
  return { projects: out, solutionFile: slnFile }
}

const TEST_PKG = /<PackageReference\b[^>]*\bInclude="(Microsoft\.NET\.Test\.Sdk|xunit|xunit\.v3|xunit\.core|NUnit|MSTest\.TestFramework|MSTest|TUnit)"/i

function parseProject(file, convTest) {
  const dir = path.dirname(file)
  const text = readText(file)
  const refs = []
  for (const m of text.matchAll(/<ProjectReference\b[^>]*?\bInclude\s*=\s*"([^"]+)"/g)) {
    const v = m[1].replace(/\\/g, '/').replace(/\$\(MSBuildThisFileDirectory\)/g, toPosix(dir) + '/')
    if (v.includes('$(')) continue
    refs.push(path.resolve(dir, v))
  }
  const isTest =
    /<IsTestProject>\s*true/i.test(text) || TEST_PKG.test(text) || /Sdk="MSTest\.Sdk/i.test(text) ||
    (convTest && /tests?(\.|$)/i.test(path.basename(file, path.extname(file))))
  // プロジェクトの外にあるファイルを取り込む Include・Update・Import
  const extras = []
  const skipEl = new Set(['PackageReference', 'ProjectReference', 'Reference', 'FrameworkReference', 'Using', 'InternalsVisibleTo', 'AssemblyAttribute'])
  for (const m of text.matchAll(/<(\w+)\b[^>]*?\b(?:Include|Update|Project)\s*=\s*"([^"]*)"/g)) {
    if (skipEl.has(m[1])) continue
    for (const raw of m[2].split(';')) {
      let v = raw.trim().replace(/\\/g, '/')
      if (!v) continue
      v = v.replace(/\$\((?:MSBuildThisFileDirectory|MSBuildProjectDirectory)\)\/?/g, toPosix(dir) + '/')
      const hasVar = v.includes('$(')
      v = v.replace(/\$\([^)]*\)/g, '**')
      const abs = path.isAbsolute(v) || /^[A-Za-z]:\//.test(v) ? v : toPosix(path.resolve(dir, v))
      const outside = hasVar || v.startsWith('..') || !inside(toPosix(dir), abs)
      if (outside) extras.push(abs)
    }
  }
  return { file, dir, refs, isTest, extras, text }
}

function* walk(dir, skipDirs) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name.toLowerCase()) || skipDirs.has(K(p))) continue
      yield* walk(p, skipDirs)
    } else yield p
  }
}

// ----- C# の宣言・基底型・拡張メソッドの読み取り -----

function skipString(t, i) {
  const n = t.length
  let interp = false, verbatim = false
  while (t[i] === '$' || t[i] === '@') { if (t[i] === '$') interp = true; else verbatim = true; i++ }
  if (t.startsWith('"""', i)) {
    let q = 0
    while (t[i + q] === '"') q++
    const close = '"'.repeat(q)
    const e = t.indexOf(close, i + q)
    return e < 0 ? n : e + q
  }
  i++ // 開きの "
  while (i < n) {
    const c = t[i]
    if (verbatim) {
      if (c === '"') { if (t[i + 1] === '"') { i += 2; continue } return i + 1 }
    } else if (c === '\\') { i += 2; continue }
    else if (c === '"') return i + 1
    else if (c === '\n') return i + 1
    if (interp && c === '{') {
      if (t[i + 1] === '{') { i += 2; continue }
      let depth = 1
      i++
      while (i < n && depth > 0) {
        const d = t[i]
        if (d === '"' || ((d === '$' || d === '@') && (t[i + 1] === '"' || t[i + 1] === '$' || t[i + 1] === '@'))) { i = skipString(t, i); continue }
        if (d === "'" && t[i + 2] === "'") { i += 3; continue }
        if (d === '{') depth++
        else if (d === '}') depth--
        i++
      }
      continue
    }
    i++
  }
  return n
}

const NOT_NAMES = new Set(['is', 'as', 'in', 'out', 'with', 'where', 'new', 'and', 'or', 'not', 'when', 'switch', 'from', 'select', 'Equals'])
const DECL = /\bnamespace\s+([\w.]+)\s*([;{])|\b(class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+@?([A-Za-z_]\w*)|[{};]/g

function parseBases(s, pos) {
  const n = s.length
  let end = pos
  while (end < n && s[end] !== '{' && s[end] !== ';') end++
  let r = s.slice(pos, end)
  // 型パラメータ <...> と主コンストラクタ・基底の引数 (...) を、入れ子ごと落とす
  const strip = (str, open, close) => {
    let d = 0, o = ''
    for (const c of str) {
      if (c === open) d++
      else if (c === close) { if (d > 0) d-- }
      else if (d === 0) o += c
    }
    return o
  }
  r = strip(strip(r, '(', ')'), '<', '>')
  const w = r.search(/\bwhere\b/)
  if (w >= 0) r = r.slice(0, w)
  const c = r.indexOf(':')
  if (c < 0) return []
  return r
    .slice(c + 1)
    .split(',')
    .map((b) => b.trim().split(/\s+/)[0] ?? '')
    .map((b) => b.split('.').pop())
    .filter((b) => /^[A-Za-z_]\w*$/.test(b))
}

// 構造の読み取り用 s（コメント・文字列の中身を空白にする）と、言及の読み取り用 mention
// （コメントだけ空白にし、文字列は補間式のコードを残す）を、同じ長さで返す。
function maskCs(t) {
  const n = t.length
  const a = []
  const b = []
  const blank = (x) => x.replace(/[^\n]/g, ' ')
  let i = 0
  while (i < n) {
    const c = t[i], d = t[i + 1]
    if (c === '/' && d === '/') {
      let j = i
      while (j < n && t[j] !== '\n') j++
      const sp = ' '.repeat(j - i); a.push(sp); b.push(sp); i = j; continue
    }
    if (c === '/' && d === '*') {
      const e = t.indexOf('*/', i + 2)
      const j = e < 0 ? n : e + 2
      const sp = blank(t.slice(i, j)); a.push(sp); b.push(sp); i = j; continue
    }
    if (c === '"' || ((c === '$' || c === '@') && (d === '"' || ((d === '$' || d === '@') && t[i + 2] === '"')))) {
      const j = skipString(t, i)
      const seg = t.slice(i, j)
      b.push(seg)
      a.push('"' + blank(seg.slice(1, -1)) + (seg.length > 1 ? '"' : ''))
      i = j; continue
    }
    if (c === "'") {
      let j = i + 1
      if (t[j] === '\\') j += 2; else j++
      let guard = 0
      while (j < n && t[j] !== "'" && guard++ < 10) j++
      const seg = t.slice(i, j + 1)
      b.push(seg)
      a.push("'" + ' '.repeat(Math.max(0, seg.length - 2)) + (seg.length > 1 ? "'" : ''))
      i = j + 1; continue
    }
    a.push(c); b.push(c); i++
  }
  return { s: a.join(''), mention: b.join('') }
}

function scanCs(text) {
  const { s, mention } = maskCs(text)
  const names = new Set()
  const bases = new Set()
  const tops = []
  const spans = [] // 最上位の型ごと: { top, start, end, names, bases }
  const stack = []
  let fileNs = ''
  let pending = null
  let cur = null
  let segStart = 0
  DECL.lastIndex = 0
  let m
  while ((m = DECL.exec(s))) {
    if (m[1] !== undefined) {
      if (m[2] === ';') fileNs = m[1]
      else pending = { t: 'ns', name: m[1] }
      if (cur === null) segStart = m.index + m[0].length
      if (m[2] === '{') { stack.push(pending); pending = null }
      continue
    }
    if (m[4] !== undefined) {
      const name = m[4]
      if (NOT_NAMES.has(name)) continue
      const bs = parseBases(s, DECL.lastIndex)
      for (const b of bs) bases.add(b)
      const parent = [...stack].reverse().find((f) => f.t === 'type')
      const nested = parent !== undefined
      // 入れ子の private 型（既定も private）の名前は、外側の最上位の型の外から参照できない。
      // 別ファイルの同名の入れ子型と取り違えないよう、他のファイルの言及先に数えない。
      let priv = false
      if (nested) {
        const mods = (/((?:\b(?:public|private|protected|internal|static|sealed|abstract|partial|readonly|ref|unsafe|new|file|unmanaged)\s+)*)$/.exec(s.slice(Math.max(0, m.index - 120), m.index)) ?? ['', ''])[1]
        const explicit = /\b(?:public|internal|protected)\b/.test(mods)
        priv = parent.priv || (parent.kind !== 'interface' && !explicit)
      }
      pending = { t: 'type', name, span: null, kind: m[3], priv }
      if (!priv) names.add(name)
      if (!nested) {
        const ns = [fileNs, ...stack.filter((f) => f.t === 'ns').map((f) => f.name)].filter(Boolean).join('.')
        const top = ns ? `${ns}.${name}` : name
        tops.push(top)
        cur = { top, start: segStart, end: s.length, names: new Set(), bases: new Set(), priv: new Set() }
        spans.push(cur)
        pending.span = cur
      }
      if (cur) {
        if (!priv) cur.names.add(name)
        else cur.priv.add(name)
        for (const b of bs) cur.bases.add(b)
      }
      continue
    }
    const c = m[0]
    if (c === '{') { stack.push(pending ?? { t: 'b' }); pending = null }
    else if (c === '}') {
      const f = stack.pop()
      if (f && f.span) { f.span.end = m.index + 1; segStart = f.span.end; cur = null }
    } else if (c === ';') {
      if (pending && pending.span) { pending.span.end = m.index + 1; segStart = pending.span.end; cur = null }
      pending = null
    }
  }
  for (const x of s.matchAll(/\b([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(\s*(?:\[[^\]]*\]\s*)?this\s+[\w.<>?[\],\s]+?\s+\w+/g)) {
    names.add(x[1])
    const sp = spans.find((q) => x.index >= q.start && x.index < q.end)
    if (sp) sp.names.add(x[1])
  }
  const lastEnd = spans.length ? spans[spans.length - 1].end : 0
  const ns = []
  for (const sp of spans) ns.push({ top: sp.top, names: sp.names, bases: sp.bases, priv: sp.priv, text: mention.slice(sp.start, sp.end) })
  return { names, bases, tops, nodes: ns, wide: mention.slice(lastEnd), mention }
}

function scanMarkup(text, file) {
  const names = new Set()
  const tops = []
  const m = /x:Class\s*=\s*"([^"]+)"/.exec(text)
  if (m) { names.add(m[1].split('.').pop()); tops.push(m[1]) }
  else names.add(path.basename(file).replace(/\..*$/, ''))
  return { names, bases: new Set(), tops, nodes: null, wide: '' }
}

// ----- 本体 -----

function selectDotnet({ argv, sub, cwd, changed, deadline }) {
  const tick = () => { if (Date.now() > deadline) throw unavailable('解決が5秒の上限に近い') }
  const { pos, hasFilter } = readArgs(argv, sub)
  if (hasFilter) return passthrough(argv, '--filter が指定済み（人が絞っているので触らない）')
  if (pos.length > 1) return passthrough(argv, '引数が複数あり書き換えない')
  const root = findRoot(cwd)
  const files = changed.map((p) => path.resolve(root, p))

  // 対象の特定
  let target = null // { solution?: file, project?: file }
  let searchDir = path.resolve(cwd)
  if (pos.length === 1) {
    const arg = path.resolve(cwd, argv[pos[0]])
    let st = null
    try { st = statSync(arg) } catch { /* 無い */ }
    if (!st) return passthrough(argv, `${argv[pos[0]]} が見つからない`)
    if (st.isDirectory()) searchDir = arg
    else if (SLN_EXT.test(arg)) target = { solution: arg }
    else return passthrough(argv, 'プロジェクトやdllが名指しされている（人が絞っているので触らない）')
  }
  if (!target) {
    const ents = readdirSync(searchDir).filter((n) => statSync(path.join(searchDir, n)).isFile())
    const slns = ents.filter((n) => /\.(sln|slnx)$/i.test(n))
    const projs = ents.filter((n) => PROJ_EXT.test(n))
    if (slns.length === 1 && projs.length === 0) target = { solution: path.join(searchDir, slns[0]) }
    else if (slns.length === 0 && projs.length === 1) target = { project: path.join(searchDir, projs[0]) }
    else if (slns.length === 0 && projs.length === 0) return passthrough(argv, 'solution もプロジェクトも見つからない')
    else return passthrough(argv, 'solution かプロジェクトが複数あり、dotnet が決められない')
  }

  // 範囲（universe）の読み込み
  const convTestCache = new Map()
  const convTest = (dir) => {
    let d = dir
    for (;;) {
      for (const n of ['Directory.Build.props', 'Directory.Build.targets']) {
        const f = path.join(d, n)
        if (!convTestCache.has(f)) convTestCache.set(f, existsSync(f) && /IsTestProject|Microsoft\.NET\.Test\.Sdk/.test(readText(f)))
        if (convTestCache.get(f)) return true
      }
      const up = path.dirname(d)
      if (up === d || !inside(root, up)) return false
      d = up
    }
  }
  let solutionFile = null
  const universe = new Map() // K(file) → project
  let scopeFiles
  if (target.solution) {
    const sl = listSolutionProjects(target.solution)
    solutionFile = sl.solutionFile
    scopeFiles = sl.projects
  } else scopeFiles = [target.project]
  const queue = [...scopeFiles]
  while (queue.length) {
    const f = queue.pop()
    if (universe.has(K(f)) || !existsSync(f)) continue
    const p = parseProject(f, convTest(path.dirname(f)))
    universe.set(K(f), p)
    for (const r of p.refs) queue.push(r)
  }
  tick()
  const projects = [...universe.values()]
  const scope = scopeFiles.map((f) => universe.get(K(f))).filter((p) => p && p.isTest)
  if (scope.length === 0) return passthrough(argv, 'テストプロジェクトが見つからない')
  if (target.project && !scope.includes(universe.get(K(target.project)))) return passthrough(argv, 'テストプロジェクトではない')

  const rev = new Map()
  for (const p of projects) {
    for (const r of p.refs) {
      const q = universe.get(K(r))
      if (!q) continue
      if (!rev.has(q)) rev.set(q, new Set())
      rev.get(q).add(p)
    }
  }
  const closureOf = (start) => {
    const q = [...start]
    const seen = new Set(q)
    while (q.length) for (const up of rev.get(q.pop()) ?? []) if (!seen.has(up)) { seen.add(up); q.push(up) }
    return seen
  }

  // 他のプロジェクトのディレクトリを入れ子で持つ時は、深い方を所有者にする
  const dirs = projects.map((p) => ({ p, dir: p.dir }))
  const extraRes = projects.map((p) => ({ p, res: p.extras.map((e) => globToRegex(e)) }))
  const ownersOf = (f) => {
    let best = null
    for (const d of dirs) if (inside(d.dir, f) && (!best || d.dir.length > best.dir.length)) best = d
    const out = new Set(best ? [best.p] : [])
    const pf = toPosix(f)
    for (const e of extraRes) if (e.res.some((r) => r.test(pf))) out.add(e.p)
    return out
  }

  // 変更の分類
  const changedInfo = new Map() // project → { unfiltered: string|null }
  const starts = []
  const mark = (p) => { if (!changedInfo.has(p)) changedInfo.set(p, { unfiltered: null }); return changedInfo.get(p) }
  const rel = (f) => toPosix(path.relative(root, f))
  for (const f of files) {
    const nm = path.basename(f)
    if (GLOBAL_NAMES.has(nm.toLowerCase()) && projects.some((p) => inside(path.dirname(f), p.dir))) {
      return { argv, mode: 'full', reason: `全体へ効く変更（${rel(f)}）` }
    }
    if (SLN_EXT.test(nm)) {
      if (solutionFile && K(f) === K(solutionFile)) return { argv, mode: 'full', reason: `solution の変更（${rel(f)}）` }
      continue
    }
    const owners = ownersOf(f)
    if (owners.size === 0) {
      if (/\.(props|targets|rsp|ruleset)$/i.test(nm) && inside(root, f)) {
        return { argv, mode: 'full', reason: `どのプロジェクトが取り込むか分からないビルド設定の変更（${rel(f)}）` }
      }
      continue
    }
    let skipped = true
    for (const p of owners) {
      const r = toPosix(path.relative(p.dir, f))
      if (!r.startsWith('..') && r.split('/').some((s) => s === 'bin' || s === 'obj')) continue
      if (/\.(md|markdown)$/i.test(nm)) continue
      skipped = false
      const info = mark(p)
      if (SOURCE_EXT.test(nm) && existsSync(f)) starts.push(f)
      else if (!info.unfiltered) {
        info.unfiltered = !existsSync(f) ? `${nm} が削除された（宣言を読めない）` : `${nm} はクラスへ分けられない変更`
      }
    }
    void skipped
  }
  if (changedInfo.size === 0) return { argv, mode: 'none', reason: '変更はどのプロジェクトにも属さない（README等）' }

  const names = (set) => [...set].map((p) => path.basename(p.file).replace(/\.\w+proj$/i, '')).sort().join(',')
  const affected = closureOf(changedInfo.keys())
  const picked0 = scope.filter((p) => affected.has(p))
  if (picked0.length === 0) {
    return { argv, mode: 'none', reason: `変更プロジェクト(${names(changedInfo.keys())})の影響が実行範囲のテストプロジェクトに届かない` }
  }

  // 各テストプロジェクトを絞れるか
  const unfilteredWhy = new Map() // テストプロジェクト → 理由
  if (process.env.TESTGATE_DOTNET_NOFILTER) for (const t of picked0) unfilteredWhy.set(t, '絞り込みを止める指定（TESTGATE_DOTNET_NOFILTER）')
  for (const [p, info] of changedInfo) {
    if (!info.unfiltered) continue
    for (const t of closureOf([p])) if (picked0.includes(t) && !unfilteredWhy.has(t)) unfilteredWhy.set(t, `${path.basename(p.file)} 側: ${info.unfiltered}`)
  }
  const needGraph = picked0.some((t) => !unfilteredWhy.has(t))
  const termsOf = new Map()
  const coversAll = new Set()
  if (needGraph) {
    const fileInfo = new Map() // file → { owners, names, bases, tops, text }
    let bytes = 0
    const nestedDirs = new Set(dirs.map((d) => K(d.dir)))
    for (const p of projects) {
      const skip = new Set([...nestedDirs].filter((d) => d !== K(p.dir) && d.startsWith(K(p.dir) + path.sep)))
      const add = (f) => {
        if (!SOURCE_EXT.test(f)) return
        let fi = fileInfo.get(K(f))
        if (!fi) {
          const text = readText(f)
          bytes += text.length
          if (bytes > MAX_SOURCE_BYTES) throw unavailable('ソースが大きすぎて読み切れない')
          const sc = /\.cs$/i.test(f) ? scanCs(text) : scanMarkup(text, f)
          fi = { file: f, owners: new Set(), text: sc.mention ?? text, ...sc }
          fileInfo.set(K(f), fi)
        }
        fi.owners.add(p)
      }
      for (const f of walk(p.dir, skip)) add(f)
      for (const e of p.extras) {
        const re = globToRegex(e)
        const firstWild = e.search(/[*?]/)
        const baseDir = firstWild < 0 ? path.dirname(e) : e.slice(0, firstWild).replace(/\/[^/]*$/, '') || '/'
        for (const f of walk(path.resolve(baseDir), new Set())) if (re.test(toPosix(f))) add(f)
        if (firstWild < 0 && existsSync(e)) add(path.resolve(e))
      }
      tick()
    }
    // 波及は型（最上位の宣言）単位。型が読めないファイルはファイル全体で1つのノードにする。
    const USING = /\busing\s+(?:static\s+)?(?:[\w.]+\s*=\s*)?[\w.<>?,\s[\]]+;/g
    const ID = /[A-Za-z_]\w*/g
    const all = []
    const nodesOf = new Map() // file record → nodes
    for (const fi of fileInfo.values()) {
      const list = []
      if (fi.nodes && fi.nodes.length > 0) {
        // using 指令と最後の型より後ろは、ファイル全体へ効く言及として全ノードへ足す
        const wide = new Set()
        const bodies = fi.nodes.map((n) => n.text.replace(USING, (u) => { for (const x of u.matchAll(ID)) wide.add(x[0]); return ' ' }))
        for (const x of fi.wide.matchAll(ID)) wide.add(x[0])
        fi.nodes.forEach((n, i) => {
          list.push({ file: fi.file, owners: fi.owners, names: n.names, bases: n.bases, tops: [n.top], body: bodies[i], wide, hasPriv: n.priv.size > 0 })
        })
      } else {
        list.push({ file: fi.file, owners: fi.owners, names: fi.names, bases: fi.bases, tops: fi.tops, body: fi.text, wide: new Set() })
      }
      fi.text = ''
      nodesOf.set(fi, list)
      all.push(...list)
    }
    const declarers = new Map()
    for (const nd of all) for (const n of nd.names) { if (!declarers.has(n)) declarers.set(n, new Set()); declarers.get(n).add(nd) }
    const mentioners = new Map()
    for (const nd of all) {
      const ids = new Set(nd.wide)
      for (const m of nd.body.matchAll(ID)) ids.add(m[0])
      for (const id of ids) {
        if (!declarers.has(id)) continue
        if (!mentioners.has(id)) mentioners.set(id, new Set())
        mentioners.get(id).add(nd)
      }
      nd.body = ''
    }
    tick()
    const siblings = new Map() // 最上位の型の完全名 → ノード（private の入れ子型を持つ partial だけ）
    for (const nd of all) if (nd.hasPriv) { const k = nd.tops[0]; if (!siblings.has(k)) siblings.set(k, new Set()); siblings.get(k).add(nd) }
    for (const nd of all) if (nd.tops.length === 1 && siblings.has(nd.tops[0])) siblings.get(nd.tops[0]).add(nd)
    const testOwned = (nd) => nd.owners.size > 0 && [...nd.owners].every((p) => p.isTest)
    const seen = new Set()
    const q = []
    for (const f of starts) {
      const rec = fileInfo.get(K(f))
      for (const nd of rec ? nodesOf.get(rec) : []) if (!seen.has(nd)) { seen.add(nd); q.push(nd) }
    }
    const reach = (set) => { for (const x of set ?? []) if (!seen.has(x)) { seen.add(x); q.push(x) } }
    while (q.length) {
      const fi = q.pop()
      const testOnly = testOwned(fi)
      if (fi.tops.length === 1 && siblings.has(fi.tops[0])) reach(siblings.get(fi.tops[0]))
      // テストだけが所有するノードの宣言は本体から参照できない。本体側の同名の識別子は別物なので、受け手をテスト側へ限る。
      for (const n of fi.names) for (const x of mentioners.get(n) ?? []) if (!testOnly || testOwned(x)) reach([x])
      // テストだけが所有するノードの基底（test double の実装先）からは、本体側へ逆流させない。
      // 基底の宣言もテストだけが持つ時（テスト共有の interface）は残す。
      for (const b of fi.bases) {
        if (!declarers.has(b)) continue
        if (testOnly && ![...declarers.get(b)].every(testOwned)) continue
        reach(mentioners.get(b))
      }
    }
    for (const t of picked0) {
      if (unfilteredWhy.has(t)) continue
      const terms = new Set()
      const allTops = new Set()
      let opaque = null
      for (const fi of all) {
        if (!fi.owners.has(t)) continue
        for (const x of fi.tops) allTops.add(x)
        if (!seen.has(fi)) continue
        if (fi.tops.length === 0 && !/\.(xaml|axaml)$/i.test(fi.file)) opaque = path.basename(fi.file)
        for (const x of fi.tops) terms.add(x)
      }
      if (opaque) unfilteredWhy.set(t, `${opaque} に型の宣言が読めない`)
      else {
        termsOf.set(t, terms)
        if (terms.size === allTops.size && terms.size > 0) coversAll.add(t)
      }
    }
  }

  // 言及が無く、流すテストの無いプロジェクトは落とす
  const picked = picked0.filter((t) => unfilteredWhy.has(t) || (termsOf.get(t)?.size ?? 0) > 0)
  if (picked.length === 0) {
    return { argv, mode: 'none', reason: `変更(${names(changedInfo.keys())})を参照するテストクラスが無い（型名の言及が届かない）` }
  }
  const hard = picked.filter((t) => unfilteredWhy.has(t))
  const narrowed = picked.filter((t) => termsOf.has(t) && !coversAll.has(t))
  let useFilter = narrowed.length > 0 && hard.length === 0
  let whyNoFilter = null
  if (narrowed.length > 0 && hard.length > 0) {
    whyNoFilter = `${names(hard)} は絞れない（${unfilteredWhy.get(hard[0])}）ので、同じ実行の他も絞らない`
  }
  let terms = []
  if (useFilter) for (const t of picked) terms.push(...termsOf.get(t))
  terms = [...new Set(terms)].sort()
  const expr = terms.map((x) => `FullyQualifiedName~${x}`).join('|')
  if (useFilter && (terms.length > MAX_TERMS || expr.length > MAX_FILTER_CHARS || terms.some((x) => !/^[\w.]+$/.test(x)))) {
    useFilter = false
    whyNoFilter = `フィルタが長すぎる／特殊な名前を含む（クラス${terms.length}件）ので絞らない`
  }

  if (picked.length === scope.length && !useFilter) {
    const why = whyNoFilter ?? [...unfilteredWhy.values()][0] ?? '影響がテストクラスの全部に及ぶ'
    const single = scope.length === 1
    return {
      argv,
      mode: 'full',
      reason: single
        ? `変更(${names(changedInfo.keys())}): 単一テストプロジェクトで、テストクラス単位の絞りも効かない（全部流す）: ${why}`
        : `変更(${names(changedInfo.keys())}): 影響が実行範囲の全体に及ぶ（選べたが全部）`,
    }
  }

  // argv の組み立て
  const drop = new Set(pos)
  const head = []
  if (picked.length === scope.length && target.solution) head.push(argv[pos[0]] ?? null)
  else if (picked.length === 1) head.push(toPosix(path.relative(cwd, picked[0].file)) || picked[0].file)
  else head.push(writeSlnf(solutionFile, picked))
  const insert = head.filter((x) => x !== null)
  if (useFilter) insert.push('--filter', expr)
  const out = []
  for (let k = 0; k < argv.length; k++) {
    if (!drop.has(k)) out.push(argv[k])
    if (k === sub) out.push(...insert)
  }
  const parts = [`影響テストプロジェクト(${names(picked)})`]
  if (useFilter) parts.push(`テストクラス${terms.length}件を --filter で指定`)
  else if (whyNoFilter) parts.push(whyNoFilter)
  return {
    argv: out,
    mode: 'subset',
    reason: `変更(${names(changedInfo.keys())}) → ${parts.join('、')}`,
  }
}

// 複数のテストプロジェクトを一度に流すための solution filter（一時ディレクトリへ置く）。
function writeSlnf(solutionFile, picked) {
  const sdir = path.dirname(solutionFile)
  const body = {
    solution: {
      path: solutionFile,
      projects: picked.map((p) => path.relative(sdir, p.file).split(path.sep).join('\\')).sort(),
    },
  }
  const json = JSON.stringify(body, null, 2)
  const dir = path.join(tmpdir(), 'testgate-dotnet')
  mkdirSync(dir, { recursive: true })
  const f = path.join(dir, createHash('sha1').update(json).digest('hex').slice(0, 16) + '.slnf')
  writeFileSync(f, json)
  return f
}

// ---------- 結果の読み取り ----------

const SUMMARY = /^\s*(?:Passed|Failed)!\s+- Failed:\s*(\d+), Passed:\s*(\d+), Skipped:\s*(\d+), Total:\s*(\d+), Duration:\s*(.*?)(?: - \S.*)?$/
const FAILED_TEST = /^\s*Failed\s+(\S.*?)\s+\[(?:<\s*)?[\d.,]+\s*(?:ms|s|m|h)(?:\s+[\d.,]+\s*(?:ms|s))?\]\s*$/
const XUNIT_FAIL = /^\[xUnit\.net [\d:.]+\]\s+(\S.*?) \[FAIL\]\s*$/
const BUILD_ERROR = /^(.*?)(?:\((\d+),(\d+)\))?:\s*error ([A-Z]+\d+):\s*(.*?)(?:\s+\[([^\]]+)\])?\s*$/

function durationMs(s) {
  let ms = 0
  let any = false
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(ms|h|m|s)\b/g)) {
    any = true
    const v = parseFloat(m[1].replace(',', '.'))
    ms += m[2] === 'ms' ? v : m[2] === 's' ? v * 1000 : m[2] === 'm' ? v * 60000 : v * 3600000
  }
  return any ? Math.round(ms) : undefined
}

function pushFail(list, name) {
  if (name && list.length < MAX_FAILURES && !list.includes(name)) list.push(name)
}

export function parseOutput(text) {
  const out = {}
  if (typeof text !== 'string' || text === '') return out
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const failures = []
  let sp = 0, sf = 0, ss = 0, sMs = 0, sumSeen = false, sumTime = false
  let rtk = null
  let rtkMs
  let inRtkFailed = false
  const buildKeys = new Set()
  const buildPlaces = []
  let aborted = 0
  const old = {}

  for (const raw of lines) {
    const line = raw.trimEnd()
    let m
    if ((m = SUMMARY.exec(line))) {
      sumSeen = true
      sf += +m[1]; sp += +m[2]; ss += +m[3]
      const d = durationMs(m[5])
      if (d !== undefined || /<\s*1\s*ms/.test(m[5])) { sMs += d ?? 0; sumTime = true }
      continue
    }
    if ((m = /^(ok|fail) dotnet test: (.*)$/.exec(line))) {
      inRtkFailed = false
      const body = m[2]
      rtk = rtk ?? { passed: 0, failed: 0, skipped: 0 }
      let t
      if ((t = /(\d+)\s+tests?\s+passed/.exec(body))) rtk.passed += +t[1]
      else if ((t = /(\d+)\s+passed/.exec(body))) rtk.passed += +t[1]
      if ((t = /(\d+)\s+failed/.exec(body))) rtk.failed += +t[1]
      if ((t = /(\d+)\s+skipped/.exec(body))) rtk.skipped += +t[1]
      if ((t = /\(([^)]*)\)\s*$/.exec(body))) rtkMs = durationMs(t[1])
      continue
    }
    if (/^Failed Tests:\s*$/.test(line)) { inRtkFailed = true; continue }
    if (inRtkFailed) {
      if ((m = /^ {2}(\S.*)$/.exec(raw)) && !/^\s*(Error Message|Stack Trace|Results File)/.test(raw)) { pushFail(failures, m[1].trim()); continue }
      if (line.trim() === '' || /^\s{3,}/.test(raw)) continue
      inRtkFailed = false
    }
    if ((m = FAILED_TEST.exec(line)) && !/^\s*Failed!/.test(line)) { pushFail(failures, m[1]); continue }
    if ((m = XUNIT_FAIL.exec(line))) { pushFail(failures, m[1]); continue }
    if ((m = BUILD_ERROR.exec(line))) {
      const key = m[6] ?? `${m[4]}|${m[1]}|${m[2] ?? ''}|${m[5]}`
      if (!buildKeys.has(key)) {
        buildKeys.add(key)
        buildPlaces.push(`${path.basename(m[1].replace(/\\/g, '/'))}${m[2] ? `(${m[2]},${m[3]})` : ''}: ${m[4]}`)
      }
      continue
    }
    if (/^Test Run Aborted\./.test(line) || /^The active test run was aborted\./.test(line)) { aborted++; continue }
    if ((m = /^\s*Total tests:\s*(\d+)/.exec(line))) { old.total = +m[1]; continue }
    if ((m = /^\s+Passed:\s*(\d+)/.exec(line))) { old.passed = +m[1]; continue }
    if ((m = /^\s+Failed:\s*(\d+)/.exec(line))) { old.failed = +m[1]; continue }
    if ((m = /^\s+Skipped:\s*(\d+)/.exec(line))) { old.skipped = +m[1]; continue }
    if ((m = /^\s*Total time:\s*(.*)$/.exec(line))) { old.ms = durationMs(m[1].replace(/Seconds?/i, 's').replace(/Minutes?/i, 'm')); continue }
  }

  if (sumSeen) {
    out.passed = sp; out.failed = sf; out.skipped = ss
    if (sumTime) out.durationMs = sMs
  } else if (rtk) {
    out.passed = rtk.passed; out.failed = rtk.failed; out.skipped = rtk.skipped
    if (rtkMs !== undefined) out.durationMs = rtkMs
  } else if (old.total !== undefined) {
    out.passed = old.passed ?? 0; out.failed = old.failed ?? 0; out.skipped = old.skipped ?? 0
    if (old.ms !== undefined) out.durationMs = old.ms
  }
  const errors = buildKeys.size + aborted
  if (errors) {
    out.errors = errors
    out.failed = (out.failed ?? 0) + errors
    for (const p of buildPlaces) pushFail(failures, p)
  }
  if (failures.length) out.failures = failures.slice(0, MAX_FAILURES)
  return out
}

// ---------- 件数行の除去 ----------

export function stripCounts(text) {
  if (typeof text !== 'string') return ''
  const kept = []
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd()
    let m
    if (/^\s*Passed!\s+- Failed:/.test(line)) continue
    if ((m = /^\s*Failed!\s+- Failed:.*? - (\S.*)$/.exec(line))) { kept.push(`Failed! - ${m[1]}`); continue }
    if (/^\s*Failed!\s+- Failed:/.test(line)) { kept.push('Failed!'); continue }
    if (/^A total of \d+ test files? matched/.test(line)) continue
    if (/^\s*Passed\s+\S.*\[[^\]]*\]\s*$/.test(line)) continue
    if (/^ok dotnet test:/.test(line)) continue
    if (/^fail dotnet test:/.test(line)) { kept.push('fail dotnet test'); continue }
    if (/^\s*Total tests:\s*\d+/.test(line)) continue
    if (/^\s+(Passed|Failed|Skipped):\s*\d+\s*$/.test(line)) continue
    if (/^\s*Total time:/.test(line)) continue
    kept.push(raw)
  }
  const out = []
  for (const l of kept) {
    if (l.trim() === '' && (out.length === 0 || out[out.length - 1].trim() === '')) continue
    out.push(l)
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out.join('\n') + (out.length ? '\n' : '')
}
