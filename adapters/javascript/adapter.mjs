// testgate JavaScript アダプタ（Jest・Vitest・node --test）。
// 契約: testgate-adapter-contract.md v0.4。外部依存なし。
//
// Jest と Vitest は既製の選択機能（--changedSince / --changed）へ任せる。
// node --test には既製が無いので、変更ファイルから import を逆引きしてテストファイルを選ぶ。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const id = 'javascript'
export const runners = ['jest', 'vitest', 'node --test']

const LABEL = { jest: 'jest', vitest: 'vitest', node: 'node --test' }

// select は 5 秒以内に返す契約。逆引きがこの時間を超えたら passthrough にする。
const SELECT_BUDGET_MS = 3500
// 選んだファイルを並べた argv がこの長さを超えたら、元の argv のまま全部流す（Windows のコマンド行上限）。
const MAX_ARGV_CHARS = 7000
const MAX_WALK_ENTRIES = 50_000
const MAX_SOURCE_BYTES = 2_000_000
const MAX_FAILURES = 50

// ---------------------------------------------------------------------------
// 小さな道具

function stat(path) {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

const isFile = path => stat(path)?.isFile() === true
const isDirectory = path => stat(path)?.isDirectory() === true
const toPosix = path => (sep === '\\' ? path.replaceAll('\\', '/') : path)

function findUp(start, name) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, name)
    if (stat(candidate)) return candidate
    if (dirname(dir) === dir) return undefined
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function isInside(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// コマンド名。パスと Windows の拡張子を落とす（./node_modules/.bin/jest.cmd → jest）。
function commandName(word = '') {
  return word.replaceAll('\\', '/').split('/').pop().replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase()
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

// package.json の script をシェル語へ分ける。引用符とバックスラッシュだけ扱う。
function splitWords(text) {
  const words = []
  let current = ''
  let quote = ''
  let started = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) current += text[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      started = true
    } else if (ch === '\\' && i + 1 < text.length) {
      current += text[++i]
      started = true
    } else if (/\s/.test(ch)) {
      if (started || current) words.push(current)
      current = ''
      started = false
    } else {
      current += ch
    }
  }
  if (started || current) words.push(current)
  return words
}

// ---------------------------------------------------------------------------
// オプションの読み取り
//
// 値を取るオプションを知らないと、値をテストの名指しと取り違える。取り違えた時は
// passthrough（何もしない）へ倒れるので、表に無いオプションがあっても壊しはしない。

// Jest も Vitest も --testNamePattern と --test-name-pattern を同じ物として受ける。
const normalizeLoose = name => name.replace(/^-+/, '').replaceAll('-', '').toLowerCase()

function looseSet(names) {
  return new Set(names.map(name => name.replaceAll('-', '').toLowerCase()))
}

function scanArgs(args, { valued, greedy = new Set(), shorts = {}, normalize, dottedTakeValue = false }) {
  const flags = new Map()
  const positionals = []
  let dashDash = -1
  for (let i = 0; i < args.length; i++) {
    const word = args[i]
    if (word === '--') {
      dashDash = i
      positionals.push(...args.slice(i + 1))
      break
    }
    if (!word.startsWith('-') || word === '-') {
      positionals.push(word)
      continue
    }
    const eq = word.indexOf('=')
    let name = eq === -1 ? word : word.slice(0, eq)
    let value = eq === -1 ? true : word.slice(eq + 1)
    if (name.startsWith('--no-') && value === true) {
      flags.set(normalize(`--${name.slice(5)}`), false)
      continue
    }
    if (name.startsWith('--')) name = normalize(name)
    else {
      // 短いオプション。-t と -w は Jest と Vitest で値を取る。
      const short = name.slice(1, 2)
      const rest = name.slice(2)
      name = shorts[short] ?? short
      if (rest && value === true) value = valued.has(name) ? rest : true
    }
    if (value === true) {
      const next = args[i + 1]
      const hasNext = next !== undefined && next !== '--' && !(next.startsWith('-') && next !== '-')
      if (greedy.has(name)) {
        const values = []
        while (args[i + 1] !== undefined && args[i + 1] !== '--' && !args[i + 1].startsWith('-')) values.push(args[++i])
        value = values.length ? values.join(' ') : true
      } else if (hasNext && (valued.has(name) || (dottedTakeValue && name.includes('.') && !name.endsWith('.enabled')))) {
        value = args[++i]
      }
    }
    flags.set(name, value)
  }
  return { flags, positionals, dashDash }
}

const enabled = (flags, name) => flags.has(name) && flags.get(name) !== false && flags.get(name) !== 'false'
const firstEnabled = (flags, names) => names.find(name => enabled(flags, name))

const JEST = {
  normalize: normalizeLoose,
  shorts: { c: 'config', t: 'testnamepattern', w: 'maxworkers', o: 'onlychanged', f: 'onlyfailures', b: 'bail', i: 'runinband', u: 'updatesnapshot', e: 'expand', h: 'help', v: 'version' },
  valued: looseSet([
    'config', 'rootDir', 'testEnvironment', 'env', 'maxWorkers', 'maxConcurrency', 'testTimeout', 'coverageProvider',
    'coverageDirectory', 'coverageThreshold', 'outputFile', 'seed', 'shard', 'testNamePattern', 'changedSince', 'filter',
    'transform', 'moduleNameMapper', 'cacheDirectory', 'resolver', 'runner', 'testRunner', 'testSequencer', 'globals',
    'globalSetup', 'globalTeardown', 'preset', 'workerIdleMemoryLimit', 'openHandlesTimeout', 'testFailureExitCode',
    'notifyMode', 'displayName', 'testEnvironmentOptions', 'haste', 'prettierPath', 'dependencyExtractor',
    'testResultsProcessor', 'snapshotResolver',
  ]),
  // yargs の配列オプション。後ろに続く語を全部値として取る。
  greedy: looseSet([
    'selectProjects', 'ignoreProjects', 'reporters', 'collectCoverageFrom', 'coverageReporters', 'roots', 'projects',
    'setupFiles', 'setupFilesAfterEnv', 'testMatch', 'testRegex', 'testPathPattern', 'testPathPatterns',
    'testPathIgnorePatterns', 'moduleDirectories', 'moduleFileExtensions', 'modulePaths', 'modulePathIgnorePatterns',
    'transformIgnorePatterns', 'coveragePathIgnorePatterns', 'snapshotSerializers', 'watchPathIgnorePatterns',
    'unmockedModulePathPatterns', 'findRelatedTests', 'runTestsByPath',
  ]),
  dry: looseSet(['version', 'help', 'listTests', 'showConfig', 'clearCache', 'init']),
  watch: looseSet(['watch', 'watchAll']),
  coverage: looseSet(['coverage', 'collectCoverage']),
  narrowing: looseSet([
    'testNamePattern', 'testPathPattern', 'testPathPatterns', 'runTestsByPath', 'findRelatedTests', 'onlyChanged',
    'changedSince', 'lastCommit', 'onlyFailures', 'selectProjects', 'ignoreProjects', 'shard', 'filter', 'testMatch',
    'testRegex', 'changedFilesWithAncestor',
  ]),
}

const VITEST = {
  normalize: normalizeLoose,
  dottedTakeValue: true,
  shorts: { r: 'root', c: 'config', t: 'testnamepattern', w: 'watch', u: 'update', h: 'help', v: 'version' },
  valued: new Set([
    'root', 'config', 'dir', 'testnamepattern', 'reporter', 'outputfile', 'environment', 'pool', 'project', 'mode',
    'workspace', 'shard', 'bail', 'retry', 'testtimeout', 'hooktimeout', 'teardowntimeout', 'maxworkers', 'minworkers',
    'maxconcurrency', 'exclude', 'diff', 'slowtestthreshold', 'execargv', 'vmmemorylimit', 'attachmentsdir',
    'tagsfilter', 'configloader', 'silent',
  ]),
  subcommands: new Set(['run', 'watch', 'dev', 'related', 'bench', 'list', 'init']),
  drySubcommands: new Set(['bench', 'list', 'init']),
  dry: new Set(['version', 'help']),
  watch: new Set(['watch', 'ui']),
  coverage: new Set(['coverage', 'coverage.enabled']),
  narrowing: new Set(['testnamepattern', 'dir', 'project', 'shard', 'changed', 'exclude', 'tagsfilter']),
}

// node のオプションのうち、値を別の語で取る物。
const NODE_VALUED = new Set([
  'require', 'import', 'loader', 'experimental-loader', 'conditions', 'env-file', 'env-file-if-exists', 'eval', 'print',
  'run', 'input-type', 'experimental-default-type', 'experimental-config-file', 'test-reporter',
  'test-reporter-destination', 'test-name-pattern', 'test-skip-pattern', 'test-concurrency', 'test-timeout',
  'test-shard', 'test-isolation', 'test-global-setup', 'test-rerun-failures', 'test-coverage-include',
  'test-coverage-exclude', 'test-coverage-branches', 'test-coverage-functions', 'test-coverage-lines', 'watch-path',
  'watch-kill-signal', 'inspect-port', 'title', 'stack-trace-limit', 'max-old-space-size', 'max-http-header-size',
  'disable-warning', 'redirect-warnings', 'diagnostic-dir', 'report-dir', 'report-directory', 'report-filename',
  'snapshot-blob', 'localstorage-file', 'dns-result-order', 'unhandled-rejections', 'trace-event-categories',
  'trace-event-file-pattern', 'icu-data-dir', 'openssl-config', 'secure-heap', 'secure-heap-min', 'heapsnapshot-signal',
  'cpu-prof-dir', 'cpu-prof-name', 'cpu-prof-interval', 'heap-prof-dir', 'heap-prof-name', 'heap-prof-interval',
  'allow-fs-read', 'allow-fs-write', 'use-largepages', 'tls-cipher-list', 'tls-keylog', 'network-family-autoselection-attempt-timeout',
])
const NODE_SHORTS = { r: 'require', C: 'conditions', e: 'eval', p: 'print', c: 'check', i: 'interactive', h: 'help', v: 'version' }
const NODE_DRY = ['help', 'version', 'eval', 'print', 'check', 'interactive', 'v8-options', 'completion-bash']
const NODE_NARROWING = ['test-name-pattern', 'test-skip-pattern', 'test-only', 'test-shard', 'test-rerun-failures']
const NODE_WATCH = ['watch', 'watch-path']
// テストより先に読み込まれるファイル。変更が及んだら全部に効く。
// import と require はパッケージ名も取るので、相対パスと絶対パスの時だけ追う。
const NODE_PRELOAD_MODULES = ['import', 'require', 'loader', 'experimental-loader']
const NODE_PRELOAD_PATHS = ['test-global-setup', 'env-file', 'env-file-if-exists', 'experimental-config-file']

// node のオプションは最初の位置引数で終わる。値を取るオプションは同じ物を何度も書けるので、全部覚える。
function scanNodeOptions(argv, start) {
  const options = []
  let i = start
  for (; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--') {
      i++
      break
    }
    if (!word.startsWith('-') || word === '-') break
    const eq = word.indexOf('=')
    let name = eq === -1 ? word : word.slice(0, eq)
    let value = eq === -1 ? true : word.slice(eq + 1)
    if (name.startsWith('--')) name = name.slice(2)
    else name = NODE_SHORTS[name.slice(1)] ?? name.slice(1)
    if (value === true && NODE_VALUED.has(name) && i + 1 < argv.length) value = argv[++i]
    options.push([name, value])
  }
  return { options, end: i }
}

const nodeHas = (options, names) => names.find(name => options.some(([key, value]) => key === name && value !== 'false'))

// ---------------------------------------------------------------------------
// コマンドの読み取り
//
// 返り値: { runner, lead, args, ... }。lead はランナーの引数より前の語（そのまま返す）、
// args はランナーへ渡る引数。パッケージスクリプト経由の時は script が付く。

const JEST_SCRIPT = /(^|\/)(jest\/bin\/jest\.js|jest-cli\/bin\/jest\.js|\.bin\/jest)$/
const VITEST_SCRIPT = /(^|\/)(vitest\/vitest\.mjs|vitest\/dist\/cli\.js|\.bin\/vitest)$/
const BIN_RUNNERS = new Set(['jest', 'vitest'])

// jest@29 のような版の指定を落とす。
const binRunner = word => {
  const name = commandName(word).replace(/@[^/]*$/, '')
  return BIN_RUNNERS.has(name) ? name : undefined
}

// npx などの「オプション → コマンド」の形から、コマンドの位置を探す。
function skipLauncherOptions(argv, start, valued) {
  let i = start
  for (; i < argv.length; i++) {
    const word = argv[i]
    if (word === '--') return i + 1
    if (!word.startsWith('-')) return i
    if (word === '-c' || word === '--call') return -1
    if (valued.has(word) && !word.includes('=')) i++
  }
  return i
}

const NPX_VALUED = new Set(['-p', '--package'])
// 作業場所を変えるオプション。どの package.json か決められないので扱わない。
const ELSEWHERE = /^(-C|-w|-r|--prefix|--dir|--cwd|--filter|--workspace|--workspaces|--recursive|--workspace-root)(=|$)/

function direct(runner, argv, argsStart) {
  return { runner, lead: argv.slice(0, argsStart), args: argv.slice(argsStart) }
}

function parseCommand(argv, cwd, depth = 0) {
  if (!Array.isArray(argv) || depth > 3) return undefined
  let i = 0
  while (i < argv.length && ENV_ASSIGNMENT.test(argv[i])) i++
  if (['env', 'cross-env'].includes(commandName(argv[i]))) {
    i++
    while (i < argv.length && ENV_ASSIGNMENT.test(argv[i])) i++
  }
  const hasEnvPrefix = i > 0
  const parsed = parseLauncher(argv, i, cwd, depth)
  if (parsed) parsed.hasEnvPrefix = hasEnvPrefix
  return parsed
}

function parseLauncher(argv, i, cwd, depth) {
  const name = commandName(argv[i])
  const next = argv[i + 1]

  if (BIN_RUNNERS.has(name)) return direct(name, argv, i + 1)

  if (name === 'rtk') {
    if (BIN_RUNNERS.has(next)) return direct(next, argv, i + 2)
    if (['test', 'proxy', 'err'].includes(next)) return parseLauncher(argv, i + 2, cwd, depth)
    if (['npx', 'npm', 'pnpm'].includes(next)) return parseLauncher(argv, i + 1, cwd, depth)
    return undefined
  }

  if (['npx', 'pnpx', 'bunx'].includes(name)) {
    const at = skipLauncherOptions(argv, i + 1, NPX_VALUED)
    const runner = at === -1 ? undefined : binRunner(argv[at])
    return runner && direct(runner, argv, at + 1)
  }

  if (['node', 'nodejs'].includes(name)) return parseNode(argv, i, cwd, depth)

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return parsePackageManager(name, argv, i, cwd, depth)

  return undefined
}

function parseNode(argv, i, cwd, depth) {
  const { options, end } = scanNodeOptions(argv, i + 1)
  if (nodeHas(options, NODE_DRY)) return undefined
  const run = options.find(([key]) => key === 'run')
  if (run) {
    // node --run <script>。npm run と違って pre/post は走らない。
    const dashDash = argv.indexOf('--', i + 1)
    const extra = dashDash === -1 ? [] : argv.slice(dashDash + 1)
    return typeof run[1] === 'string' ? parseScript('node --run', run[1], extra, argv, cwd, depth) : undefined
  }
  if (options.some(([key, value]) => key === 'test' && value !== 'false')) {
    return { runner: 'node', lead: argv.slice(0, end), args: argv.slice(end), options }
  }
  const script = argv[end]?.replaceAll('\\', '/')
  if (script && JEST_SCRIPT.test(script)) return direct('jest', argv, end + 1)
  if (script && VITEST_SCRIPT.test(script)) return direct('vitest', argv, end + 1)
  return undefined
}

function parsePackageManager(pm, argv, i, cwd, depth) {
  // 先頭のオプションを読み飛ばす（npm --silent test など）。
  let at = i + 1
  while (at < argv.length && argv[at].startsWith('-')) {
    if (ELSEWHERE.test(argv[at])) return undefined
    at++
  }
  const sub = argv[at]
  if (sub === undefined) return undefined
  // bun test は bun 自身のテストランナーで、package.json の script ではない。
  if (pm === 'bun' && sub === 'test') return undefined
  // npm は -- より前が npm 自身のオプション。他は script 名の後ろが全部ランナーへ渡る。
  if (pm === 'npm') {
    const own = argv.slice(at + 1)
    if (own.slice(0, own.includes('--') ? own.indexOf('--') : own.length).some(word => ELSEWHERE.test(word))) return undefined
  }

  const exec = { npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'] }[pm]
  if (exec.includes(sub)) {
    const start = skipLauncherOptions(argv, at + 1, NPX_VALUED)
    const runner = start === -1 ? undefined : binRunner(argv[start])
    return runner && direct(runner, argv, start + 1)
  }

  const testAliases = { npm: ['test', 't', 'tst'], pnpm: ['test', 't'], yarn: ['test'], bun: [] }[pm]
  const runAliases = { npm: ['run', 'run-script', 'rum', 'urn'], pnpm: ['run', 'run-script'], yarn: ['run'], bun: ['run'] }[pm]
  let scriptName
  let extraStart
  if (testAliases.includes(sub)) {
    scriptName = 'test'
    extraStart = at + 1
  } else if (runAliases.includes(sub)) {
    let nameAt = at + 1
    while (nameAt < argv.length && argv[nameAt].startsWith('-') && argv[nameAt] !== '--') nameAt++
    scriptName = argv[nameAt]
    extraStart = nameAt + 1
  } else if (pm !== 'npm') {
    // pnpm jest / yarn vitest / bun <script>: script があればそれ、無ければ node_modules/.bin の物。
    scriptName = sub
    extraStart = at + 1
  }
  if (!scriptName || scriptName === '--') return undefined

  // ランナーへ渡る引数。npm は -- の後ろだけ、他は script 名の後ろ全部。
  const tail = argv.slice(extraStart)
  const dashDash = tail.indexOf('--')
  const extra = pm === 'npm' ? (dashDash === -1 ? [] : tail.slice(dashDash + 1)) : tail.filter((word, index) => index !== dashDash)

  const viaScript = parseScript(pm, scriptName, extra, argv, cwd, depth)
  if (viaScript) return viaScript
  // yarn jest / yarn run jest のように、script が無ければ node_modules/.bin のランナーを直接呼ぶ形。
  if (pm !== 'npm' && BIN_RUNNERS.has(scriptName)) return direct(scriptName, argv, extraStart)
  return undefined
}

function parseScript(pm, name, extra, argv, cwd, depth) {
  const pkgFile = findUp(cwd, 'package.json')
  const scripts = pkgFile && readJson(pkgFile)?.scripts
  const body = scripts?.[name]
  if (typeof body !== 'string') return undefined
  const pkgDir = dirname(pkgFile)
  const script = {
    pm,
    name,
    body,
    pkgDir,
    extra,
    hooks: pm !== 'node --run' && ['pre', 'post'].some(prefix => typeof scripts[prefix + name] === 'string'),
  }
  const complex = /[;&|<>`]|\$\(/.test(body)
  const inner = complex ? undefined : parseCommand(splitWords(body), pkgDir, depth + 1)
  if (inner) {
    // script の先頭に環境変数の代入がある時（NODE_ENV=test jest）も覚えておく。
    return { ...inner, script: inner.script ?? script, outer: argv, inner: { lead: inner.lead, args: inner.args, hasEnvPrefix: inner.hasEnvPrefix }, args: [...inner.args, ...extra], nested: Boolean(inner.script) }
  }
  // 単純には読めない script。ランナーの名前が見える時だけ「テストだが判断しない」とする。
  const runner = /(^|[\s/"'])jest(\s|$)/.test(body) ? 'jest' : /(^|[\s/"'])vitest(\s|$)/.test(body) ? 'vitest' : /(^|[\s/"'])node(js)?\s[^;&|]*--test(\s|$)/.test(body) ? 'node' : undefined
  if (!runner) return undefined
  return { runner, lead: argv, args: [], script, outer: argv, undecidable: `script「${name}」が複合コマンド` }
}

// ランナーの引数を読んで、種類ごとの判断材料へまとめる。
function inspect(command) {
  if (command.undecidable) return { dry: false }
  if (command.runner === 'node') {
    const options = command.options ?? []
    return {
      dry: false,
      watch: nodeHas(options, NODE_WATCH),
      narrowing: nodeHas(options, NODE_NARROWING),
      coverage: nodeHas(options, ['experimental-test-coverage']),
      positionals: command.args.filter(word => word !== '--'),
    }
  }
  const spec = command.runner === 'jest' ? JEST : VITEST
  const { flags, positionals, dashDash } = scanArgs(command.args, spec)
  const names = [...flags.keys()]
  let sub
  if (command.runner === 'vitest' && spec.subcommands.has(positionals[0])) sub = positionals.shift()
  // rtk vitest は run を自分で足す。
  const dry = firstEnabled(flags, [...spec.dry]) !== undefined || (sub !== undefined && spec.drySubcommands.has(sub))
  return {
    dry,
    sub,
    dashDash,
    watch: names.find(name => spec.watch.has(name) && enabled(flags, name)) ?? (['watch', 'dev'].includes(sub) ? sub : undefined),
    narrowing: names.find(name => spec.narrowing.has(name) && enabled(flags, name)) ?? (sub === 'related' ? 'related' : undefined),
    coverage: names.find(name => spec.coverage.has(name) && enabled(flags, name)),
    positionals,
  }
}

// ---------------------------------------------------------------------------
// 1. 判定

export function detect(argv, { cwd = process.cwd() } = {}) {
  try {
    const command = parseCommand(argv, cwd)
    return Boolean(command) && !inspect(command).dry
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 2. 選択

// どのテストにも効くファイル。変更されたら全部流す。
const GLOBAL_FILES = {
  common: [
    /^package\.json$/, /^package-lock\.json$/, /^npm-shrinkwrap\.json$/, /^yarn\.lock$/, /^pnpm-lock\.yaml$/,
    /^pnpm-workspace\.yaml$/, /^bun\.lockb?$/, /^\.npmrc$/, /^\.yarnrc(\.yml)?$/, /^\.pnpmfile\.cjs$/,
    /^[tj]sconfig(\..+)?\.json$/, /^\.nvmrc$/, /^\.node-version$/,
  ],
  jest: [/^jest\.config\.[cm]?[jt]s(on)?$/, /^jest\.(setup|preset)\./, /^\.babelrc(\..+)?$/, /^babel\.config\.[cm]?[jt]s(on)?$/, /^\.swcrc$/],
  vitest: [/^(vitest|vite)\.config\.[cm]?[jt]s$/, /^vitest\.(workspace|setup)\./],
  node: [/^node\.config\.json$/],
}

// Jest と Vitest の依存追跡に乗らない文書。これだけの変更なら流す物が無い。
const DOCUMENT = /(\.(md|markdown|mdx|txt|rst|adoc)|(^|\/)(LICENSE|LICENCE|CHANGELOG|AUTHORS|NOTICE)(\.[^/]*)?)$/i

function normalizeChanged(changed) {
  const seen = new Set()
  for (const entry of changed ?? []) {
    if (typeof entry !== 'string') continue
    const path = entry.replaceAll('\\', '/').replace(/^\.\//, '')
    if (path) seen.add(path)
  }
  return [...seen]
}

function globalFile(changed, runner) {
  const patterns = [...GLOBAL_FILES.common, ...GLOBAL_FILES[runner]]
  return changed.find(path => {
    if (/(^|\/)node_modules(\/|$)/.test(path)) return true
    const base = path.replace(/\/$/, '').split('/').pop()
    return patterns.some(pattern => pattern.test(base))
  })
}

function findRepoRoot(cwd) {
  const marker = findUp(cwd, '.git')
  return marker ? dirname(marker) : resolve(cwd)
}

export async function select({ argv, cwd = process.cwd(), env, changed, base = null, full = false } = {}) {
  const pass = (reason, mode = 'passthrough') => ({ argv, mode, reason })
  let command
  let info
  try {
    command = parseCommand(argv, cwd)
    info = command && inspect(command)
  } catch (error) {
    return pass(`javascript: コマンドを読めなかった（${error.message}）`)
  }
  if (!command || info.dry) return pass('javascript: Jest・Vitest・node --test の実行ではない')
  const label = LABEL[command.runner]
  const say = text => `${label}: ${text}`

  if (full) return pass(say('全部流す指定（TESTGATE_FULL）なので元のまま'), 'full')
  const files = normalizeChanged(changed)
  if (files.length === 0) return pass(say('変更が無いので流す物が無い'), 'none')

  if (command.undecidable) return pass(say(`${command.undecidable}なので触らない`))
  if (command.script?.hooks) return pass(say(`script「${command.script.name}」に pre/post があるので触らない`))
  if (command.nested) return pass(say('script が別の script を呼んでいるので触らない'))
  if (info.watch) return pass(say(`監視モード（${info.watch}）なので触らない`))
  if (info.narrowing) return pass(say(`範囲を絞る指定（${info.narrowing}）が既にあるので触らない`))

  try {
    if (command.runner === 'node') return selectNode({ command, info, argv, cwd, files, say, pass })
    return selectNative({ command, info, argv, cwd, files, base, say, pass })
  } catch (error) {
    return pass(say(`選択の途中で失敗したので元のまま（${error.message}）`))
  }
}

// Jest と Vitest。選ぶのはランナー自身で、ここでは既製のオプションを足すだけ。
function selectNative({ command, info, argv, cwd, files, base, say, pass }) {
  const { runner } = command
  if (info.positionals.length > 0) return pass(say(`テストの指定（${info.positionals[0]}）が既にあるので触らない`))

  const globalHit = globalFile(files, runner)
  if (globalHit) return pass(say(`全体に効くファイル（${globalHit}）が変わったので全部流す`), 'full')
  if (info.coverage) return pass(say('coverage の計測は全体が前提なので全部流す'), 'full')
  if (files.every(path => DOCUMENT.test(path))) return pass(say('変更は文書だけで、関わるテストが無い'), 'none')
  if (!findUp(cwd, '.git')) return pass(say('git リポジトリの外では変更からテストを選べない'))

  // どちらも、関わるテストが無ければ何も流さず終了コード 0 で終わる（Jest 30、Vitest 1.6・3.2・5.0 で確認）。
  const added = runner === 'jest'
    ? [base ? `--changedSince=${base}` : '--onlyChanged']
    : [base ? `--changed=${base}` : '--changed']

  let next
  if (command.script) {
    // npm は -- の後ろだけがランナーへ渡る。pnpm・yarn・bun・node --run はそのまま渡る。
    const outer = command.outer
    const needsDashDash = ['npm', 'node --run'].includes(command.script.pm) && !outer.includes('--')
    next = [...outer, ...(needsDashDash ? ['--'] : []), ...added]
  } else if (info.dashDash >= 0) {
    const at = command.lead.length + info.dashDash
    next = [...argv.slice(0, at), ...added, ...argv.slice(at)]
  } else {
    next = [...argv, ...added]
  }
  const since = base ? `${base} からの変更` : '未commitの変更'
  return { argv: next, mode: 'subset', reason: say(`${added[0]} を足した（${since}に関わるテストだけ）`) }
}

// ---- node --test: テストファイルの候補

const GLOB_MAGIC = /[*?[\]{}]/
const DEFAULT_TEST_FILE = /(^|\/)(([^/]+[.\-_]test)|(test-[^/]+)|test)\.[cm]?[jt]s$|(^|\/)test\/(.+\/)?[^/]+\.[cm]?[jt]s$/

// {a,b} を先に展開する。
function expandBraces(pattern) {
  const match = /\{([^{}]*)\}/.exec(pattern)
  if (!match || !match[1].includes(',')) return [pattern]
  return match[1].split(',').flatMap(part => expandBraces(pattern.slice(0, match.index) + part + pattern.slice(match.index + match[0].length)))
}

function segmentRegExp(segment) {
  let source = ''
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 2)
      if (close === -1) source += '\\['
      else {
        const body = segment.slice(i + 1, close).replace(/^!/, '^').replaceAll('\\', '\\\\')
        source += `[${body}]`
        i = close
      }
    } else source += ch.replace(/[.+^$()|\\{}\]]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, 'u')
}

class Budget {
  constructor(ms) {
    this.deadline = Date.now() + ms
    this.entries = 0
  }

  check() {
    if (this.entries++ > MAX_WALK_ENTRIES || Date.now() > this.deadline) throw new BudgetExceeded()
  }
}
class BudgetExceeded extends Error {}

function listDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

// シェルと node の glob に合わせて、名前がドットで始まる物と node_modules は * に合わせない。
function expandGlob(cwd, pattern, budget) {
  const found = []
  for (const expanded of expandBraces(pattern.replaceAll('\\', '/'))) {
    const absolute = expanded.startsWith('/') || /^[A-Za-z]:\//.test(expanded)
    const segments = expanded.split('/').filter((segment, index) => segment !== '' || index === 0)
    const start = absolute ? (segments.shift() || '') + '/' : cwd
    walkGlob(start, segments, found, budget)
  }
  return found
}

function walkGlob(dir, segments, found, budget) {
  budget.check()
  if (segments.length === 0) {
    if (isFile(dir)) found.push(dir)
    return
  }
  const [segment, ...rest] = segments
  if (segment === '' || segment === '.') return walkGlob(dir, rest, found, budget)
  if (segment === '..' || !GLOB_MAGIC.test(segment)) return walkGlob(join(dir, segment), rest, found, budget)
  if (segment === '**') {
    walkGlob(dir, rest, found, budget)
    for (const entry of listDir(dir)) {
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walkGlob(join(dir, entry.name), segments, found, budget)
    }
    return
  }
  const pattern = segmentRegExp(segment)
  for (const entry of listDir(dir)) {
    if (entry.name === 'node_modules' || (entry.name.startsWith('.') && !segment.startsWith('.'))) continue
    if (!pattern.test(entry.name)) continue
    if (rest.length === 0) {
      if (entry.isFile() || (entry.isSymbolicLink() && isFile(join(dir, entry.name)))) found.push(join(dir, entry.name))
    } else if (entry.isDirectory() || entry.isSymbolicLink()) walkGlob(join(dir, entry.name), rest, found, budget)
  }
}

// 引数なしとディレクトリ指定。node の既定の名前規則（*.test.js、test/ 配下など）で探す。
// TypeScript は、動かしている Node が型の除去に対応している時だけ候補にする。
function discoverTests(dir, budget) {
  const typescript = Boolean(process.features?.typescript)
  const found = []
  const walk = current => {
    for (const entry of listDir(current)) {
      budget.check()
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(path)
      } else if (entry.isFile()) {
        const rel = toPosix(relative(dir, path))
        if (DEFAULT_TEST_FILE.test(rel) && (typescript || !/ts$/.test(rel))) found.push(path)
      }
    }
  }
  walk(dir)
  return found
}

// ---- node --test: 依存の読み取り

const CODE_EXTENSIONS = ['.mjs', '.cjs', '.js', '.jsx', '.ts', '.mts', '.cts', '.tsx']
// 拡張子を省いた import の探し方。CommonJS と TypeScript の両方の癖を一つにまとめてある。
const RESOLVE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json', '.node', '.ts', '.mts', '.cts', '.tsx', '.jsx']
const TS_TWINS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'], '.jsx': ['.tsx'] }
const LOADABLE = /\.([cm]?[jt]sx?|json|node|wasm)$/

// コメントと文字列は取り除かずに正規表現で拾う。取り除き損ねて import を見落とすより、
// コメントの中の import を拾って余分に選ぶ方が安全だから。
const STATIC_FROM = /\bfrom\s*(['"])([^'"\n]+)\1/g
const SIDE_EFFECT = /\bimport\s*(['"])([^'"\n]+)\1/g
const CALL = /(?<![.\w$])(?:import\.meta\.resolve|require\.resolve|import|require)\s*\(\s*(['"`])([^'"`\n]+)\1\s*[,)]/g
// 文字列でない引数の import() / require()。何を読むか分からない。
const OPAQUE_CALL = /(?<![.\w$])(import|require)\s*\(\s*([^'"`\s)][^)]*|`[^`]*\$\{[^)]*)\)(?!\s*\{)/
const URL_REF = /new\s+URL\(\s*(['"`])([^'"`\n]+)\1\s*,\s*import\.meta\.url/g
const DIRNAME_REF = /(?:__dirname|import\.meta\.dirname)\s*,\s*((?:(['"`])[^'"`\n]*\2\s*,?\s*)+)\)/g
// パスの形をした文字列（区切りを一つ以上含む）。join(root, 'src/app.mjs') のような参照を拾う。
const PATH_LITERAL = /(['"`])((?:\.{1,2}\/)?[\w@.+-]+(?:\/[\w@.+-]+)+)\1/g

function scanSource(source) {
  const modules = new Set()
  const paths = new Set()
  const literals = new Set()
  for (const pattern of [STATIC_FROM, SIDE_EFFECT, CALL]) {
    for (const match of source.matchAll(pattern)) {
      if (match[2].includes('${')) continue
      modules.add(match[2])
    }
  }
  for (const match of source.matchAll(URL_REF)) if (!match[2].includes('${')) paths.add(match[2])
  for (const match of source.matchAll(DIRNAME_REF)) {
    const parts = [...match[1].matchAll(/(['"`])([^'"`\n]*)\1/g)].map(part => part[2])
    if (parts.length && !parts.some(part => part.includes('${'))) paths.add(`./${parts.join('/')}`)
  }
  for (const match of source.matchAll(PATH_LITERAL)) literals.add(match[2])
  return { modules, paths, literals, opaque: OPAQUE_CALL.test(source) }
}

class Graph {
  constructor(root, budget) {
    this.root = root
    this.budget = budget
    this.nodes = new Map() // 絶対パス → { files, dirs, missing, soft, opaque }
    this.importers = new Map() // 絶対パス → それを参照するファイルの集合
    this.packages = new Map()
  }

  add(entries) {
    const queue = [...entries]
    while (queue.length) {
      const file = queue.pop()
      if (this.nodes.has(file)) continue
      this.budget.check()
      const node = this.read(file)
      this.nodes.set(file, node)
      for (const target of node.files) {
        if (!this.importers.has(target)) this.importers.set(target, new Set())
        this.importers.get(target).add(file)
        queue.push(target)
      }
    }
  }

  inRepo(path) {
    return isInside(this.root, path) && !/(^|[\\/])node_modules([\\/]|$)/.test(relative(this.root, path))
  }

  read(file) {
    const node = { files: new Set(), dirs: new Set(), missing: new Set(), soft: new Set(), opaque: false }
    if (!CODE_EXTENSIONS.includes(extname(file))) return node
    const size = stat(file)?.size
    if (size === undefined || size > MAX_SOURCE_BYTES) return node
    let source
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      return node
    }
    const { modules, paths, literals, opaque } = scanSource(source)
    node.opaque = opaque
    const here = dirname(file)

    for (const specifier of modules) {
      let target
      if (/^\.{1,2}(\/|$)/.test(specifier) || isAbsolute(specifier)) target = resolve(here, specifier.replace(/[?#].*$/, ''))
      else if (specifier.startsWith('#')) {
        target = this.subpathImport(file, specifier)
        // package.json の imports で解けない内部 import は、何を読むか分からない物として扱う。
        if (!target) node.opaque = true
      }
      // パッケージ名の import は追わない。パッケージの変更はロックファイルで分かる。
      if (!target || !this.inRepo(target)) continue
      const found = resolveModule(target)
      if (found) node.files.add(found)
      else node.missing.add(target)
    }

    for (const reference of paths) {
      const target = resolve(here, reference)
      if (!this.inRepo(target)) continue
      const info = stat(target)
      if (info?.isFile()) node.files.add(target)
      // 自分を含むディレクトリ（new URL('..', import.meta.url)）は、そこから先の組み立てが読めないので辺にしない。
      else if (info?.isDirectory()) {
        if (!isInside(target, file)) node.dirs.add(target)
      } else node.missing.add(target)
    }

    for (const literal of literals) {
      const bases = /^\.{1,2}\//.test(literal) ? [here] : [here, this.root, this.packageRoot(file)]
      for (const base of bases) {
        const target = resolve(base, literal)
        if (!this.inRepo(target) || target === file) continue
        if (isFile(target)) node.files.add(target)
        else if (!stat(target)) node.soft.add(target)
      }
    }
    return node
  }

  packageRoot(file) {
    const dir = dirname(file)
    if (!this.packages.has(dir)) {
      const found = findUp(dir, 'package.json')
      this.packages.set(dir, found && isInside(this.root, found) ? dirname(found) : this.root)
    }
    return this.packages.get(dir)
  }

  // package.json の "imports"（#internal/x）。文字列か条件の入れ子で、* を一つまで。
  subpathImport(file, specifier) {
    const pkgDir = this.packageRoot(file)
    const imports = readJson(join(pkgDir, 'package.json'))?.imports
    if (!imports || typeof imports !== 'object') return undefined
    const pick = value => {
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.map(pick).find(Boolean)
      if (value && typeof value === 'object') {
        for (const key of ['node', 'import', 'require', 'default']) {
          const picked = pick(value[key])
          if (picked) return picked
        }
      }
      return undefined
    }
    for (const [key, value] of Object.entries(imports)) {
      const target = pick(value)
      if (!target?.startsWith('.')) continue
      if (key === specifier) return resolve(pkgDir, target)
      const star = key.indexOf('*')
      if (star === -1) continue
      const [head, tail] = [key.slice(0, star), key.slice(star + 1)]
      if (specifier.startsWith(head) && specifier.endsWith(tail) && specifier.length >= head.length + tail.length) {
        return resolve(pkgDir, target.replace('*', specifier.slice(head.length, specifier.length - tail.length)))
      }
    }
    return undefined
  }

  // start の集合を参照している物を、参照の向きと逆にたどって全部集める。
  dependents(starts) {
    const reached = new Set(starts)
    const queue = [...starts]
    while (queue.length) {
      for (const importer of this.importers.get(queue.pop()) ?? []) {
        if (!reached.has(importer)) {
          reached.add(importer)
          queue.push(importer)
        }
      }
    }
    return reached
  }

  // 変更された一つのパスに直接当たるファイル。
  touched(path, isDirEntry) {
    const hits = []
    const exists = Boolean(stat(path))
    if (!isDirEntry && this.nodes.has(path)) hits.push(path)
    const stem = path.slice(0, path.length - extname(path).length)
    for (const [file, node] of this.nodes) {
      if (isDirEntry && isInside(path, file)) hits.push(file)
      for (const dir of node.dirs) {
        if (isInside(dir, path) || (isDirEntry && isInside(path, dir))) hits.push(file)
      }
      // 消えたファイル。消える前の経路を参照していた物を選ぶ（拡張子の省略と index も見る）。
      if (!exists || isDirEntry) {
        for (const missing of node.missing) {
          if (missing === path || missing === stem || isInside(missing, path) || (isDirEntry && isInside(path, missing))) hits.push(file)
        }
        if (node.soft.has(path)) hits.push(file)
      }
    }
    return hits
  }
}

function resolveModule(target) {
  const info = stat(target)
  if (info?.isFile()) return target
  for (const extension of RESOLVE_EXTENSIONS) {
    if (isFile(target + extension)) return target + extension
  }
  // TypeScript は ./x.js と書いて x.ts を指す。
  const extension = extname(target)
  for (const twin of TS_TWINS[extension] ?? []) {
    const candidate = target.slice(0, -extension.length) + twin
    if (isFile(candidate)) return candidate
  }
  if (info?.isDirectory()) {
    const main = readJson(join(target, 'package.json'))?.main
    if (typeof main === 'string') {
      const found = resolveModule(resolve(target, main))
      if (found) return found
    }
    for (const extension of RESOLVE_EXTENSIONS) {
      const candidate = join(target, `index${extension}`)
      if (isFile(candidate)) return candidate
    }
  }
  return undefined
}

function selectNode({ command, info, argv, cwd, files, say, pass }) {
  const { script } = command
  if (script) {
    // node --test はファイルの一覧を差し替えるので、script を呼ぶ形のままでは選べない。
    // 直接の呼び出しへ書き換えても同じ動きになる時だけ選ぶ。
    if (script.extra.length > 0) return pass(say(`script「${script.name}」へ追加の引数があるので触らない`))
    if (command.inner.hasEnvPrefix) return pass(say(`script「${script.name}」が環境変数を設定しているので触らない`))
    if (resolve(cwd) !== resolve(script.pkgDir)) return pass(say('package.json と違う場所から呼ばれたので触らない'))
  }
  const lead = script ? command.inner.lead : command.lead
  const execCwd = script ? script.pkgDir : cwd

  const patterns = info.positionals
  const kinds = patterns.map(pattern => (GLOB_MAGIC.test(pattern) ? 'glob' : isDirectory(resolve(execCwd, pattern)) ? 'dir' : 'file'))
  const named = patterns[kinds.indexOf('file')]
  if (named !== undefined) return pass(say(`ファイルの名指し（${named}）なので触らない`))

  const globalHit = globalFile(files, 'node')
  if (globalHit) return pass(say(`全体に効くファイル（${globalHit}）が変わったので全部流す`), 'full')
  if (info.coverage) return pass(say('coverage の計測は全体が前提なので全部流す'), 'full')

  const budget = new Budget(SELECT_BUDGET_MS)
  try {
    const found = patterns.length === 0
      ? discoverTests(execCwd, budget)
      : patterns.flatMap((pattern, index) => (kinds[index] === 'glob' ? expandGlob(execCwd, pattern, budget) : discoverTests(resolve(execCwd, pattern), budget)))
    const candidates = [...new Set(found)].sort()
    if (candidates.length === 0) return pass(say('指定に合うテストファイルが見つからないので触らない'))

    const root = findRepoRoot(execCwd)
    const graph = new Graph(root, budget)
    graph.add(candidates)

    const preloads = (command.options ?? [])
      .filter(([name, value]) => typeof value === 'string' && (NODE_PRELOAD_PATHS.includes(name) || (NODE_PRELOAD_MODULES.includes(name) && /^(\.{1,2}[\\/]|[\\/]|[A-Za-z]:[\\/])/.test(value))))
      .map(([, value]) => resolve(execCwd, value))
      .filter(path => isInside(root, path))
    graph.add(preloads.filter(isFile))

    const starts = new Set()
    const orphans = []
    for (const path of files) {
      const isDirEntry = path.endsWith('/') || isDirectory(resolve(root, path))
      const absolute = resolve(root, path)
      const hits = graph.touched(absolute, isDirEntry)
      for (const hit of hits) starts.add(hit)
      if (hits.length === 0 && (isDirEntry || LOADABLE.test(path))) orphans.push(path)
    }
    const affected = graph.dependents(starts)
    const preloadHit = preloads.find(path => affected.has(path) || files.some(file => resolve(root, file) === path))
    if (preloadHit) return pass(say(`先に読み込まれるファイル（${toPosix(relative(execCwd, preloadHit))}）に変更が及ぶので全部流す`), 'full')

    const selected = new Set(candidates.filter(file => affected.has(file)))
    // どのテストからも静的にたどれない変更ファイルは、文字列でない import() で読まれているかもしれない。
    // その時は、中身の分からない import を持つテストを足す（取りこぼしより流し過ぎ）。
    let note = ''
    if (orphans.length > 0) {
      const opaque = [...graph.nodes].filter(([, node]) => node.opaque).map(([file]) => file)
      const unknown = graph.dependents(opaque)
      const before = selected.size
      for (const file of candidates) if (unknown.has(file)) selected.add(file)
      if (selected.size > before) note = `。${orphans[0]} は静的にたどれないので、動的 import を持つテストも足した`
    }

    if (selected.size === 0) return pass(say('変更に関わるテストが無い'), 'none')
    if (selected.size === candidates.length) return pass(say(`変更が全部のテストファイルに関わる${note}`), 'full')

    const chosen = [...selected].map(file => toPosix(relative(execCwd, file)))
    if (chosen.some(file => GLOB_MAGIC.test(file))) return pass(say('選んだファイル名に glob の記号があり、並べて渡せないので全部流す'), 'full')
    const next = [...lead, ...chosen]
    if (next.join(' ').length > MAX_ARGV_CHARS) return pass(say('選んだファイルが多くコマンド行に収まらないので全部流す'), 'full')
    const via = script ? `。script「${script.name}」を直接の呼び出しへ書き換えた` : ''
    return { argv: next, mode: 'subset', reason: say(`import の逆引きで、候補 ${candidates.length} ファイルのうち ${chosen.length} を選んだ${note}${via}`) }
  } catch (error) {
    if (error instanceof BudgetExceeded) return pass(say('依存の解決が時間内に終わらないので触らない'))
    throw error
  }
}

// ---------------------------------------------------------------------------
// 3. 結果の読み取り

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const plain = text => String(text ?? '').replace(ANSI, '').replaceAll('\r', '')

function toMs(value, unit) {
  const number = Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.round(number * ({ ms: 1, s: 1000, m: 60_000 }[unit] ?? 1))
}

function lastMatch(text, pattern) {
  let last
  for (const match of text.matchAll(pattern)) last = match
  return last
}

const count = (line, word) => {
  const match = new RegExp(`(\\d+) ${word}\\b`).exec(line ?? '')
  return match ? Number(match[1]) : undefined
}

function finish({ passed, failed, skipped, errors, durationMs, failures }) {
  const result = {}
  if (passed !== undefined) result.passed = passed
  if (failed !== undefined) result.failed = failed
  if (skipped !== undefined) result.skipped = skipped
  if (errors) result.errors = errors
  if (durationMs !== undefined) result.durationMs = durationMs
  const unique = [...new Set(failures ?? [])].slice(0, MAX_FAILURES)
  if (unique.length) result.failures = unique
  return result
}

function parseJest(text) {
  const tests = lastMatch(text, /^Tests:\s+(.*\d+ total)\s*$/gm)?.[1]
  if (tests === undefined) return undefined
  const lines = text.split('\n')
  const failures = []
  const broken = new Set()
  let suite
  for (const line of lines) {
    const fail = /^\s*FAIL\s+(\S.*?)(?:\s+\([\d.]+ m?s\))?\s*$/.exec(line)
    if (fail) suite = fail[1]
    const bullet = /^\s{2}● (.+?)\s*$/.exec(line)
    if (!bullet) continue
    if (bullet[1] === 'Test suite failed to run') {
      broken.add(suite ?? '?')
      failures.push(`${suite ?? '?'}: Test suite failed to run`)
    } else if (!/^(Console|Validation Warning|Deprecation Warning|Cannot log after tests are done)/.test(bullet[1])) failures.push(bullet[1])
  }
  const time = lastMatch(text, /^Time:\s+([\d.]+)\s*(ms|s|m)\b/gm)
  const errors = broken.size
  return finish({
    passed: count(tests, 'passed') ?? 0,
    // 読み込めなかったテストファイルは Tests: の failed に入っていないので足す。
    failed: (count(tests, 'failed') ?? 0) + errors,
    skipped: (count(tests, 'skipped') ?? 0) + (count(tests, 'todo') ?? 0),
    errors,
    durationMs: time && toMs(time[1], time[2]),
    failures,
  })
}

function parseVitest(text) {
  const tests = lastMatch(text, /^\s*Tests\s+(.*\(\d+\))\s*$/gm)?.[1]
  const filesLine = lastMatch(text, /^\s*Test Files\s+(.*\(\d+\))\s*$/gm)?.[1]
  if (tests === undefined && filesLine === undefined) return undefined
  const failedSuites = Number(/^⎯+ Failed Suites (\d+) ⎯+$/m.exec(text)?.[1] ?? 0)
  const unhandled = Number(lastMatch(text, /^\s*Errors\s+(\d+) errors?\s*$/gm)?.[1] ?? 0)
  const errors = failedSuites + unhandled
  const failures = [...text.matchAll(/^\s*FAIL\s+(\S.*?)\s*$/gm)].map(match => match[1])
  const time = lastMatch(text, /^\s*Duration\s+([\d.]+)\s*(ms|s|m)\b/gm)
  return finish({
    passed: count(tests, 'passed') ?? 0,
    failed: (count(tests, 'failed') ?? 0) + errors,
    skipped: (count(tests, 'skipped') ?? 0) + (count(tests, 'todo') ?? 0),
    errors,
    durationMs: time && toMs(time[1], time[2]),
    failures,
  })
}

// node --test。spec（ℹ）と TAP（#）のどちらでも、最後の集計の行を読む。
function parseNodeTest(text) {
  const read = key => {
    const match = lastMatch(text, new RegExp(`^\\s*[ℹ#] ${key} ([\\d.]+)\\s*$`, 'gm'))
    return match ? Number(match[1]) : undefined
  }
  const summary = { pass: read('pass'), fail: read('fail'), cancelled: read('cancelled'), skipped: read('skipped'), todo: read('todo'), duration: read('duration_ms') }
  const lines = text.split('\n')
  const failures = []
  let errors = 0

  // spec: 「✖ failing tests:」の後ろに、場所の行と名前の行が並ぶ。
  const heading = lines.findIndex(line => /^\s*✖ failing tests:\s*$/.test(line))
  if (heading !== -1) {
    let location
    for (const line of lines.slice(heading + 1)) {
      const at = /^\s*test at (.+?)\s*$/.exec(line)
      if (at) {
        location = at[1]
        continue
      }
      const name = /^\s*✖ (.+?)(?: \([\d.]+ms\))?\s*$/.exec(line)
      if (!name) continue
      // ファイル自体が失敗した物（読み込みの失敗など）は、名前がファイルで場所が 1 行目になる。
      if (location && location === `${name[1]}:1:1`) errors++
      failures.push(location ? `${name[1]} (${location})` : name[1])
      location = undefined
    }
  } else {
    // TAP: not ok の行。SKIP と TODO は失敗ではない。
    for (let i = 0; i < lines.length; i++) {
      const notOk = /^\s*not ok \d+ - (.+?)\s*$/.exec(lines[i])
      if (!notOk || /# (SKIP|TODO)\b/i.test(notOk[1])) continue
      let location
      for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]) && j < i + 12; j++) {
        location = /^\s*location: '(.+)'\s*$/.exec(lines[j])?.[1] ?? location
      }
      if (location?.endsWith(`${notOk[1]}:1:1`)) errors++
      failures.push(notOk[1])
    }
    // 集計が無い出力（dot など）では、✖ の行だけが手掛かり。
    if (failures.length === 0) {
      for (const line of lines) {
        const name = /^✖ (.+?)(?: \([\d.]+ms\))?\s*$/.exec(line)
        if (name) failures.push(name[1])
      }
    }
  }
  const any = Object.values(summary).some(value => value !== undefined)
  if (!any && failures.length === 0) return undefined
  const skipped = summary.skipped === undefined && summary.todo === undefined ? undefined : (summary.skipped ?? 0) + (summary.todo ?? 0)
  // 打ち切られたテストは通っていないので、落ちた物に数える。
  const failed = summary.fail === undefined ? undefined : summary.fail + (summary.cancelled ?? 0)
  return finish({
    passed: summary.pass,
    failed,
    skipped,
    errors,
    durationMs: summary.duration === undefined ? undefined : Math.round(summary.duration),
    failures,
  })
}

// rtk jest / rtk vitest の一行の集計「PASS (6) FAIL (0) skipped (1)」。
function parseRtk(text) {
  const match = lastMatch(text, /^PASS \((\d+)\) FAIL \((\d+)\)(?: skipped \((\d+)\))?\s*$/gm)
  if (!match) return undefined
  return finish({
    passed: Number(match[1]),
    failed: Number(match[2]),
    skipped: match[3] === undefined ? undefined : Number(match[3]),
    failures: [...text.matchAll(/^\d+\. (\S.*?)\s*$/gm)].map(found => found[1]),
  })
}

export function parseOutput(text) {
  const clean = plain(text)
  return parseJest(clean) ?? parseVitest(clean) ?? parseRtk(clean) ?? parseNodeTest(clean) ?? {}
}

// ---------------------------------------------------------------------------
// 4. 件数行の除去

const COUNT_LINES = [
  /^Tests:\s+.*\d+ total\s*$/, // Jest
  /^Test Suites:\s+.*\d+ total\s*$/,
  /^Snapshots:\s+.*\d+ total\s*$/,
  /^\s*(Test Files|Tests)\s+.*\(\d+\)\s*$/, // Vitest
  /^\s*[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo) \d+\s*$/, // node --test（spec と TAP）
  /^\s*1\.\.\d+\s*$/, // TAP の計画行
  /^PASS \(\d+\) FAIL \(\d+\)(?: skipped \(\d+\))?\s*$/, // rtk
]
// Vitest のファイルごとの行「✓ test/a.test.js (2 tests | 1 skipped) 3ms」。失敗の数だけ残す。
const VITEST_FILE_COUNTS = /\((\d+) tests?((?: \| \d+ \w+)*)\)/

export function stripCounts(text) {
  const kept = []
  for (const line of String(text ?? '').split('\n')) {
    const clean = plain(line)
    if (COUNT_LINES.some(pattern => pattern.test(clean))) continue
    if (VITEST_FILE_COUNTS.test(clean) && /^\s*[✓❯×↓✗√]/u.test(clean)) {
      const failed = /\| (\d+ failed)/.exec(clean)?.[1]
      // 色の制御文字が括弧の中に挟まるので、色を落とした行を書き直す。
      kept.push(clean.replace(VITEST_FILE_COUNTS, failed ? `(${failed})` : '').replace(/ {2,}(\d+ ?m?s)$/, ' $1').trimEnd())
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}
