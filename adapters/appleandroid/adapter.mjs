// testgate アダプタ: swift test / xcodebuild test / gradle test（契約 v0.3）
// 外部依存なし。select はテストを実行せず、ファイルを読むだけ（gradle のモジュール解決）。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// gradle に成功した件数も出させる init script。adapter.mjs と同じ場所に置く（関所が置き場を変えても付いてくる）
const GRADLE_INIT = fileURLToPath(new URL('./gradle-testlogging.init.gradle', import.meta.url))

export const id = 'appleandroid'
export const runners = ['swift test', 'xcodebuild test', 'gradle test']

// ───────────────────────── 共通: コマンドの正規化 ─────────────────────────

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const WRAPPERS = new Set(['env', 'time', 'nice', 'nohup', 'caffeinate', 'xcrun', 'arch', 'command', 'exec'])
const WRAPPER_VALUE_OPTS = new Set(['-n', '--sdk', '-sdk', '--toolchain', '-toolchain', '-u'])

function baseName(t) {
  const b = String(t).split(/[\\/]/).pop().toLowerCase()
  return b.replace(/\.(exe|bat|cmd)$/, '')
}

// 先頭の環境変数代入とラッパー（env・time・xcrun など）を外し、{ tool, args, offset } を返す。
// tool は 'swift' | 'xcodebuild' | 'gradle' | null。offset は argv 中で tool の位置。
function normalize(argv) {
  const a = argv.map(String)
  let i = 0
  while (i < a.length) {
    const t = a[i]
    const b = baseName(t)
    if (ASSIGN.test(t)) { i++; continue }
    if (WRAPPERS.has(b)) {
      i++
      while (i < a.length && (a[i].startsWith('-') || ASSIGN.test(a[i]))) {
        const opt = a[i]
        i++
        if (WRAPPER_VALUE_OPTS.has(opt) && i < a.length) i++
      }
      continue
    }
    break
  }
  if (i >= a.length) return { tool: null, args: [], offset: i }
  let b = baseName(a[i])
  if ((b === 'sh' || b === 'bash' || b === 'zsh') && a[i + 1] && baseName(a[i + 1]) === 'gradlew') {
    return { tool: 'gradle', args: a.slice(i + 2), offset: i + 2 }
  }
  if (b === 'swift') return { tool: 'swift', args: a.slice(i + 1), offset: i + 1 }
  if (b === 'swift-test') return { tool: 'swift', args: ['test', ...a.slice(i + 1)], offset: i + 1, implicitTest: true }
  if (b === 'xcodebuild') return { tool: 'xcodebuild', args: a.slice(i + 1), offset: i + 1 }
  if (b === 'gradle' || b === 'gradlew') return { tool: 'gradle', args: a.slice(i + 1), offset: i + 1 }
  return { tool: null, args: [], offset: i }
}

// ───────────────────────── swift ─────────────────────────

const SWIFT_VALUE_OPTS = new Set([
  '--package-path', '-C', '--scratch-path', '--build-path', '-c', '--configuration', '--cache-path',
  '--config-path', '--security-path', '--sdk', '--triple', '--toolchain', '--swift-sdk', '-Xswiftc',
  '-Xcc', '-Xlinker', '-Xcxx', '-Xbuild-tools-swiftc', '-Xmanifest', '--jobs', '-j', '--sanitize',
  '--build-system', '--netrc-file', '--manifest-cache', '--pkg-config-path', '--enable-experimental-prebuilts',
  '--filter', '--skip', '--num-workers', '--xunit-output', '--test-product', '--experimental-event-stream-output',
  '--event-stream-output-path', '--attachments-path', '--traits', '--vv'
])
const SWIFT_NOT_RUNNING = new Set([
  '--help', '-h', '-help', '--help-hidden', '--version', '-version', '--list-tests', '-l',
  '--show-codecov-path', '--show-code-coverage-path'
])

// swift の args から { sub, rest(subコマンド以降のトークン) } を返す
function swiftSplit(args) {
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (t.startsWith('-')) {
      if (SWIFT_VALUE_OPTS.has(t) && i + 1 < args.length) i++
      continue
    }
    return { sub: t, before: args.slice(0, i), rest: args.slice(i + 1) }
  }
  return { sub: null, before: args, rest: [] }
}

function swiftInfo(args) {
  const { sub, before, rest } = swiftSplit(args)
  if (before.some(t => SWIFT_NOT_RUNNING.has(t))) return { runs: false }
  if (sub !== 'test') return { runs: false }
  if (rest.some(t => SWIFT_NOT_RUNNING.has(t))) return { runs: false }
  if (rest[0] === 'list') return { runs: false } // swift test list
  const narrowed = []
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i]
    const name = t.split('=')[0]
    if (name === '--filter' || name === '--skip') narrowed.push(t)
    if (SWIFT_VALUE_OPTS.has(t) && !t.includes('=') && i + 1 < rest.length) i++
  }
  return { runs: true, narrowed }
}

// ───────────────────────── xcodebuild ─────────────────────────

const XC_TEST_ACTIONS = new Set(['test', 'test-without-building'])
const XC_ACTIONS = new Set([
  'build', 'analyze', 'archive', 'test', 'test-without-building', 'build-for-testing', 'installsrc',
  'install', 'installhdrs', 'installapi', 'clean', 'docbuild'
])
const XC_VALUE_OPTS = new Set([
  '-project', '-workspace', '-scheme', '-target', '-configuration', '-sdk', '-arch', '-destination',
  '-destination-timeout', '-derivedDataPath', '-xcconfig', '-resultBundlePath', '-resultBundleVersion',
  '-resultStreamPath', '-testPlan', '-toolchain', '-exportPath', '-archivePath', '-exportOptionsPlist',
  '-test-iterations', '-clonedSourcePackagesDirPath', '-packageCachePath', '-jobs', '-maximum-concurrent-test-device-destinations',
  '-maximum-concurrent-test-simulator-destinations', '-parallel-testing-worker-count', '-parallel-testing-enabled',
  '-enableCodeCoverage', '-testLanguage', '-testRegion', '-test-timeouts-enabled', '-default-test-execution-time-allowance',
  '-maximum-test-execution-time-allowance', '-xctestrun', '-scmProvider', '-IDECustomBuildProductsPath'
])
const XC_INFO_FLAGS = new Set([
  '-showBuildSettings', '-showsdks', '-showdestinations', '-showTestPlans', '-list', '-version', '-help',
  '-usage', '-license', '-checkFirstLaunchStatus', '-runFirstLaunch', '-enumerate-tests', '-dry-run', '-n',
  '-showBuildSettingsForIndex', '-exportArchive', '-exportLocalizations', '-importLocalizations',
  '-exportNotarizedApp', '-resolvePackageDependencies', '-downloadAllPlatforms', '-downloadPlatform'
])

function xcodebuildInfo(args) {
  const actions = []
  const narrowed = []
  let info = false
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (ASSIGN.test(t)) continue // KEY=VALUE のビルド設定
    if (t.startsWith('-')) {
      const name = t.split(':')[0]
      if (XC_INFO_FLAGS.has(t) || XC_INFO_FLAGS.has(name)) info = true
      if (name === '-only-testing' || name === '-skip-testing' || name === '-only-test-configuration' ||
          name === '-skip-test-configuration') {
        narrowed.push(t)
        // 「-only-testing Target/Class」と値が別トークンの書き方も許す
        if (!t.includes(':') && args[i + 1] && !args[i + 1].startsWith('-') && !XC_ACTIONS.has(args[i + 1])) {
          narrowed.push(args[i + 1]); i++
        }
        continue
      }
      if (name === '-testPlan') narrowed.push(t)
      if (XC_VALUE_OPTS.has(t)) { if (i + 1 < args.length) i++; continue }
      const next = args[i + 1]
      const boolLike = XC_INFO_FLAGS.has(t) || t === '-quiet' || t === '-verbose' || t === '-json'
      if (!boolLike && next && !next.startsWith('-') && !XC_ACTIONS.has(next) && !ASSIGN.test(next)) i++
      continue
    }
    if (XC_ACTIONS.has(t)) actions.push(t)
  }
  const runs = !info && actions.some(a => XC_TEST_ACTIONS.has(a))
  return { runs, narrowed }
}

// ───────────────────────── gradle ─────────────────────────

const GRADLE_VALUE_OPTS = new Set([
  '-b', '--build-file', '-c', '--settings-file', '-g', '--gradle-user-home', '-I', '--init-script',
  '-p', '--project-dir', '-x', '--exclude-task', '--console', '--warning-mode', '--max-workers',
  '--priority', '--include-build', '--project-cache-dir', '--configuration-cache-problems',
  '--update-locks', '-F', '--dependency-verification', '-M', '--write-verification-metadata',
  '--tests', '--project-prop', '--system-prop', '--task', '--configuration', '--dependency',
  '--tests-per-fork', '--warning', '-C', '--cache', '--init', '--type'
])
// build は check を通じてテストも流す。detect は true にし、select は full（argv は変えない）にする
function isBuildTaskName(name) {
  return name === 'build' || name === 'buildNeeded' || name === 'buildDependents'
}

const GRADLE_INFO_FLAGS = new Set([
  '-h', '--help', '-?', '-v', '--version', '--status', '--stop', '-m', '--dry-run', '--test-dry-run'
])

function isTestTaskName(name) {
  if (name === 'testClasses') return false // テストのコンパイルだけ
  return name === 'test' || name === 'check' || name === 'allTests' ||
    /^test[A-Z0-9]/.test(name) || /Test$/.test(name) || /^connected\w*Check$/.test(name) || name === 'deviceCheck'
}

// args から { tasks, excluded, info, narrowed, projectDir } を取り出す
function gradleParse(args) {
  const tasks = [] // { idx, token, name, qualified }
  const excluded = new Set()
  const narrowed = []
  let info = false
  let projectDir = null
  for (let i = 0; i < args.length; i++) {
    const t = args[i]
    if (t.startsWith('-')) {
      const eq = t.indexOf('=')
      const name = t.startsWith('--') && eq > 0 ? t.slice(0, eq) : t
      const inlineVal = t.startsWith('--') && eq > 0 ? t.slice(eq + 1) : null
      if (GRADLE_INFO_FLAGS.has(name)) info = true
      if (/^-D(test\.single|singleTest)/.test(t)) narrowed.push(t)
      if (t.startsWith('-D') || t.startsWith('-P')) continue // 値は同じトークン内
      if (GRADLE_VALUE_OPTS.has(name)) {
        const val = inlineVal ?? args[i + 1]
        if (inlineVal === null && i + 1 < args.length) i++
        if (name === '--tests') narrowed.push(`--tests ${val}`)
        if (name === '-x' || name === '--exclude-task') excluded.add(String(val).split(':').pop())
        if (name === '-p' || name === '--project-dir') projectDir = val
      }
      continue
    }
    tasks.push({ idx: i, token: t, name: t.split(':').pop(), qualified: t.includes(':') })
  }
  const testTasks = tasks.filter(x => {
    if (excluded.has(x.name)) return false
    if (isTestTaskName(x.name)) return true
    // build は check（test を含む）を走らせる。check か test を外した build は流さない物として扱う
    return isBuildTaskName(x.name) && !excluded.has('check') && !excluded.has('test')
  })
  return { tasks, testTasks, excluded, info, narrowed, projectDir }
}

function gradleInfo(args) {
  const p = gradleParse(args)
  const runs = !p.info && p.testTasks.length > 0
  const narrowed = [...p.narrowed]
  for (const t of p.testTasks) if (t.qualified) narrowed.push(`タスク指定 ${t.token}`)
  return { runs, narrowed, parsed: p }
}

// ───────────────────────── detect ─────────────────────────

function classify(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { tool: null, runs: false, narrowed: [] }
  const n = normalize(argv)
  if (n.tool === 'swift') return { tool: 'swift', ...swiftInfo(n.args), n }
  if (n.tool === 'xcodebuild') return { tool: 'xcodebuild', ...xcodebuildInfo(n.args), n }
  if (n.tool === 'gradle') return { tool: 'gradle', ...gradleInfo(n.args), n }
  return { tool: null, runs: false, narrowed: [] }
}

export function detect(argv, { cwd, env } = {}) {
  return classify(argv).runs === true
}

// ───────────────────────── select ─────────────────────────

const DOC_EXT = /\.(md|markdown|txt|rst|adoc)$/i
const DOC_NAMES = /^(license|licence|notice|authors|changelog|contributing|codeowners|\.gitignore|\.gitattributes|\.editorconfig)(\..*)?$/i
const TOOLING_DIRS = /^(\.github|\.idea|\.vscode|\.git|docs?)\//
const CODE_DIRS = /(^|\/)(src|Sources|Tests)\//

function isDocOnly(rel) {
  const p = rel.replace(/\\/g, '/')
  if (CODE_DIRS.test(p)) return false
  const base = p.split('/').pop()
  return DOC_EXT.test(base) || DOC_NAMES.test(base) || TOOLING_DIRS.test(p)
}

function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function readSafe(p) {
  try { return readFileSync(p, 'utf8') } catch { return null }
}

function findUp(start, names) {
  let dir = path.resolve(start)
  for (;;) {
    for (const n of names) if (existsSync(path.join(dir, n))) return { dir, file: path.join(dir, n) }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

function findGitRoot(start) {
  const r = findUp(start, ['.git'])
  return r ? r.dir : null
}

function toAccessor(modPath) {
  // ':core:my-lib' → 'core.myLib'
  return modPath.split(':').filter(Boolean).map(seg =>
    seg.replace(/[-_]+([A-Za-z0-9])/g, (_, c) => c.toUpperCase())).join('.')
}

const BUILD_WIDE_BASENAMES = /^(settings|build)\.gradle(\.kts)?$|^gradle\.properties$|^gradle\.lockfile$|\.lockfile$|^libs\.versions\.toml$|^gradlew(\.bat)?$|^local\.properties$|\.gradle(\.kts)?$/
const BUILD_WIDE_DIRS = /(^|\/)(buildSrc|build-logic|gradle|\.gradle)\//

function buildWideReason(rel) {
  const p = rel.replace(/\\/g, '/')
  const base = p.split('/').pop()
  if (BUILD_WIDE_BASENAMES.test(base) || BUILD_WIDE_DIRS.test(p)) return p
  return null
}

function loadGradleModules(rootDir, settingsFile) {
  const raw = readSafe(settingsFile)
  if (raw == null) return { error: 'settings を読めない' }
  const text = stripComments(raw)
  if (/\beachDir\b|\blistFiles\b|\.forEach\b|\.each\b|\bfor\s*\(|\bfileTree\b|\bwalk\b/.test(text)) {
    return { error: 'settings が動的にモジュールを決めている' }
  }
  const mods = new Map() // ':a:b' → dir
  const re = /\binclude\b\s*\(?\s*((?:["'][^"']+["']\s*,?\s*)+)/g
  let m
  while ((m = re.exec(text))) {
    for (const q of m[1].matchAll(/["']([^"']+)["']/g)) {
      const mp = ':' + q[1].replace(/^:+/, '')
      mods.set(mp, path.join(rootDir, ...mp.split(':').filter(Boolean)))
    }
  }
  const pd = /project\(\s*["'](:[^"']+)["']\s*\)\s*\.projectDir\s*=\s*(?:file\(\s*|new File\(\s*settingsDir\s*,\s*)["']([^"']+)["']/g
  while ((m = pd.exec(text))) {
    if (mods.has(m[1])) mods.set(m[1], path.resolve(rootDir, m[2]))
  }
  return { mods }
}

function moduleBuildFile(dir) {
  for (const n of ['build.gradle.kts', 'build.gradle']) {
    const p = path.join(dir, n)
    if (existsSync(p)) return p
  }
  return null
}

function hasTestSources(dir, buildText) {
  if (/sourceSets|srcDir/.test(buildText || '')) return true // 場所を変えている。あると見なす
  const src = path.join(dir, 'src')
  try {
    return readdirSync(src).some(n => /test/i.test(n) && statSync(path.join(src, n)).isDirectory())
  } catch { return false }
}

function selectGradle({ argv, cwd, changed, info, n }) {
  const p = info.parsed
  const R = reason => `gradle test: ${reason}`
  const effective = path.resolve(cwd, p.projectDir ?? '.')
  const sf = findUp(effective, ['settings.gradle.kts', 'settings.gradle'])
  if (!sf) return { argv, mode: 'full', reason: R('settings.gradle が見つからない単一プロジェクトか未知の構成。モジュール選択の仕組みが無いので full') }
  const rootDir = sf.dir
  if (path.resolve(effective) !== rootDir) {
    return { argv, mode: 'passthrough', reason: R(`サブプロジェクト内（${path.relative(rootDir, effective) || '.'}）から実行。範囲は既に絞られている`) }
  }
  // 全体に効くファイル
  const gitRoot = findGitRoot(rootDir) ?? rootDir
  for (const c of changed) {
    const w = buildWideReason(c)
    if (w) return { argv, mode: 'full', reason: R(`全体に効くファイル ${w} が変わったので full`) }
  }
  const parsed = loadGradleModules(rootDir, sf.file)
  if (parsed.error) return { argv, mode: 'full', reason: R(`${parsed.error}ため full（モジュール選択の仕組みが無い）`) }
  const mods = parsed.mods
  if (mods.size === 0) return { argv, mode: 'full', reason: R('単一プロジェクト。選択の仕組みが無いので full') }
  // タスク名が test / check 以外（variant 名など）だとモジュールによって無く、修飾すると落ちる
  const unsafe = p.testTasks.find(t => t.name !== 'test' && t.name !== 'check')
  if (unsafe) {
    return { argv, mode: 'full', reason: R(`タスク ${unsafe.token} はモジュールごとに有無が違い、修飾すると未定義タスクで落ちるため全モジュールを流す（full）`) }
  }
  const rootBuild = readSafe(path.join(rootDir, 'build.gradle.kts')) ?? readSafe(path.join(rootDir, 'build.gradle')) ?? ''
  if (/\bproject\(\s*["']:/.test(stripComments(rootBuild))) {
    return { argv, mode: 'full', reason: R('ルートの build.gradle が project(\':x\') で依存や設定を書いているため依存表を作れない。full') }
  }
  // changed → モジュール
  const dirs = [...mods.entries()].map(([mp, d]) => [mp, path.resolve(d)]).sort((a, b) => b[1].length - a[1].length)
  const hit = new Set()
  for (const c of changed) {
    const abs = path.resolve(gitRoot, c)
    const found = dirs.find(([, d]) => abs === d || abs.startsWith(d + path.sep))
    if (found) { hit.add(found[0]); continue }
    const relToRoot = path.relative(rootDir, abs).replace(/\\/g, '/')
    if (relToRoot.startsWith('..') || isDocOnly(relToRoot)) continue // 対象プロジェクトの外、または文書
    return { argv, mode: 'full', reason: R(`どのモジュールにも属さないファイル ${relToRoot} が変わったので full`) }
  }
  if (hit.size === 0) return { argv, mode: 'none', reason: R('変更はどのモジュールにも関わらない（プロジェクト外・文書のみ）') }
  // 依存の逆引き
  const deps = new Map() // module → Set<依存先 module>
  const buildTexts = new Map()
  for (const [mp, d] of mods) {
    const bf = moduleBuildFile(d)
    const text = bf ? stripComments(readSafe(bf) ?? '') : ''
    buildTexts.set(mp, text)
    const set = new Set()
    for (const q of text.matchAll(/project\(\s*["'](:[^"']+)["']\s*\)/g)) if (mods.has(q[1])) set.add(q[1])
    for (const [other] of mods) {
      const acc = toAccessor(other)
      if (acc && new RegExp(`\\bprojects\\.${acc.replace(/\./g, '\\.')}(?![A-Za-z0-9_])`).test(text)) set.add(other)
    }
    deps.set(mp, set)
  }
  const closure = new Set(hit)
  for (let grew = true; grew;) {
    grew = false
    for (const [mp, set] of deps) {
      if (closure.has(mp)) continue
      for (const dep of set) if (closure.has(dep)) { closure.add(mp); grew = true; break }
    }
  }
  const buildable = [...closure].filter(mp => moduleBuildFile(mods.get(mp)))
  const withTests = buildable.filter(mp => hasTestSources(mods.get(mp), buildTexts.get(mp)))
  if (withTests.length === 0) {
    return { argv, mode: 'none', reason: R(`変更モジュール ${[...hit].join(' ')} とその依存元にテストが無い`) }
  }
  const allWithBuild = [...mods.keys()].filter(mp => moduleBuildFile(mods.get(mp)))
  if (withTests.length >= allWithBuild.length) {
    return { argv, mode: 'full', reason: R(`変更が全モジュールに及ぶ（${[...hit].join(' ')} が全体の依存元）。full`) }
  }
  withTests.sort()
  const out = []
  const replace = new Map(p.testTasks.map(t => [t.idx, t.name]))
  const args = n.args
  for (let i = 0; i < args.length; i++) {
    if (replace.has(i)) for (const mp of withTests) out.push(`${mp}:${replace.get(i)}`)
    else out.push(args[i])
  }
  const newArgv = [...argv.slice(0, n.offset), ...out]
  return {
    argv: newArgv,
    mode: 'subset',
    reason: R(`変更モジュール ${[...hit].join(' ')} と依存元だけ（${withTests.join(' ')}）。全${allWithBuild.length}モジュール中`)
  }
}

// 人が -I / --init-script を付けていなければ、件数を出させる init script を足す
function withInit(argv, n, parsedArgs) {
  if (parsedArgs.some(t => t === '-I' || t === '--init-script' || t.startsWith('--init-script='))) return argv
  return [...argv.slice(0, n.offset), '-I', GRADLE_INIT, ...argv.slice(n.offset)]
}

export async function select({ argv, cwd = process.cwd(), env, changed = [], base = null, full = false } = {}) {
  const c = classify(argv)
  if (!c.runs) {
    return { argv, mode: 'passthrough', reason: 'appleandroid: テスト実行ではない呼び方。触らない' }
  }
  const label = c.tool === 'swift' ? 'swift test' : c.tool === 'xcodebuild' ? 'xcodebuild test' : 'gradle test'
  if (full) return { argv, mode: 'full', reason: `${label}: 全部流す指定（TESTGATE_FULL）。元の argv のまま` }
  if (c.tool === 'gradle' && c.parsed.testTasks.every(t => isBuildTaskName(t.name)) && c.narrowed.length === 0) {
    // build は変更が無くても build をやめない（none にしない）。件数の記録のための full
    return { argv, mode: 'full', reason: 'gradle test: build は check 経由でテストも流す。build の意味を変えないため argv はそのまま（全部流れる）' }
  }
  if (!changed || changed.length === 0) return { argv, mode: 'none', reason: `${label}: 変更が無い` }
  if (changed.every(isDocOnly)) {
    return { argv, mode: 'none', reason: `${label}: 変更は文書・設定メモだけでテストに関わらない` }
  }
  if (c.narrowed.length > 0) {
    return { argv, mode: 'passthrough', reason: `${label}: 人が範囲を絞っている（${c.narrowed.join(' ')}）` }
  }
  if (c.tool === 'swift') {
    return { argv, mode: 'full', reason: 'swift test: 変更からテストを選ぶ既製の仕組みが無いので full（時間上限は関所側）' }
  }
  if (c.tool === 'xcodebuild') {
    return { argv, mode: 'full', reason: 'xcodebuild test: 変更からテストを選ぶ既製の仕組みが無いので full（時間上限は関所側）' }
  }
  const r = selectGradle({ argv, cwd, changed, info: c, n: c.n })
  if (r.mode === 'subset' || r.mode === 'full') {
    return { ...r, argv: withInit(r.argv, c.n, c.n.args), reason: `${r.reason}（件数のため -I で testLogging を足した）` }
  }
  return r
}

// ───────────────────────── parseOutput ─────────────────────────

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const RE_EXECUTED = /^\s*Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?(?: \((\d+) unexpected\))? in ([\d.]+) \(([\d.]+)\) seconds/
const RE_SUITE_END = /^\s*Test [Ss]uite '(.*)' (?:passed|failed|finished) at /
const RE_CASE = /^\s*Test [Cc]ase '(.+?)' (passed|failed|skipped)(?: on '(.*?)')? \(([\d.]+) seconds\)/
const RE_ST_RUN = /Test run with (\d+) tests?(?: in (\d+) suites?)? (passed|failed)(?: after ([\d.]+) seconds)?(?: with (\d+) issues?)?/
const RE_ST_TEST = /^\s*\S+\s+Test (?!run )(.+?) (passed|failed) after ([\d.]+) seconds/
const RE_ST_SKIP = /^\s*\S+\s+Test (?!run )(.+?) skipped(?:: .*)?\s*$/
const RE_GRADLE_LINE = /^(\S.*?) > (.+) (PASSED|FAILED|SKIPPED)\s*$/
const RE_GRADLE_DONE = /^(\d+) tests? completed(?:, (\d+) failed)?(?:, (\d+) skipped)?\s*$/
const RE_GRADLE_TASK = /^> Task (\S+?)(?: (FAILED|UP-TO-DATE|NO-SOURCE|SKIPPED|FROM-CACHE))?\s*$/
// 収集・ビルドの失敗（テストそのものの失敗ではない物）
const RE_COMPILE_ERR = /^(?:\S.*?:\d+(?::\d+)?: error: |e: )(.+)$/
const RE_XCTEST_ERR = /: error: (?:-\[[^\]]+\]|[\w.]+) : /
const RE_BARE_ERR = /^error: /
const RE_XC_BUILD_FAILED = /^\*\* (?:TEST BUILD|BUILD|ARCHIVE|ANALYZE|CLEAN) FAILED \*\*/
const RE_GRADLE_TIME = /^BUILD (?:SUCCESSFUL|FAILED) in (?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s\s*)?(?:(\d+)ms)?\s*$/

function unquote(s) {
  return s.replace(/^"(.*)"$/, '$1')
}

function isTopSuite(name) {
  return name === 'All tests' || name === 'Selected tests'
}
function isBundleSuite(name) {
  return /\.(xctest|octest|bundle)(\(Tests\))?$/.test(name)
}

export function parseOutput(text) {
  const out = {}
  if (typeof text !== 'string' || text.length === 0) return out
  const lines = text.replace(ANSI, '').split(/\r?\n/)
  const failures = []
  const addFailure = n => { if (n && !failures.includes(n)) failures.push(n) }

  // XCTest
  const topBlocks = []
  const bundleBlocks = []
  const cases = new Map() // key → verdict
  const caseFailedNames = []
  let lastSuite = null
  // Swift Testing
  const stRuns = []
  const stTests = new Map()
  // gradle
  const gradleLines = new Map()
  const gradleDone = []
  const gradleTasks = []
  let gradleMs
  // Failing tests: ブロック
  let inFailing = false
  // ビルド失敗
  const compileErrors = new Set()
  const bareErrors = new Set()
  let xcBuildFailed = false
  let gradleBuildFailed = false
  let gradleFailureHeader = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (inFailing) {
      const m = /^\s+(\S.*)$/.exec(line)
      if (m && !/^\s*(Test|Executed|\*\*)/.test(line)) { addFailure(m[1].trim()); continue }
      inFailing = false
    }
    if (/^Failing tests:\s*$/.test(line)) { inFailing = true; continue }

    let m
    if (RE_XC_BUILD_FAILED.test(line)) { xcBuildFailed = true; continue }
    if ((m = RE_COMPILE_ERR.exec(line)) && !RE_XCTEST_ERR.test(line)) { compileErrors.add(line.trim()); continue }
    if (RE_BARE_ERR.test(line)) { bareErrors.add(line.trim()); continue }
    if (/^FAILURE: Build failed with an exception\./.test(line)) gradleFailureHeader = true
    if (/^BUILD FAILED in /.test(line)) gradleBuildFailed = true
    m = RE_SUITE_END.exec(line)
    if (m) { lastSuite = m[1]; continue }
    m = RE_EXECUTED.exec(line)
    if (m) {
      const block = {
        total: +m[1], skipped: m[2] ? +m[2] : 0, failures: +m[3],
        ms: Math.round(parseFloat(m[6]) * 1000)
      }
      if (lastSuite !== null) {
        if (isTopSuite(lastSuite)) topBlocks.push(block)
        else if (isBundleSuite(lastSuite)) bundleBlocks.push(block)
      }
      lastSuite = null
      continue
    }
    m = RE_CASE.exec(line)
    if (m) {
      const key = `${m[1]}\u0000${m[3] ?? ''}`
      cases.set(key, m[2])
      if (m[2] === 'failed') caseFailedNames.push(m[1].replace(/^-\[(.*)\]$/, '$1'))
      continue
    }
    m = RE_ST_RUN.exec(line)
    if (m) {
      stRuns.push({
        total: +m[1], verdict: m[3], ms: m[4] ? Math.round(parseFloat(m[4]) * 1000) : undefined,
        issues: m[5] ? +m[5] : 0
      })
      continue
    }
    m = RE_ST_TEST.exec(line)
    if (m) { stTests.set(unquote(m[1]), m[2]); continue }
    m = RE_ST_SKIP.exec(line)
    if (m) { stTests.set(unquote(m[1]), 'skipped'); continue }
    m = RE_GRADLE_LINE.exec(line)
    if (m) { gradleLines.set(`${m[1]} > ${m[2]}`, m[3]); continue }
    m = RE_GRADLE_DONE.exec(line)
    if (m) { gradleDone.push({ total: +m[1], failed: m[2] ? +m[2] : 0, skipped: m[3] ? +m[3] : 0 }); continue }
    m = RE_GRADLE_TASK.exec(line)
    if (m) { gradleTasks.push({ name: m[1], state: m[2] ?? 'ran' }); continue }
    m = RE_GRADLE_TIME.exec(line)
    if (m && (m[1] || m[2] || m[3] || m[4])) {
      gradleMs = ((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000 + (+m[4] || 0)
    }
  }

  let total = 0, failed = 0, skipped = 0, durationMs
  let any = false
  let known = true

  // XCTest 部分
  const xblocks = topBlocks.length ? topBlocks : bundleBlocks
  if (xblocks.length) {
    const t = xblocks.reduce((s, b) => s + b.total, 0)
    // 古い Xcode の要約は skipped を数えない。ケース行にあればそちらを採る
    const caseSkipped = [...cases.values()].filter(v => v === 'skipped').length
    const sk = Math.max(xblocks.reduce((s, b) => s + b.skipped, 0), caseSkipped)
    const f = xblocks.reduce((s, b) => s + b.failures, 0)
    // 要約の「failures」は失敗した表明の数。失敗したテストの名前が取れていればそちらを数にする
    const uniqueFailed = new Set(caseFailedNames)
    const ff = uniqueFailed.size > 0 ? uniqueFailed.size : f
    total += t; skipped += sk; failed += ff
    durationMs = (durationMs ?? 0) + xblocks.reduce((s, b) => s + b.ms, 0)
    any = true
    for (const n of uniqueFailed) addFailure(n)
  } else if (cases.size > 0) {
    const verdicts = [...cases.values()]
    total += verdicts.length
    failed += verdicts.filter(v => v === 'failed').length
    skipped += verdicts.filter(v => v === 'skipped').length
    for (const n of new Set(caseFailedNames)) addFailure(n)
    any = true
  }

  // Swift Testing 部分
  if (stRuns.length) {
    for (const r of stRuns) {
      total += r.total
      if (r.ms !== undefined) durationMs = (durationMs ?? 0) + r.ms
    }
    const names = [...stTests.entries()]
    const stFailed = names.filter(([, v]) => v === 'failed')
    const stSkipped = names.filter(([, v]) => v === 'skipped').length
    if (stRuns.some(r => r.verdict === 'failed') && stFailed.length === 0) known = false
    failed += stFailed.length
    skipped += stSkipped
    for (const [n] of stFailed) addFailure(n)
    any = true
  } else if (stTests.size > 0 && !xblocks.length && cases.size === 0) {
    const names = [...stTests.values()]
    total += names.length
    failed += names.filter(v => v === 'failed').length
    skipped += names.filter(v => v === 'skipped').length
    for (const [n, v] of stTests) if (v === 'failed') addFailure(n)
    any = true
  }

  // gradle
  if (!any) {
    // 既定の出力は失敗行しか出さない。PASSED 行がある（testLogging で出した）時だけ行を数える
    if ([...gradleLines.values()].includes('PASSED')) {
      const v = [...gradleLines.values()]
      const f = v.filter(x => x === 'FAILED').length
      const s = v.filter(x => x === 'SKIPPED').length
      total += v.length; failed += f; skipped += s
      for (const [n, x] of gradleLines) if (x === 'FAILED') addFailure(n)
      any = true
    } else if (gradleDone.length > 0) {
      for (const [n, x] of gradleLines) if (x === 'FAILED') addFailure(n)
      const f = gradleDone.reduce((s, d) => s + d.failed, 0)
      const sk = gradleDone.reduce((s, d) => s + d.skipped, 0)
      const t = gradleDone.reduce((s, d) => s + d.total, 0)
      // 通ったテストタスクの件数は既定の出力に出ない。失敗タスクだけなら合計が分かる
      const isTestTask = x => /:(test\w*|\w*Test)$/.test(x.name) || /^(test\w*|\w*Test)$/.test(x.name)
      const ranOk = gradleTasks.filter(x => isTestTask(x) && x.state !== 'FAILED' && x.state !== 'NO-SOURCE' && x.state !== 'SKIPPED')
      if (ranOk.length > 0) {
        total = undefined // 通ったタスクの件数が不明
        failed += f; skipped += sk
        known = false
      } else {
        total += t; failed += f; skipped += sk
      }
      any = true
    }
  }

  if (any && known && total !== undefined) {
    out.passed = Math.max(0, total - failed - skipped)
    out.failed = failed
    out.skipped = skipped
  } else if (any && gradleDone.length > 0 && !xblocks.length && !stRuns.length) {
    out.failed = failed
    out.skipped = skipped
  }
  // errors: コンパイル・ビルド・依存解決などの失敗。failed にも数える
  const isTestTaskName = n => /(^|:)(test\w*|\w*Test|check|allTests)$/.test(n)
  const nonTestFailedTasks = gradleTasks.filter(t => t.state === 'FAILED' && !isTestTaskName(t.name)).length
  const testTaskFailed = gradleTasks.some(t => t.state === 'FAILED' && isTestTaskName(t.name)) || gradleDone.length > 0
  let errors
  if (compileErrors.size > 0) errors = compileErrors.size
  else if (xcBuildFailed) errors = 1
  else if (nonTestFailedTasks > 0) errors = nonTestFailedTasks
  else if (gradleFailureHeader && gradleBuildFailed && !testTaskFailed && gradleLines.size === 0) errors = 1
  else if (bareErrors.size > 0 && !any) errors = 1
  if (errors) {
    out.errors = errors
    out.failed = (out.failed ?? 0) + errors
    if (!(any && known && total !== undefined)) delete out.passed
    for (const e of [...compileErrors].slice(0, 5)) addFailure(e)
  }
  if (durationMs === undefined && gradleMs !== undefined) durationMs = gradleMs
  if (durationMs !== undefined && (any || gradleMs !== undefined)) out.durationMs = durationMs
  // rtk test はこれらのランナーを知らず末尾5行に切る。件数は一部しか見えないので出さない（名前だけ残す）
  if (/^OUTPUT \(last \d+ lines\):/m.test(text)) {
    delete out.passed; delete out.failed; delete out.skipped; delete out.errors; delete out.durationMs
  }
  if (failures.length) out.failures = failures.slice(0, 50)
  return out
}

// ───────────────────────── stripCounts ─────────────────────────

const COUNT_LINES = [
  RE_EXECUTED,
  /^\s*\S*\s*Test run with \d+ tests?\b/,
  RE_GRADLE_DONE,
  /^\d+ errors?\s*$/,
  /^\d+ (?:errors?|warnings?)(?: and \d+ warnings?)? generated\.\s*$/
]

export function stripCounts(text) {
  if (typeof text !== 'string' || text.length === 0) return text ?? ''
  const nl = text.includes('\r\n') ? '\r\n' : '\n'
  const kept = text.split(/\r?\n/).filter(line => {
    const plain = line.replace(ANSI, '')
    return !COUNT_LINES.some(re => re.test(plain))
  })
  return kept.join(nl)
}
