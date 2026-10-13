// testgate アダプタ: Rust（cargo test）と Go（go test）。契約 v0.1。外部依存なし。
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const id = 'rustgo'
export const runners = ['cargo test', 'go test']

const DEADLINE_MS = 4500
const MAX_FAILURES = 50

// ---------- コマンドの見分け ----------

const CARGO_VALUE_GLOBALS = new Set(['-Z', '--config', '-C', '--color', '--manifest-path'])
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-V', '-help', '-version'])
const WRAPPERS = new Set(['rtk', 'time', 'command', 'nice', 'exec'])

function baseName(s) {
  return path.basename(s.replace(/\\/g, '/')).replace(/\.exe$/i, '')
}

// argv → { tool, sub } | null。sub は test サブコマンドの位置。
function classify(argv) {
  if (!Array.isArray(argv)) return null
  let i = 0
  while (i < argv.length) {
    const t = argv[i]
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) i++
    else if (baseName(t) === 'env' || WRAPPERS.has(baseName(t))) i++
    else break
  }
  const tool = argv[i] === undefined ? '' : baseName(argv[i])
  if (tool === 'cargo') {
    let j = i + 1
    while (j < argv.length) {
      const t = argv[j]
      if (t.startsWith('+')) j++
      else if (CARGO_VALUE_GLOBALS.has(t)) j += 2
      else if (t.startsWith('-')) j++
      else break
    }
    if (argv[j] !== 'test' && argv[j] !== 't') return null
    if (hasHelp(argv, j + 1)) return null
    return { tool: 'cargo', sub: j }
  }
  if (tool === 'go') {
    if (argv[i + 1] !== 'test') return null
    if (hasHelp(argv, i + 2)) return null
    return { tool: 'go', sub: i + 1 }
  }
  return null
}

// テストを走らせない呼び方（--help、--version、--list、go test -list / -c）
function hasHelp(argv, from) {
  for (let k = from; k < argv.length; k++) {
    const t = argv[k]
    if (HELP_FLAGS.has(t) || t === '--list' || t === '-list' || t.startsWith('-list=') || t === '-c') return true
    if (t === '-args') return false
  }
  return false
}

export function detect(argv, { cwd, env } = {}) {
  void cwd; void env
  return classify(argv) !== null
}

// ---------- 外部コマンド ----------

function makeRunner(cwd, env) {
  const deadline = Date.now() + DEADLINE_MS
  return (cmd, args, opts = {}) =>
    new Promise((resolve, reject) => {
      const left = deadline - Date.now()
      if (left < 100) return reject(unavailable('依存解決が5秒の上限に近い'))
      execFile(
        cmd,
        args,
        { cwd: opts.cwd ?? cwd, env: opts.env ?? env, timeout: left, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err) {
            if (err.code === 'ENOENT') return reject(unavailable(`${cmd} が見つからない`))
            if (err.killed) return reject(unavailable(`${cmd} が時間内に終わらない`))
            const first = String(stderr || err.message).split('\n').find((l) => l.trim()) || err.message
            return reject(new Error(`${cmd} ${args[0]} が失敗: ${first.trim()}`))
          }
          resolve(stdout)
        },
      )
    })
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

function inside(dir, file) {
  return file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
}

const passthrough = (argv, reason) => ({ argv, mode: 'passthrough', reason })
const unavailable = (msg) => Object.assign(new Error(msg), { unavailable: true })

// ---------- 選択 ----------

export async function select({ argv, cwd = process.cwd(), env = process.env, changed, base, full } = {}) {
  void base
  const kind = classify(argv)
  if (!kind) return passthrough(argv, 'cargo test / go test ではない')
  if (full) return { argv, mode: 'full', reason: '全部流す指定（TESTGATE_FULL）' }
  if (!changed || changed.length === 0) return { argv, mode: 'none', reason: '変更ファイルが無い' }
  const root = findRoot(cwd)
  const files = changed.map((p) => path.resolve(root, p))
  const run = makeRunner(cwd, env)
  const label = `${kind.tool} test: `
  try {
    const r =
      kind.tool === 'cargo'
        ? await selectCargo({ argv, sub: kind.sub, cwd, files, run })
        : await selectGo({ argv, sub: kind.sub, cwd, env, files, run })
    return { ...r, reason: label + r.reason }
  } catch (e) {
    // 道具が無い・時間切れは判断しない。それ以外の解決失敗は取りこぼしより流し過ぎを選ぶ。
    if (e.unavailable) return passthrough(argv, `${label}選べない: ${e.message}`)
    return { argv, mode: 'full', reason: `${label}依存の解決に失敗したので全部流す: ${e.message}` }
  }
}

// ----- cargo -----

const CARGO_NAMED_TARGET = new Set(['--test', '--bench', '--example', '--bin'])
const CARGO_VALUE_FLAGS = new Set([
  '--exclude', '--manifest-path', '--features', '-F', '--target', '--target-dir', '-j', '--jobs', '--profile',
  '--message-format', '--color', '--config', '-Z', '--lockfile-path', '--artifact-dir', '--out-dir', '--build-plan-dir',
])

async function selectCargo({ argv, sub, cwd, files, run }) {
  const end = argv.indexOf('--', sub + 1) === -1 ? argv.length : argv.indexOf('--', sub + 1)
  const dropIdx = new Set()
  let workspace = false
  let manifest = null
  const excludes = []
  for (let k = sub + 1; k < end; k++) {
    const t = argv[k]
    if (t === '-p' || t === '--package' || t.startsWith('--package=') || (t.startsWith('-p') && t.length > 2 && !t.startsWith('--'))) {
      return passthrough(argv, '-p で範囲が指定済み（人が絞っているので触らない）')
    }
    if (CARGO_NAMED_TARGET.has(t) || /^--(test|bench|example|bin)=/.test(t)) {
      return passthrough(argv, '名前付きターゲット指定があり、-p を足すと壊れうる')
    }
    if (!t.startsWith('-')) return passthrough(argv, 'テスト名の絞り込みが指定済み（人が絞っているので触らない）')
    if (t === '--workspace' || t === '--all') { workspace = true; dropIdx.add(k) }
    else if (t === '--exclude') { excludes.push(argv[k + 1]); dropIdx.add(k); dropIdx.add(k + 1); k++ }
    else if (t.startsWith('--exclude=')) { excludes.push(t.slice(10)); dropIdx.add(k) }
    else if (t === '--manifest-path') { manifest = argv[k + 1]; k++ }
    else if (t.startsWith('--manifest-path=')) manifest = t.slice(16)
    else if (CARGO_VALUE_FLAGS.has(t)) k++
  }

  const margs = ['metadata', '--format-version', '1', '--offline']
  if (manifest) margs.push('--manifest-path', manifest)
  const meta = JSON.parse(await run('cargo', margs))
  const memberIds = new Set(meta.workspace_members)
  const members = meta.packages.filter((p) => memberIds.has(p.id))
  const byId = new Map(members.map((p) => [p.id, p]))
  const wsRoot = path.resolve(meta.workspace_root)

  // 全体へ効く物
  const globalNames = ['Cargo.lock', 'Cargo.toml', 'rust-toolchain', 'rust-toolchain.toml']
  for (const f of files) {
    const rel = path.relative(wsRoot, f)
    if (rel.startsWith('..')) continue
    const norm = rel.split(path.sep).join('/')
    if (globalNames.includes(norm) || norm.startsWith('.cargo/')) {
      return { argv, mode: 'full', reason: `ワークスペース全体へ効く変更（${norm}）` }
    }
  }

  const dirs = members.map((p) => ({ id: p.id, dir: path.dirname(path.resolve(p.manifest_path)) }))
  const changedIds = new Set()
  for (const f of files) {
    let best = null
    for (const d of dirs) if (inside(d.dir, f) && (!best || d.dir.length > best.dir.length)) best = d
    if (best) changedIds.add(best.id)
    else if (!existsSync(f) && /(\.rs|Cargo\.toml)$/.test(f) && inside(wsRoot, f)) {
      return { argv, mode: 'full', reason: `crateごと消えた変更があり依存側を引けない（${path.relative(wsRoot, f).split(path.sep).join('/')}）` }
    }
  }
  if (changedIds.size === 0) return { argv, mode: 'none', reason: '変更はどのcrateにも属さない（README等）' }

  const rev = new Map()
  for (const n of meta.resolve?.nodes ?? []) {
    if (!byId.has(n.id)) continue
    for (const d of n.deps ?? []) {
      if (!byId.has(d.pkg)) continue
      if (!rev.has(d.pkg)) rev.set(d.pkg, new Set())
      rev.get(d.pkg).add(n.id)
    }
  }
  const affected = new Set(changedIds)
  const queue = [...changedIds]
  while (queue.length) {
    for (const up of rev.get(queue.pop()) ?? []) if (!affected.has(up)) { affected.add(up); queue.push(up) }
  }

  const name = (i) => byId.get(i).name
  let scope
  if (workspace) scope = members.map((p) => p.id).filter((i) => !excludes.includes(name(i)))
  else if (meta.resolve?.root) scope = [meta.resolve.root]
  else scope = (meta.workspace_default_members ?? meta.workspace_members).filter((i) => byId.has(i))

  const picked = scope.filter((i) => affected.has(i))
  const label = (set) => [...set].map(name).sort().join(',')
  if (picked.length === 0) {
    return { argv, mode: 'none', reason: `変更crate(${label(changedIds)})の影響が実行範囲に届かない` }
  }
  if (picked.length === scope.length) {
    const why =
      scope.length === 1
        ? '単一crateのためcrate内の選択手段が無い（全部流す）'
        : '影響が実行範囲の全体に及ぶ（選べたが全部）'
    return { argv, mode: 'full', reason: `変更crate(${label(changedIds)}): ${why}` }
  }
  const count = new Map()
  for (const p of meta.packages) count.set(p.name, (count.get(p.name) ?? 0) + 1)
  const spec = (i) => {
    const p = byId.get(i)
    return count.get(p.name) > 1 ? `${p.name}@${p.version}` : p.name
  }
  const out = []
  for (let k = 0; k < argv.length; k++) {
    if (!dropIdx.has(k)) out.push(argv[k])
    if (k === sub) for (const i of picked) out.push('-p', spec(i))
  }
  return {
    argv: out,
    mode: 'subset',
    reason: `変更crate(${label(changedIds)}) → 影響crate(${label(picked)})だけを -p で指定`,
  }
}

// ----- go -----

const GO_VALUE_FLAGS = new Set([
  'run', 'bench', 'benchtime', 'count', 'cpu', 'timeout', 'tags', 'p', 'parallel', 'coverprofile', 'coverpkg',
  'covermode', 'o', 'outputdir', 'exec', 'mod', 'modfile', 'overlay', 'pkgdir', 'toolexec', 'gcflags',
  'ldflags', 'asmflags', 'gccgoflags', 'vet', 'skip', 'fuzztime', 'fuzzminimizetime', 'shuffle', 'testlogfile',
  'memprofile', 'memprofilerate', 'cpuprofile', 'blockprofile', 'blockprofilerate', 'mutexprofile',
  'mutexprofilefraction', 'trace', 'compiler', 'buildvcs', 'installsuffix', 'asan', 'msan',
  'artifacts', 'fullpath', 'goroot',
])
const GO_BOOLEAN_LOOKALIKES = new Set(['asan', 'msan', 'fullpath', 'goroot', 'artifacts'])
const GO_PASSTHROUGH_FLAGS = new Set(['C', 'run', 'skip', 'fuzz', 'overlay', 'modfile', 'o', 'exec', 'toolexec'])

function parseGoWork(file) {
  const dir = path.dirname(file)
  const text = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '')
  const uses = []
  for (const m of text.matchAll(/^\s*use\s*\(([^)]*)\)/gms)) {
    for (const l of m[1].split('\n')) { const s = l.trim(); if (s) uses.push(s) }
  }
  for (const m of text.matchAll(/^\s*use\s+([^\s(][^\n]*)$/gm)) uses.push(m[1].trim())
  return uses.map((u) => path.resolve(dir, u.replace(/^"|"$/g, '')))
}

function findUp(cwd, name) {
  let d = path.resolve(cwd)
  for (;;) {
    const f = path.join(d, name)
    if (existsSync(f)) return f
    const up = path.dirname(d)
    if (up === d) return null
    d = up
  }
}

const GO_LIST_FIELDS =
  'ImportPath,Dir,Imports,TestImports,XTestImports,TestGoFiles,XTestGoFiles,EmbedFiles,TestEmbedFiles,XTestEmbedFiles,Module'

// go list -json は整形済みJSONを連ねて出す。トップの閉じ括弧（行頭の }）で区切る。
async function goList(run, cwd, env, patterns) {
  const out = await run('go', ['list', '-e', `-json=${GO_LIST_FIELDS}`, ...patterns], { cwd, env })
  const res = []
  let buf = []
  for (const l of out.split('\n')) {
    buf.push(l)
    if (l === '}') {
      const o = JSON.parse(buf.join('\n'))
      res.push({
        p: o.ImportPath, d: o.Dir, i: o.Imports ?? [], t: o.TestImports ?? [], x: o.XTestImports ?? [],
        n: (o.TestGoFiles ?? []).length, xn: (o.XTestGoFiles ?? []).length,
        e: o.EmbedFiles ?? [], te: o.TestEmbedFiles ?? [], xe: o.XTestEmbedFiles ?? [], m: o.Module?.Dir ?? null,
      })
      buf = []
    }
  }
  return res
}

async function selectGo({ argv, sub, cwd, env, files, run }) {
  const genv = { ...env, GOPROXY: 'off' }
  if (genv.GOFLAGS === undefined) delete genv.GOFLAGS
  const patternIdx = []
  for (let k = sub + 1; k < argv.length; k++) {
    const t = argv[k]
    if (t === '-args' || t === '--args') break
    if (t.startsWith('-')) {
      const nm = t.replace(/^--?/, '').split('=')[0]
      if (GO_PASSTHROUGH_FLAGS.has(nm)) return passthrough(argv, `-${nm} 指定があり書き換えない`)
      if (!t.includes('=') && GO_VALUE_FLAGS.has(nm) && !GO_BOOLEAN_LOOKALIKES.has(nm)) k++
      continue
    }
    if (t.endsWith('.go')) return passthrough(argv, 'ファイル指定の go test は書き換えない')
    patternIdx.push(k)
  }
  const patterns = patternIdx.map((k) => argv[k])
  if (patterns.some((p) => p !== './...' && p !== '...')) {
    return passthrough(argv, 'packageが指定済み（人が絞っているので触らない）')
  }

  // モジュールの全体像（go.work があれば全 use、無ければ最寄りの go.mod）
  let modDirs
  let workFile = null
  if (genv.GOWORK !== 'off') workFile = genv.GOWORK && genv.GOWORK !== '' ? genv.GOWORK : findUp(cwd, 'go.work')
  if (workFile) modDirs = parseGoWork(workFile)
  else {
    const mod = findUp(cwd, 'go.mod')
    if (!mod) return passthrough(argv, 'go.mod も go.work も見つからない')
    modDirs = [path.dirname(mod)]
  }
  const lists = await Promise.all(modDirs.map((d) => goList(run, d, genv, ['./...'])))
  const pkgs = new Map()
  for (const p of lists.flat()) if (!pkgs.has(p.p)) pkgs.set(p.p, p)
  if (pkgs.size === 0) return passthrough(argv, 'packageが見つからない')

  // 変更ファイル → package
  const embedOf = (p) => new Set([...(p.e ?? []), ...(p.te ?? []), ...(p.xe ?? [])].map((f) => path.resolve(p.d, f)))
  const changedPk = new Set()
  const allOfModule = (modDir) => { for (const p of pkgs.values()) if (p.m && path.resolve(p.m) === modDir) changedPk.add(p.p) }
  for (const f of files) {
    const nm = path.basename(f)
    if (nm === 'go.work' || nm === 'go.work.sum') { for (const k of pkgs.keys()) changedPk.add(k); continue }
    const modHit = modDirs.find((d) => (nm === 'go.mod' || nm === 'go.sum') && path.dirname(f) === d)
    if (modHit) { allOfModule(modHit); continue }
    const vend = modDirs.find((d) => inside(path.join(d, 'vendor'), f))
    if (vend) { allOfModule(vend); continue }
    for (const p of pkgs.values()) {
      const dir = path.resolve(p.d)
      const direct = path.dirname(f) === dir
      const td = inside(path.join(dir, 'testdata'), f)
      if (direct || td || embedOf(p).has(f)) changedPk.add(p.p)
    }
  }
  // 消えたpackage（ディレクトリごと無い .go）は、それを import していた側を変更扱いにする
  const modPath = new Map()
  for (const p of pkgs.values()) {
    if (!p.m) continue
    const rel = path.relative(path.resolve(p.m), path.resolve(p.d)).split(path.sep).join('/')
    modPath.set(path.resolve(p.m), rel ? p.p.slice(0, -(rel.length + 1)) : p.p)
  }
  for (const f of files) {
    if (!f.endsWith('.go') || existsSync(f)) continue
    const dir = path.dirname(f)
    if ([...pkgs.values()].some((p) => path.resolve(p.d) === dir)) continue
    const md = [...modPath.keys()].filter((d) => inside(d, dir)).sort((a, b) => b.length - a.length)[0]
    if (!md) continue
    const rel = path.relative(md, dir).split(path.sep).join('/')
    const gone = rel ? `${modPath.get(md)}/${rel}` : modPath.get(md)
    for (const p of pkgs.values()) {
      if ([...(p.i ?? []), ...(p.t ?? []), ...(p.x ?? [])].includes(gone)) changedPk.add(p.p)
    }
  }
  if (changedPk.size === 0) return { argv, mode: 'none', reason: '変更はどのpackageにも属さない（README等）' }

  const rev = new Map()
  for (const p of pkgs.values()) {
    for (const imp of new Set([...(p.i ?? []), ...(p.t ?? []), ...(p.x ?? [])])) {
      if (imp === p.p || !pkgs.has(imp)) continue
      if (!rev.has(imp)) rev.set(imp, new Set())
      rev.get(imp).add(p.p)
    }
  }
  const affected = new Set(changedPk)
  const queue = [...changedPk]
  while (queue.length) {
    for (const up of rev.get(queue.pop()) ?? []) if (!affected.has(up)) { affected.add(up); queue.push(up) }
  }

  const scopeList = await goList(run, cwd, genv, patterns.length ? ['./...'] : ['.'])
  const scope = scopeList.map((p) => p.p).filter((p) => pkgs.has(p))
  const hasTests = (k) => (pkgs.get(k).n ?? 0) + (pkgs.get(k).xn ?? 0) > 0
  if (scope.length === 0) return passthrough(argv, 'この場所では実行範囲のpackageが解決できない（go.work のルート等）')
  const names = (set) => [...set].map((k) => k.replace(/^.*\//, '')).sort().join(',')
  const scopeT = scope.filter(hasTests)
  const picked = scopeT.filter((k) => affected.has(k))
  if (picked.length === 0) {
    return { argv, mode: 'none', reason: `変更package(${names(changedPk)})の影響先に、実行範囲のテストを持つpackageが無い` }
  }
  if (picked.length === scopeT.length) {
    const why =
      scopeT.length === 1
        ? '単一packageのためpackage内の選択手段が無い（全部流す）'
        : '影響が実行範囲の全体に及ぶ（選べたが全部）'
    return { argv, mode: 'full', reason: `変更package(${names(changedPk)}): ${why}` }
  }
  const drop = new Set(patternIdx)
  const out = []
  for (let k = 0; k < argv.length; k++) {
    if (!drop.has(k)) out.push(argv[k])
    if (k === sub) out.push(...picked)
  }
  return {
    argv: out,
    mode: 'subset',
    reason: `変更package(${names(changedPk)}) → 影響package(${names(picked)})だけを指定`,
  }
}

// ---------- 結果の読み取り ----------

const CARGO_RESULT = /^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored;(?: \d+ measured;)?(?: \d+ filtered out;)?(?: finished in ([\d.]+)s)?/
const RTK_CARGO = /^cargo test: (.*?)(?: \(([^)]*)\))?\s*$/
const RTK_GO = /^Go test: (.*?)(?: in \d+ packages?)?\s*$/

function pushFail(list, name) {
  if (name && list.length < MAX_FAILURES && !list.includes(name)) list.push(name)
}

function rtkCounts(s) {
  const r = {}
  for (const m of s.matchAll(/(\d+)\s+(passed|failed|ignored|skipped)/g)) {
    const key = m[2] === 'passed' ? 'passed' : m[2] === 'failed' ? 'failed' : 'skipped'
    r[key] = (r[key] ?? 0) + Number(m[1])
  }
  return r
}

export function parseOutput(text) {
  const out = {}
  if (typeof text !== 'string' || text === '') return out
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const failures = []

  // cargo 生
  let cp = 0, cf = 0, ci = 0, cms = 0, cargoSeen = false, cargoTime = false, cargoErr = 0
  // go
  let goPass = 0, goFail = 0, goSkip = 0, goVerbose = false, goSeen = false
  let goMs = 0, goTime = false
  // go -json
  let jPass = 0, jFail = 0, jSkip = 0, jSeen = false
  const jFailNames = []
  // rtk
  let rtk = null
  let rtkMs
  const pkgFail = []

  for (const raw of lines) {
    const line = raw.trimEnd()
    let m
    if ((m = CARGO_RESULT.exec(line))) {
      cargoSeen = true
      cp += +m[1]; cf += +m[2]; ci += +m[3]
      if (m[4] !== undefined) { cms += Math.round(parseFloat(m[4]) * 1000); cargoTime = true }
      continue
    }
    if (/^error: could not compile `/.test(line)) { cargoErr++; continue }
    if ((m = /^test (\S.*?) \.\.\. FAILED$/.exec(line))) { pushFail(failures, m[1]); continue }
    if ((m = /^---- (\S.*?) stdout ----$/.exec(line))) { pushFail(failures, m[1]); continue }
    if (line.startsWith('{"Time"') || line.startsWith('{"Action"')) {
      try {
        const e = JSON.parse(line)
        if (e.Test && !e.Test.includes('/') && ['pass', 'fail', 'skip'].includes(e.Action)) {
          jSeen = true
          if (e.Action === 'pass') jPass++
          else if (e.Action === 'fail') { jFail++; jFailNames.push(e.Test) }
          else jSkip++
        }
        continue
      } catch { /* 通常行として扱う */ }
    }
    if ((m = RTK_CARGO.exec(line)) && /\d+\s+(passed|failed)/.test(m[1])) {
      rtk = rtkCounts(m[1])
      const t = m[2] && /([\d.]+)s/.exec(m[2])
      if (t) rtkMs = Math.round(parseFloat(t[1]) * 1000)
      continue
    }
    if ((m = RTK_GO.exec(line)) && /\d+\s+(passed|failed)/.test(m[1])) { rtk = rtkCounts(m[1]); continue }
    if ((m = /^\s*\[FAIL\]\s+(\S.*)$/.exec(line))) { pushFail(failures, m[1].trim()); continue }
    if (/^=== RUN\s/.test(line)) { goVerbose = true; goSeen = true; continue }
    if ((m = /^--- (PASS|FAIL|SKIP): (\S+)/.exec(line))) {
      goSeen = true
      if (m[1] === 'PASS') goPass++
      else if (m[1] === 'FAIL') { goFail++; pushFail(failures, m[2]) }
      else goSkip++
      continue
    }
    if ((m = /^(?:ok|FAIL)\s+\S+\s+([\d.]+)s\b/.exec(line))) { goMs += Math.round(parseFloat(m[1]) * 1000); goTime = true; goSeen = true; continue }
    if ((m = /^FAIL\s+(\S+)\s+\[(build failed|setup failed)\]/.exec(line))) { pushFail(pkgFail, m[1]); goSeen = true; continue }
  }

  if (cargoSeen) {
    out.passed = cp; out.failed = cf; out.skipped = ci
    if (cargoTime) out.durationMs = cms
  } else if (jSeen) {
    out.passed = jPass; out.failed = jFail; out.skipped = jSkip
    for (const n of jFailNames) pushFail(failures, n)
  } else if (rtk) {
    if (rtk.passed !== undefined) out.passed = rtk.passed
    out.failed = rtk.failed ?? 0
    if (rtk.skipped !== undefined) out.skipped = rtk.skipped
    if (rtkMs !== undefined) out.durationMs = rtkMs
  } else if (goSeen) {
    out.failed = goFail
    if (goVerbose) { out.passed = goPass; out.skipped = goSkip }
    if (goTime) out.durationMs = goMs
  }
  for (const p of pkgFail) pushFail(failures, p)
  const errors = cargoErr + pkgFail.length
  if (errors) {
    out.errors = errors
    out.failed = (out.failed ?? 0) + errors
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
    if (/^test result: ok\./.test(line)) continue
    if (/^test result: FAILED\./.test(line)) { kept.push('test result: FAILED.'); continue }
    if (/^running \d+ tests?$/.test(line)) continue
    if (/^test \S.* \.\.\. (ok|ignored)$/.test(line)) continue
    if (/^cargo test: .*\d+\s+(passed|failed)/.test(line)) continue
    if (/^Go test: .*\d+\s+(passed|failed)/.test(line)) continue
    if (/^=== (RUN|PAUSE|CONT|NAME)\s/.test(line)) continue
    if (/^\s*--- (PASS|SKIP):/.test(line)) continue
    if (/^PASS$/.test(line)) continue
    if (/^ok\s+\S+\s+/.test(line)) continue
    if (/^\?\s+\S+\s+\[no test files\]/.test(line)) continue
    const hdr = /^(\S+) \(\d+ (?:passed|failed|skipped)(?:, \d+ (?:passed|failed|skipped))*\)$/.exec(line)
    if (hdr) { kept.push(hdr[1]); continue }
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
