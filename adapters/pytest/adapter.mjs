// testgate アダプタ: pytest（契約 v0.3）。外部依存なし。
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'

export const id = 'pytest'
export const runners = ['pytest', 'python -m pytest', 'uv run pytest', 'poetry run pytest']

const PROBE_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// argv の解釈
// ---------------------------------------------------------------------------

// `uv run` が値を取るオプション（無いと値を位置引数と誤読する）。
const UV_VALUE_OPTS = new Set([
  '--with', '--with-editable', '--with-requirements', '--python', '-p', '--group', '--extra',
  '--directory', '--project', '--env-file', '--package', '--index', '--default-index',
  '--index-url', '--extra-index-url', '--find-links', '--config-file', '--no-binary-package',
  '--only-group', '--exclude-newer', '--index-strategy',
])
const POETRY_VALUE_OPTS = new Set(['--directory', '-C', '--project', '-P'])
const PYTHON_VALUE_OPTS = new Set(['-W', '-X', '-Q'])

// pytest が値を取るオプション。値を位置引数（テスト指定）と取り違えないために要る。
const PYTEST_VALUE_OPTS = new Set([
  '-k', '-m', '-p', '-c', '-o', '-W', '-r', '-n',
  '--rootdir', '--confcutdir', '--maxfail', '--tb', '--durations', '--durations-min',
  '--junitxml', '--junit-xml', '--junit-prefix', '--ignore', '--ignore-glob', '--deselect',
  '--basetemp', '--import-mode', '--capture', '--color', '--code-highlight', '--log-level',
  '--log-format', '--log-date-format', '--log-file', '--log-file-level', '--log-file-format',
  '--log-file-date-format', '--log-cli-level', '--log-cli-format', '--log-cli-date-format',
  '--assert', '--override-ini', '--pythonwarnings', '--cov', '--cov-report', '--cov-config',
  '--cov-fail-under', '--dist', '--numprocesses', '--maxprocesses', '--timeout', '--reruns',
  '--reruns-delay', '--randomly-seed', '--testmon-env', '--tmnet-url', '--doctest-glob',
  '--durations-min', '--tb-style', '--show-capture', '--stepwise-skip', '--max-worker-restart',
  '--tx', '--rsyncdir', '--cache-dir', '--setuponly-fixture',
])

// テストを走らせない呼び方。
const NON_RUNNING_FLAGS = new Set([
  '--version', '-V', '-h', '--help', '--collect-only', '--co', '--fixtures', '--funcargs',
  '--fixtures-per-test', '--markers', '--setup-plan',
])

// 人が範囲を絞っている指定（これがあれば触らない）。
const NARROWING_FLAGS = new Set([
  '-k', '-m', '--lf', '--last-failed', '--sw', '--stepwise', '--pyargs', '--nf', '--new-first',
])
// testmon を人が制御している指定。
const TESTMON_FLAG_RE = /^--(testmon|no-testmon|tmnet)/

const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
const GLOB_RE = /[*?[]/

function baseName(token) {
  return basename(String(token).replaceAll('\\', '/')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
}

function isPython(name) {
  return /^python(\d+(\.\d+)*)?$/.test(name) || name === 'py'
}

// ランナー部分を解釈する。{ end, kind, envAssigns } か null。
// end は pytest 本体のトークンの次の添字（フラグを差し込む位置）。
function parseRunner(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return null
  let i = 0
  const envAssigns = {}
  while (i < argv.length && ENV_ASSIGN_RE.test(argv[i])) {
    const eq = argv[i].indexOf('=')
    envAssigns[argv[i].slice(0, eq)] = argv[i].slice(eq + 1)
    i++
  }
  if (i >= argv.length) return null
  const first = baseName(argv[i])

  if (first === 'pytest' || first === 'py.test') {
    return { end: i + 1, kind: 'pytest', envAssigns, start: i }
  }
  if (isPython(first)) {
    return parsePythonModule(argv, i + 1, 'python', envAssigns, i)
  }
  if (first === 'uv' || first === 'poetry') {
    if (argv[i + 1] !== 'run') return null
    const valueOpts = first === 'uv' ? UV_VALUE_OPTS : POETRY_VALUE_OPTS
    let j = i + 2
    while (j < argv.length && argv[j].startsWith('-')) {
      j += valueOpts.has(argv[j]) ? 2 : 1
    }
    if (j >= argv.length) return null
    const inner = parseRunner(argv.slice(j))
    if (!inner || inner.start !== 0 || Object.keys(inner.envAssigns).length) return null
    return { end: inner.end + j, kind: first, envAssigns, start: i }
  }
  return null
}

function parsePythonModule(argv, from, kind, envAssigns, start) {
  let j = from
  while (j < argv.length) {
    const t = argv[j]
    if (t === '-m') {
      if (argv[j + 1] === 'pytest') return { end: j + 2, kind, envAssigns, start }
      return null
    }
    if (!t.startsWith('-')) return null // スクリプト実行
    j += PYTHON_VALUE_OPTS.has(t) ? 2 : 1
  }
  return null
}

// ランナーの後ろの引数を分類する。
function parseArgs(args, cwd) {
  const out = {
    nonRunning: false,
    narrowing: null, // 人が絞った理由（文字列）
    testmonControlled: null,
    named: [],
    selectable: [], // ディレクトリ・glob・「全部」の指定
  }
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (t === '--') {
      for (const rest of args.slice(i + 1)) classifyPositional(rest, cwd, out)
      break
    }
    if (t.startsWith('-')) {
      const name = t.includes('=') && t.startsWith('--') ? t.slice(0, t.indexOf('=')) : t
      if (NON_RUNNING_FLAGS.has(name)) out.nonRunning = true
      if (NARROWING_FLAGS.has(name) && !out.narrowing) out.narrowing = name
      // -kEXPR / -mEXPR（値が直結した短い形）
      if (/^-[km]./.test(t) && !t.startsWith('--') && !out.narrowing) out.narrowing = t.slice(0, 2)
      if (TESTMON_FLAG_RE.test(name)) out.testmonControlled = name
      // 値を次のトークンに取るオプションは、値を飛ばす
      if (PYTEST_VALUE_OPTS.has(t)) {
        const value = args[i + 1]
        if (t === '-p' && typeof value === 'string' && /^no:(testmon|cacheprovider)$/.test(value)) {
          out.testmonControlled = `-p ${value}`
        }
        i++
      } else if (/^-p.+/.test(t) && /^-pno:(testmon|cacheprovider)$/.test(t)) {
        out.testmonControlled = t
      }
      continue
    }
    classifyPositional(t, cwd, out)
  }
  return out
}

function classifyPositional(token, cwd, out) {
  if (token === '.' || token === './') {
    out.selectable.push(token)
    return
  }
  if (token.includes('::')) {
    out.named.push(token)
    return
  }
  if (GLOB_RE.test(token)) {
    out.selectable.push(token)
    return
  }
  if (/[\\/]$/.test(token)) {
    out.selectable.push(token)
    return
  }
  try {
    if (statSync(resolve(cwd ?? '.', token)).isDirectory()) {
      out.selectable.push(token)
      return
    }
  } catch {
    // 無い経路はファイルの名指しとして扱う
  }
  out.named.push(token)
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

export function detect(argv, { cwd, env } = {}) {
  const runner = parseRunner(argv)
  if (!runner) return false
  const args = parseArgs(argv.slice(runner.end), cwd)
  return !args.nonRunning
}

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

const GLOBAL_FILE_RE = [
  /(^|\/)conftest\.py$/,
  /(^|\/)(pytest\.ini|tox\.ini|setup\.cfg|pyproject\.toml)$/,
  /(^|\/)requirements[^/]*\.txt$/,
  /(^|\/)(Pipfile|Pipfile\.lock|poetry\.lock|uv\.lock|pdm\.lock)$/,
]
const DOC_ONLY_RE = /\.(md|rst|adoc)$/i

function toPosix(p) {
  return String(p).replaceAll('\\', '/')
}

function installHint(kind) {
  const how = kind === 'uv'
    ? 'uv add --dev pytest-testmon'
    : kind === 'poetry'
      ? 'poetry add --group dev pytest-testmon'
      : 'pytest を実行する環境（venv）で pip install pytest-testmon'
  return `pytest-testmon が使えない。導入: ${how}`
}

function probeHelp(cmd, cwd, env) {
  return new Promise((resolveProbe) => {
    execFile(
      cmd[0],
      cmd.slice(1),
      { cwd, env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const why = error.killed ? '5秒以内に返らなかった' : error.code === 'ENOENT' ? '実行ファイルが見つからない' : `終了コード ${error.code}`
          resolveProbe({ ok: false, why })
          return
        }
        resolveProbe({ ok: true, text: `${stdout}\n${stderr}` })
      },
    )
  })
}

// probe は試験用の差し込み口（(cmd, {cwd, env}) → Promise<{ok, text?, why?}>）。
export async function select({ argv, cwd, env, changed, base, full, probe } = {}) {
  const original = Array.isArray(argv) ? [...argv] : []
  const runner = parseRunner(original)
  if (!runner) {
    return { argv: original, mode: 'passthrough', reason: 'pytest: pytest の呼び方として解釈できないので触らない' }
  }
  if (full) {
    return { argv: original, mode: 'full', reason: 'pytest: 全部流す指定（TESTGATE_FULL）' }
  }
  const changedFiles = (changed ?? []).map(toPosix)
  if (changedFiles.length === 0) {
    return { argv: original, mode: 'none', reason: 'pytest: 変更が無いので流す物が無い' }
  }

  const args = parseArgs(original.slice(runner.end), cwd)
  if (args.narrowing) {
    return { argv: original, mode: 'passthrough', reason: `pytest: 人が範囲を絞っている（${args.narrowing}）ので触らない` }
  }
  if (args.named.length > 0) {
    return { argv: original, mode: 'passthrough', reason: `pytest: テストを名指ししている（${args.named[0]}）ので触らない` }
  }
  if (args.testmonControlled) {
    return { argv: original, mode: 'passthrough', reason: `pytest: testmon を人が指定している（${args.testmonControlled}）ので触らない` }
  }

  if (changedFiles.every((f) => DOC_ONLY_RE.test(f))) {
    return { argv: original, mode: 'none', reason: 'pytest: 変更が文書（md/rst/adoc）だけなので流す物が無い' }
  }

  // testmon が入っているか。pytest の --help を同じ実行環境で呼んで確かめる。
  const mergedEnv = { ...process.env, ...(env ?? {}), ...runner.envAssigns }
  const helpCmd = [...original.slice(runner.start, runner.end), '--help']
  const probed = await (probe ?? probeHelp)(helpCmd, cwd, mergedEnv)
  if (!probed.ok) {
    return {
      argv: original,
      mode: 'passthrough',
      reason: `pytest: pytest --help が使えず testmon の有無を判定できない（${probed.why}）。${installHint(runner.kind)}`,
    }
  }
  if (!/--testmon\b/.test(probed.text)) {
    return { argv: original, mode: 'passthrough', reason: `pytest: ${installHint(runner.kind)}` }
  }

  const withFlag = (flag) => [...original.slice(0, runner.end), flag, ...original.slice(runner.end)]

  // 全体に効くファイルは testmon が追跡しない（pytest.ini など）ので、選ばずに全部流す。
  // --testmon-noselect は全部流しつつ testmon の依存表を更新する。
  const globalFile = changedFiles.find((f) => GLOBAL_FILE_RE.some((re) => re.test(f)))
  if (globalFile) {
    return {
      argv: withFlag('--testmon-noselect'),
      mode: 'full',
      reason: `pytest: 全体に効くファイル（${globalFile}）が変わったので全部流す。testmon は設定ファイルの変更を追跡しないため --testmon-noselect で選択を止める`,
    }
  }

  // testmon のデータは cwd の .testmondata（TESTMON_DATAFILE で変更可）。
  const dataRel = mergedEnv.TESTMON_DATAFILE || '.testmondata'
  const dataPath = resolve(cwd ?? '.', dataRel)
  let hasData = false
  try {
    hasData = existsSync(dataPath) && statSync(dataPath).size > 0
  } catch {
    hasData = false
  }
  if (!hasData) {
    return {
      argv: withFlag('--testmon'),
      mode: 'full',
      reason: `pytest: 初回。依存の表（${basename(dataPath)}）を作るため全部流れる`,
    }
  }
  return {
    argv: withFlag('--testmon'),
    mode: 'subset',
    reason: 'pytest: pytest-testmon が前回実行からの変更に関わるテストだけを選ぶ',
  }
}

// ---------------------------------------------------------------------------
// parseOutput / stripCounts
// ---------------------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g
const COUNT_PART = '\\d+ [A-Za-z]+(?: [A-Za-z]+)?'
// 「N passed, M failed in 0.12s」。`=== ... ===` の枠や rtk の `Pytest: ` 接頭辞が付くこともある。
const SUMMARY_RE = new RegExp(
  `^(?:=+\\s*)?(?:Pytest:\\s*)?((?:${COUNT_PART})(?:,\\s*${COUNT_PART})*|no tests ran)\\s+in\\s+([\\d.]+)s(?:\\s*\\(\\d+:\\d{2}:\\d{2}\\))?(?:\\s*=+)?$`,
)
// 実行時間の無い形（`4 deselected` だけの枠付き行など）
const COUNT_ONLY_RE = new RegExp(`^=+\\s*((?:${COUNT_PART})(?:,\\s*${COUNT_PART})*)\\s*=+$`)

function cleanLines(text) {
  return String(text ?? '').replace(ANSI_RE, '').split(/\r?\n/)
}

function parseCountPart(spec) {
  const counts = {}
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s+([A-Za-z]+)/.exec(part)
    if (!m) continue
    const word = m[2].toLowerCase().replace(/^(errors|warnings|reruns)$/, (w) => w.slice(0, -1))
    counts[word] = (counts[word] ?? 0) + Number(m[1])
  }
  return counts
}

export function parseOutput(text) {
  const lines = cleanLines(text)
  let summary = null
  for (const line of lines) {
    const s = line.trim()
    const m = SUMMARY_RE.exec(s)
    if (m) summary = { spec: m[1], seconds: Number(m[2]) }
  }
  const result = {}
  if (summary) {
    const c = summary.spec === 'no tests ran' ? {} : parseCountPart(summary.spec)
    result.passed = c.passed ?? 0
    // failed は落ちた物の合計。errors（収集エラーなど）はその内訳。
    result.errors = c.error ?? 0
    result.failed = (c.failed ?? 0) + result.errors
    result.skipped = c.skipped ?? 0
    result.durationMs = Math.round(summary.seconds * 1000)
  }
  const failures = extractFailures(lines)
  if (failures.length) result.failures = failures.slice(0, 50)
  return result
}

function extractFailures(lines) {
  const found = []
  const add = (name) => {
    if (name && !found.includes(name)) found.push(name)
  }
  // 1. 短い要約 `FAILED path::test - message` / `ERROR path::test`
  for (const raw of lines) {
    const m = /^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s+.*)?$/.exec(raw.trim())
    if (m) add(m[2])
  }
  if (found.length) return found
  // 2. rtk 短縮後 `N. [FAIL] name` の次行 `path:line: in name`
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\d+\.\s+\[(?:FAIL|ERROR)\]\s+(\S+)/.exec(lines[i])
    if (!m) continue
    const loc = /^\s*(\S+?):\d+:/.exec(lines[i + 1] ?? '')
    add(loc ? `${loc[1]}::${m[1]}` : m[1])
  }
  if (found.length) return found
  // 3. 要約の無い形: `____ test_name ____` の見出しと `ERROR collecting x`
  let inFailures = false
  for (const raw of lines) {
    const s = raw.trim()
    if (/^=+ (FAILURES|ERRORS) =+$/.test(s)) {
      inFailures = true
      continue
    }
    if (/^=+ .* =+$/.test(s)) inFailures = false
    const c = /^_+ ERROR collecting (\S+) _+$/.exec(s)
    if (c) {
      add(c[1])
      continue
    }
    const h = /^_{2,} (.+?) _{2,}$/.exec(s)
    if (inFailures && h) add(h[1])
  }
  return found
}

// `tests/test_calc.py ..F  [ 50%]` や `.F..  [100%]` のような進捗行。
const PROGRESS_RE = /^(?:(\S+\.py)\s+)?([.FEsxX]+)\s*(?:\[\s*\d+%\])?$/

export function stripCounts(text) {
  const out = []
  for (const raw of String(text ?? '').split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '')
    const eol = raw.slice(line.length)
    const plain = line.replace(ANSI_RE, '').trim()

    if (SUMMARY_RE.test(plain) || COUNT_ONLY_RE.test(plain)) continue
    if (/^collected \d+ items?\b/.test(plain)) continue
    if (/^collecting \.\.\. collected \d+ items?\b/.test(plain)) continue
    if (/^testmon: .*unchanged files:\s*\d+/.test(plain)) continue
    if (/^\S+::\S+\s+PASSED(\s+\[\s*\d+%\])?$/.test(plain)) continue

    const p = PROGRESS_RE.exec(plain)
    if (p && /\S/.test(plain)) {
      const marks = p[2].replace(/[.sxX]/g, '')
      if (marks === '') continue // 通過だけの行
      out.push(`${p[1] ? `${p[1]} ` : ''}${marks}${eol}`)
      continue
    }
    out.push(line + eol)
  }
  return out.join('')
}
