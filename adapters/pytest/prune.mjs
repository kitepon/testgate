// testgate prune（刈り込み）の pytest アダプタ。契約: docs/prune-adapter-contract.md（v0.1）。
// 変異の道具は cosmic-ray（変異の列挙と適用だけ）。試験は変異ごとに pytest を全部流し、落ちた試験を全部記録する（py/prune_driver.py）。
// 外部依存なしの Node ESM。道具（cosmic-ray の venv）は初回に ~/.local/share/testgate/prune-tools/pytest/ へ入れる。
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, globSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, cpus } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const id = 'pytest'
export const runners = ['pytest']

export const COSMIC_RAY_VERSION = '8.7.0'
const here = dirname(fileURLToPath(import.meta.url))
const PY_DIR = existsSync(join(here, 'py')) ? join(here, 'py') : here
const IS_WIN = process.platform === 'win32'

// ---- 道具の置き場 ---------------------------------------------------------

/** 道具の根。tools.mjs（Stryker 一式）と同じ規則: $TESTGATE_PRUNE_TOOLS > $XDG_DATA_HOME/testgate/prune-tools > ~/.local/share/testgate/prune-tools。 */
export function toolsRoot(env = process.env) {
  if (env.TESTGATE_PRUNE_TOOLS) return env.TESTGATE_PRUNE_TOOLS
  const base = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share')
  return join(base, 'testgate', 'prune-tools')
}
export function toolsDir(env = process.env) { return join(toolsRoot(env), 'pytest') }
const venvPython = (dir) => join(dir, 'venv', ...(IS_WIN ? ['Scripts', 'python.exe'] : ['bin', 'python']))

/** 道具が導入済みか（版も見る）。試験の skip 判定にも使う。 */
export function toolsReady(env = process.env) {
  const dir = toolsDir(env)
  try {
    const m = JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8'))
    return m.cosmicRay === COSMIC_RAY_VERSION && existsSync(venvPython(dir))
  } catch { return false }
}

function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, error: r.error }
}

function basePython(env) {
  for (const c of [env.TESTGATE_TOOLS_PYTHON, 'python3', 'python'].filter(Boolean)) {
    const r = runSync(c, ['-c', 'import venv,sys;print(sys.version_info[0]*100+sys.version_info[1])'], { env, timeout: 15000 })
    if (r.status === 0 && Number(r.out.trim()) >= 309) return c
  }
  return null
}

/** 道具を揃えて場所を返す。導入は版が違う時か無い時だけ。py/ の複製は毎回（安い）。 */
export function ensureTools({ env = process.env, log = () => {}, logFile } = {}) {
  const dir = toolsDir(env)
  mkdirSync(dir, { recursive: true })
  if (!toolsReady(env)) {
    const py = basePython(env)
    if (!py) throw new Error('道具（cosmic-ray）を入れる python（3.9 以上、venv 付き）が見つからない。TESTGATE_TOOLS_PYTHON で指定できる')
    log(`testgate prune: 道具を ${dir} へ導入する（cosmic-ray ${COSMIC_RAY_VERSION}。初回か版の更新）`)
    rmSync(join(dir, 'venv'), { recursive: true, force: true })
    const v = runSync(py, ['-m', 'venv', join(dir, 'venv')], { env })
    if (v.status !== 0) throw new Error(`道具の venv を作れない: ${v.out.trim().slice(-1500)}`)
    const p = runSync(venvPython(dir), ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `cosmic-ray==${COSMIC_RAY_VERSION}`], { env })
    if (logFile) writeFileSync(logFile, `--- pip install cosmic-ray==${COSMIC_RAY_VERSION} ---\n${p.out}\n`, { flag: 'a' })
    if (p.status !== 0) throw new Error(`cosmic-ray の導入に失敗（ネットワークか pip の設定）: ${p.out.trim().slice(-1500)}`)
    writeFileSync(join(dir, 'tools.json'), JSON.stringify({ cosmicRay: COSMIC_RAY_VERSION, installedAt: new Date().toISOString() }, null, 2) + '\n')
  }
  const plugins = join(dir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  for (const f of ['prune_driver.py', 'testgate_prune_plugin.py']) copyFileSync(join(PY_DIR, f), join(plugins, f))
  const ver = runSync(venvPython(dir), ['-c', 'import importlib.metadata as m;print(m.version("cosmic-ray"))'], { env }).out.trim()
  log(`testgate prune: 道具 cosmic-ray ${ver}（${dir}）`)
  return { dir, python: venvPython(dir), plugins, cosmicRay: ver }
}

// ---- プロジェクトの python ---------------------------------------------------

/** 試験を流す python（pytest が入っている物）。TESTGATE_PYTHON > cwd/.venv > cwd/venv > python3 > python。 */
export function findProjectPython(cwd, env = process.env) {
  const exe = IS_WIN ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const candidates = [env.TESTGATE_PYTHON, join(cwd, '.venv', ...exe), join(cwd, 'venv', ...exe), 'python3', 'python'].filter(Boolean)
  const tried = []
  for (const py of candidates) {
    const r = runSync(py, ['-c', 'import pytest,sys;print(pytest.__version__)'], { env, cwd, timeout: 20000 })
    if (r.status === 0) return { python: py, pytestVersion: r.out.trim().split('\n').pop() }
    tried.push(py)
  }
  return { error: `pytest の入った python が無い（探した: ${tried.join(', ')}）。TESTGATE_PYTHON で指定するか、プロジェクトの .venv に pytest を入れる` }
}

// ---- detect / name ---------------------------------------------------------

function readText(p) { try { return readFileSync(p, 'utf8') } catch { return '' } }

/** この cwd を pytest で刈り込めるか。pytest の設定ファイルか conftest.py、pyproject の pytest の記述、test_*.py のどれかがあれば true。 */
export async function detect(cwd, { env } = {}) {
  void env
  if (existsSync(join(cwd, 'pytest.ini')) || existsSync(join(cwd, 'conftest.py'))) return true
  if (/^\s*\[tool\.pytest|["']pytest\b/m.test(readText(join(cwd, 'pyproject.toml')))) return true
  if (/^\s*\[(tool:)?pytest\]/m.test(readText(join(cwd, 'setup.cfg'))) || /^\s*\[pytest\]/m.test(readText(join(cwd, 'tox.ini')))) return true
  for (const d of [cwd, join(cwd, 'tests'), join(cwd, 'test')]) {
    try { if (readdirSync(d).some(f => /^test_.*\.py$|^.*_test\.py$/.test(f))) return true } catch { /* 無い */ }
  }
  return false
}

/** 記録の名前。pyproject の project.name／tool.poetry.name、setup.cfg の metadata.name、無ければ basename。 */
export async function name(cwd, { env } = {}) {
  void env
  const py = readText(join(cwd, 'pyproject.toml'))
  for (const section of ['project', 'tool.poetry']) {
    const m = new RegExp(`^\\[${section.replace('.', '\\.')}\\][^\\[]*?^name\\s*=\\s*["']([^"']+)["']`, 'ms').exec(py)
    if (m) return m[1]
  }
  const cfg = /^\[metadata\][^[]*?^name\s*=\s*(\S+)/ms.exec(readText(join(cwd, 'setup.cfg')))
  return cfg ? cfg[1] : basename(cwd)
}

// ---- 純粋な部品（道具無しで試験できる） ---------------------------------------

const TEST_FILE_RE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$|(^|\/)conftest\.py$/

/** 試験ファイルか。収集された試験のファイル、または名前の規約（test_*.py／*_test.py／conftest.py）。 */
export function isTestFile(path, testFiles = new Set()) {
  const p = String(path || '').replace(/\\/g, '/')
  return testFiles.has(p) || TEST_FILE_RE.test(p)
}

/** 殺しの分類。facts は plugin が残した事実 { when, types（例外の型と継承）, frames（例外の発生位置から外へ。{path,line}）, collect }。
 *  狙い = 試験本文の断言で落ちた: AssertionError（pytest.fail／pytest.raises の失敗の Failed も同じ扱い）で、発生位置の frame が試験ファイル。
 *  前提 = それ以外（製品コード・helper の中の例外や断言、setup・teardown・収集の失敗、import 失敗、試験の上限超過）。 */
export function classifyKind(facts, testFiles = new Set()) {
  if (!facts || facts.collect || facts.when !== 'call') return '前提'
  const types = facts.types || []
  if (!types.includes('AssertionError') && !types.includes('Failed')) return '前提'
  const site = (facts.frames || [])[0]
  return site && isTestFile(site.path, testFiles) ? '狙い' : '前提'
}

/** failures.jsonl の error（4000 字まで）。1 行目は「型: 本文」、続けて発生位置から外へ向かう frame を `at path:line` で並べる。 */
export function formatError(facts) {
  const head = String(facts.message || (facts.types || [])[0] || '').trimEnd()
  const frames = (facts.frames || []).map(f => `   at ${f.path}:${f.line}`)
  return [head, ...frames].join('\n').slice(0, 4000)
}

/** 変異の終わり方（driver の 1 件分）から status と killedBy。 */
export function judgeMutant(r, tests) {
  if (r.status === 'nomutation') return { status: 'Ignored', killedBy: [] }
  if (r.status === 'error') return { status: 'RuntimeError', killedBy: [] }
  if (r.status === 'timeout') return { status: 'Timeout', killedBy: [] }
  const failed = (r.records || []).filter(x => x.t === 'c' || x.outcome === 'failed')
  if (failed.length) return { status: 'Killed', killedBy: [...new Set(failed.filter(x => x.t === 'r' && tests.has(x.id)).map(x => x.id))] }
  if (r.ended && r.ran > 0 && (r.exit === 0 || r.exit === 1)) return { status: 'Survived', killedBy: [] }
  return { status: 'RuntimeError', killedBy: [] } // 試験が走らない・異常終了（収集0件、内部エラー、道具の都合）。候補の集計から外れる
}

/** driver の列挙（enumerate の出力）と結果（run の JSONL の行）、基準の試験一覧から mutation.json と failures.jsonl の行を作る。 */
export function buildReport({ enumeration, results, tests }) {
  const files = {}
  const failures = []
  const testIds = new Set(tests.map(t => t.id))
  const testFiles = new Set(tests.map(t => t.file))
  const byFile = {}
  for (const t of tests) (byFile[t.file] ||= { tests: [] }).tests.push({ id: t.id, name: t.id, location: { start: { line: t.line ?? 1 } } })
  const sorted = [...results].sort((a, b) => a.index - b.index)
  for (const r of sorted) {
    const { status, killedBy } = judgeMutant(r, testIds)
    const mid = String(r.index)
    const f = (files[r.file] ||= { language: 'python', source: enumeration.sources[r.file], mutants: [] })
    f.mutants.push({
      id: mid, mutatorName: r.operator, replacement: r.replacement ?? '',
      location: { start: { line: r.start[0], column: r.start[1] + 1 }, end: { line: r.end[0], column: r.end[1] + 1 } },
      status, killedBy, ...(r.fn ? { functionName: r.fn } : {}),
    })
    if (status === 'Killed') {
      for (const x of r.records) {
        if (x.t === 'r' && !testIds.has(x.id)) continue
        const facts = x.t === 'c' ? { ...x, collect: true } : x
        failures.push({ mutant: mid, test: x.id, name: x.id, error: formatError(x), kind: classifyKind(facts, testFiles) })
      }
    }
  }
  return {
    mutation: { schemaVersion: '1', thresholds: { high: 80, low: 60 }, files, testFiles: byFile },
    failures,
  }
}

/** 変異の対象にするファイルの既定: 製品コードだけ。試験・生成物・依存・仮想環境は外す。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'env', '__pycache__', '.tox', '.nox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '.eggs', 'build', 'dist', 'site-packages', 'tests', 'test', 'docs', 'doc', '.testgate-prune'])
const SKIP_FILES = /^(setup|noxfile|conftest)\.py$|^test_.*\.py$|.*_test\.py$/
export function defaultMutateFiles(cwd) {
  const out = []
  const walk = (dir) => {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.endsWith('.egg-info')) walk(join(dir, e.name)) } else if (e.isFile() && e.name.endsWith('.py') && !SKIP_FILES.test(e.name)) out.push(relative(cwd, join(dir, e.name)).split(sep).join('/'))
    }
  }
  walk(cwd)
  return out
}

function expand(cwd, globs) {
  const set = new Set()
  for (const g of globs) for (const m of globSync(g, { cwd })) set.add(String(m).split(sep).join('/'))
  return [...set].sort()
}

// ---- 実行 -----------------------------------------------------------------

/** 子プロセスを流して終わりを待つ。timeoutMs を超えたらプロセス群ごと止める。出力は行ごとに onLine へ。 */
function runChild(cmd, args, { cwd, env, timeoutMs, onLine = () => {} }) {
  return new Promise(res => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN })
    let timedOut = false, buf = ''
    const kill = () => { try { IS_WIN ? child.kill() : process.kill(-child.pid, 'SIGKILL') } catch { /* もう無い */ } }
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; kill() }, timeoutMs) : null
    const feed = c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1) } }
    child.stdout.setEncoding('utf8').on('data', feed)
    child.stderr.setEncoding('utf8').on('data', feed)
    child.on('error', e => { if (timer) clearTimeout(timer); res({ status: null, timedOut, error: e }) })
    child.on('close', code => { if (buf) onLine(buf); if (timer) clearTimeout(timer); res({ status: code, timedOut }) })
  })
}

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}

const COPY_SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.testmondata', '.tox', '.nox', '.mypy_cache', '.ruff_cache', '.testgate-prune'])
/** 作業の写し。.git・仮想環境・キャッシュは持たない（Stryker の sandbox と同じ）。.pyc を持ち込まない事が肝心（同サイズ・同秒の書き換えで古い .pyc が使われるため）。 */
function copyProject(cwd, dest) {
  mkdirSync(dest, { recursive: true })
  cpSync(cwd, dest, { recursive: true, dereference: false, filter: p => { const rel = relative(cwd, p); return !rel.split(sep).some(s => COPY_SKIP.has(s)) } })
}

function pytestArgs({ deselect = [], ignore = [], testPaths = [] }) {
  return ['-m', 'pytest', '-p', 'testgate_prune_plugin', '-p', 'no:randomly', '--tb=short', '--maxfail=1000000000', '-q', '--no-header', '--color=no',
    ...deselect.map(d => `--deselect=${d}`), ...ignore.map(d => `--ignore=${d}`), ...testPaths]
}

export async function prune({ cwd, runDir, logFile, sample = 200, seed = 'testgate', mutate = [], tests = [], exclude = [], timeoutMs = 60000, testTimeoutMs = 60000, jobs, keepSandbox = false, env = process.env, log = () => {} } = {}) {
  cwd = resolve(cwd)
  const note = (m) => writeFileSync(logFile, m + '\n', { flag: 'a' })
  const notes = []
  const fail = (msg) => { log(`testgate prune: ${msg}`); note(msg); return { status: 1, runner: 'pytest', sampled: null, excluded: [], notes: [msg] } }

  let tools
  try { tools = ensureTools({ env, log, logFile }) } catch (e) { return fail(e.message) }
  const proj = findProjectPython(cwd, env)
  if (proj.error) return fail(proj.error)
  log(`testgate prune: pytest ${proj.pytestVersion}（${proj.python}）`)

  const targets = mutate.length ? expand(cwd, mutate) : defaultMutateFiles(cwd)
  const testGlobs = expand(cwd, tests)
  if (!targets.length) return fail(`変異の対象の .py が無い（--mutate の指定か、製品コードの置き場を確かめる。既定は tests・docs・仮想環境・build を外した全 .py）`)

  const workers = Math.max(1, Math.min(Number(jobs) || 1, Math.max(1, cpus().length)))
  const base = keepSandbox ? join(runDir, 'sandbox') : mkdtempSync(join(tmpdir(), 'tg-pytest-prune-'))
  mkdirSync(base, { recursive: true })
  try {
    // 作業の写し（worker ごと）。0 番は基準の試験にも使う
    const roots = []
    for (let i = 0; i < workers; i++) { const root = join(base, `w${i}`, 'repo'); copyProject(cwd, root); roots.push(root) }
    log(`testgate prune: 作業の写し ${workers} 個（${base}）`)

    const sandboxEnv = (root, out) => {
      const pp = [root, existsSync(join(root, 'src')) ? join(root, 'src') : null, tools.plugins, env.PYTHONPATH].filter(Boolean).join(IS_WIN ? ';' : ':')
      return { ...env, PYTHONPATH: pp, PYTHONDONTWRITEBYTECODE: '1', TG_PRUNE_OUT: out, TG_PRUNE_TEST_TIMEOUT: String(testTimeoutMs / 1000), TG_PRUNE_EXCLUDE: JSON.stringify(exclude) }
    }
    const lineSink = (l) => { try { writeFileSync(logFile, l + '\n', { flag: 'a' }) } catch { /* 記録の失敗で止めない */ } }

    // 1. 基準: 変異なしで全試験を流し、試験の一覧と、既に落ちる物を取る
    const baseOut = join(base, 'baseline.jsonl')
    const t0 = Date.now()
    note('--- 基準の試験（変異なし）---')
    const baseRun = await runChild(proj.python, pytestArgs({ testPaths: testGlobs }), { cwd: roots[0], env: sandboxEnv(roots[0], baseOut), timeoutMs: Math.max(10 * 60000, timeoutMs * 5), onLine: lineSink })
    const baseMs = Date.now() - t0
    if (baseRun.error) return fail(`pytest を起動できない: ${baseRun.error.message}`)
    if (baseRun.timedOut) return fail(`基準の試験が ${Math.round(baseMs / 1000)} 秒で終わらない`)
    const baseRecs = readJsonl(baseOut)
    const seen = new Map()
    for (const r of baseRecs) if (r.t === 'r' && (r.when === 'call' || !seen.has(r.id))) seen.set(r.id, r)
    const baseFailed = [...new Set(baseRecs.filter(r => r.t === 'r' && r.outcome === 'failed').map(r => r.id))]
    const baseCollect = [...new Set(baseRecs.filter(r => r.t === 'c').map(r => r.id))]
    const excluded = [...new Set(baseRecs.filter(r => r.t === 'x').map(r => r.id))]
    if (!baseRecs.some(r => r.t === 'end')) return fail(`基準の pytest が正常に終わらない（exit ${baseRun.status}）。記録 ${logFile}`)
    // skip された試験は何も殺せないので試験の一覧に入れない（入れると「検出0」で消す候補に出てしまう）
    const finalTests = [...seen.values()].filter(r => r.outcome !== 'skipped' && !baseFailed.includes(r.id)).map(r => ({ id: r.id, file: r.file, line: r.line }))
    if (!finalTests.length) return fail(`基準の試験で通る物が 1 本も無い（落ちた ${baseFailed.length} 本、収集の失敗 ${baseCollect.length} 件）。変異は流さない`)
    if (baseFailed.length || baseCollect.length) {
      const m = `基準の試験で落ちた物を除外して流す（変異無しで落ちる物。候補にも出ない）: 試験 ${baseFailed.length} 本${baseCollect.length ? `、収集の失敗 ${baseCollect.join(' ')}` : ''}`
      log(`testgate prune: ${m}`); notes.push(m)
    }
    log(`testgate prune: 基準 ${finalTests.length} 本（${(baseMs / 1000).toFixed(1)} 秒）`)

    // 変異 1 件の上限: 全体の 4 倍 + 5 秒を目安に、既定の上限より短ければそれを使う。基準が上限に近い時は基準の 2 倍 + 10 秒へ延ばす
    let mutantTimeout = Math.min(timeoutMs, Math.max(10000, baseMs * 4 + 5000))
    if (baseMs * 1.5 > timeoutMs) {
      mutantTimeout = Math.ceil(baseMs * 2 + 10000)
      const m = `全試験が ${(baseMs / 1000).toFixed(1)} 秒かかるので、変異 1 件の上限（${timeoutMs / 1000} 秒）を ${Math.round(mutantTimeout / 1000)} 秒へ延ばした`
      log(`testgate prune: ${m}`); notes.push(m)
    }

    // 2. 変異の列挙と標本
    const enumOut = join(base, 'enumeration.json')
    const enumCfg = join(base, 'enumerate.json')
    writeFileSync(enumCfg, JSON.stringify({ root: roots[0], files: targets, sample, seed: String(seed), out: enumOut }))
    const en = await runChild(tools.python, [join(tools.plugins, 'prune_driver.py'), 'enumerate', enumCfg], { cwd: roots[0], env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, timeoutMs: 10 * 60000, onLine: lineSink })
    if (en.status !== 0 || !existsSync(enumOut)) return fail(`変異の列挙に失敗（exit ${en.status}）。記録 ${logFile}`)
    const enumeration = JSON.parse(readFileSync(enumOut, 'utf8'))
    for (const s of enumeration.skipped) notes.push(`変異の対象から外した（読めない構文）: ${s.file}（${s.error}）`)
    log(`testgate prune: ${targets.length} ファイル ${enumeration.total} 変異のうち ${enumeration.sampled} 件を流す（seed ${seed}、位置 ${enumeration.positions}）`)
    if (!enumeration.items.length) return fail('列挙できる変異が無い')

    // 3. 変異ごとに全試験を流す
    const runOut = join(base, 'results.jsonl')
    const runWorkers = roots.map((root, i) => ({ root, results: join(base, `w${i}`, 'results.jsonl'), log: join(base, `w${i}`, 'pytest.log') }))
    const deselect = baseFailed
    const ignore = baseCollect.map(c => c.split('::')[0])
    const probe = sandboxEnv(roots[0], '')
    delete probe.TG_PRUNE_OUT
    const runCfg = join(base, 'run.json')
    writeFileSync(runCfg, JSON.stringify({ items: enumeration.items, out: runOut, timeout: mutantTimeout / 1000, cmd: [proj.python, ...pytestArgs({ deselect, ignore, testPaths: testGlobs })], env: probe, workers: runWorkers }))
    let n = 0
    const step = Math.max(1, Math.floor(enumeration.items.length / 10))
    note('--- 変異ごとの試験 ---')
    const run = await runChild(tools.python, [join(tools.plugins, 'prune_driver.py'), 'run', runCfg], {
      cwd: roots[0], env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, onLine: l => { lineSink(l); if (/^\[\d+\//.test(l) && ++n % step === 0) log(`testgate prune: ${l}`) },
    })
    const results = readJsonl(runOut)
    if (run.status !== 0) notes.push(`変異の実行が途中で止まった（exit ${run.status}）。${results.length}/${enumeration.items.length} 件の結果だけを記録した`)
    if (!results.length) return fail(`変異の結果が 1 件も無い（exit ${run.status}）。記録 ${logFile}`)

    // 4. 記録
    const { mutation, failures } = buildReport({ enumeration, results, tests: finalTests })
    writeFileSync(join(runDir, 'mutation.json'), JSON.stringify(mutation) + '\n')
    writeFileSync(join(runDir, 'failures.jsonl'), failures.map(f => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''))
    const killed = results.filter(r => judgeMutant(r, new Set(finalTests.map(t => t.id))).status === 'Killed').length
    if (!killed) notes.push('Killed が 0 件。製品コードが作業の写しから import されていない（editable install など）か、試験が変異に届いていない可能性がある。README の「うまく動かない時」を見る')
    const sampled = { total: enumeration.total, sampled: enumeration.sampled, positions: enumeration.positions }
    writeFileSync(join(runDir, 'project.json'), JSON.stringify({
      cwd, runner: 'pytest', python: proj.python, pytestVersion: proj.pytestVersion, tool: { name: 'cosmic-ray', version: tools.cosmicRay, use: '変異の列挙と適用だけ。試験は prune_driver.py が変異ごとに pytest を流す' },
      testListing: 'testgate_prune_plugin（pytest の nodeid）', mutateFiles: targets, tests: finalTests.length, excluded, baselineExcluded: { failed: baseFailed, collect: baseCollect },
      sampled: { ...sampled, seed: String(seed) }, baselineMs: baseMs, mutantTimeoutMs: mutantTimeout, testTimeoutMs, jobs: workers,
    }, null, 2) + '\n')
    return { status: run.status === 0 ? 0 : 1, runner: 'pytest', sampled, excluded, preflightExcluded: [], dryRunExcluded: [...baseFailed, ...baseCollect], notes }
  } finally {
    if (!keepSandbox) { try { rmSync(base, { recursive: true, force: true }) } catch { /* 本体が TMPDIR の根ごと消す */ } }
  }
}
