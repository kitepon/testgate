// testgate prune: ミューテーションテストで「消してよい試験の候補」を出す。消すのは担当。
// 流れ: 道具を揃える → プロジェクトを読む → 変異を標本抽出 → Stryker の設定を書く → 流す → 候補を出す → 記録。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, mkdtempSync, cpSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, basename, dirname, resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensurePruneTools } from './tools.mjs'
import { inspectJsProject } from './project.mjs'
import { analyzeReport, formatCandidates, mergeReports } from './candidates.mjs'
import { appendLog } from '../log.mjs'
import { withRunTmp } from './tmp-root.mjs'

export function pruneStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  return join(base, 'testgate', 'prune')
}

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') }

/** Stryker の設定を組む（純粋。試験から確かめる）。 */
export function buildStrykerConfig(proj, { tools, mutate, reportFile, failuresFile, dryRunFailuresFile, timeoutMs, testTimeoutMs, concurrencyFiles }) {
  const cfg = {
    mutate,
    coverageAnalysis: 'off',
    concurrency: 1, // sandbox 直下の .active-mutant を使うので走者は1つ。並列は試験ファイル単位で取る
    timeoutMS: timeoutMs,
    disableBail: true,
    reporters: ['progress', 'json'],
    jsonReporter: { fileName: reportFile },
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
    ignorePatterns: ['.stryker-tmp', 'reports', '**/.active-mutant', '.testgate-prune'],
    logLevel: 'info',
  }
  const injectArgs = proj.inject.dir ? ['--dir', proj.inject.dir] : [...proj.inject.globs.flatMap(g => ['--glob', g]), ...proj.inject.exclude.flatMap(g => ['--exclude', g])]
  const buildArgs = proj.build ? ['--script', proj.build.script] : []
  cfg.buildCommand = ['node', join(tools.plugins, 'build-and-inject.mjs'), ...buildArgs, ...injectArgs].map(q).join(' ')
  if (proj.runner === 'node --test') {
    cfg.testRunner = 'node-test'
    cfg.plugins = [join(tools.plugins, 'node-test-runner.mjs')]
    cfg.nodeTest = { nodeArgs: proj.nodeArgs, files: proj.files, exclude: proj.exclude, ...(failuresFile ? { failuresFile } : {}), ...(dryRunFailuresFile ? { dryRunFailuresFile } : {}), testArgs: [...proj.testArgs, `--test-timeout=${testTimeoutMs}`, ...(concurrencyFiles ? [`--test-concurrency=${concurrencyFiles}`] : [])] }
  } else if (proj.runner === 'jest') {
    cfg.testRunner = 'jest'; cfg.plugins = [join(tools.dir, 'node_modules', '@stryker-mutator', 'jest-runner', 'dist', 'src', 'index.js')]
  } else if (proj.runner === 'vitest') {
    cfg.testRunner = 'vitest'; cfg.plugins = [join(tools.dir, 'node_modules', '@stryker-mutator', 'vitest-runner', 'dist', 'src', 'index.js')]
  }
  return cfg
}
function q(s) { return /[\s"']/.test(s) ? JSON.stringify(s) : s }

/** 下見の写しの置き方（純粋。試験から確かめる）。cwd から上へ辿って node_modules の有る階層を集め、いちばん上の階層を写しの根 root に対応させる。
 *  写しは cwd と同じ深さ（copyRoot）に置き、各階層の node_modules を同じ相対位置へ link する。npm workspaces の package（node_modules は根に
 *  hoist）でも、Stryker の sandbox（cwd の下にできるので親へ辿れる）と同じく依存が解決できる。node_modules がどこにも無ければ写しは root 直下。 */
export function preflightLayout(cwd, root) {
  cwd = resolve(cwd)
  const withModules = []
  for (let d = cwd; ; d = dirname(d)) { if (existsSync(join(d, 'node_modules'))) withModules.push(d); if (dirname(d) === d) break }
  const top = withModules.length ? withModules[withModules.length - 1] : cwd
  return { copyRoot: join(root, relative(top, cwd)), links: withModules.map(d => [join(d, 'node_modules'), join(root, relative(top, d), 'node_modules')]) }
}

/** 下見: Stryker の sandbox と同じ形（.git と .stryker-tmp 無し、node_modules は link。親方向の node_modules も同じ相対位置に link）の写しで試験を一度流し、落ちる試験ファイルを返す。
 *  Stryker は初回に1本でも落ちると止まるので、.git や外の状態を読む試験（product-ci-plan.test など）を機械的に外すために使う。
 *  走者は Stryker 用の plugin をそのまま使う（居残る子を止める扱いも同じ）。 */
export async function preflight(cwd, proj, { tools, env = process.env, log = () => {}, testTimeoutMs = 60000, concurrencyFiles } = {}) {
  if (proj.runner !== 'node --test') return { skipped: 'node --test 以外', failed: [] }
  cwd = resolve(cwd)
  const root = mkdtempSync(join(tmpdir(), 'tg-preflight-'))
  const prevCwd = process.cwd()
  try {
    const { copyRoot: dir, links } = preflightLayout(cwd, root)
    mkdirSync(dir, { recursive: true })
    cpSync(cwd, dir, { recursive: true, dereference: false, filter: p => { const rel = relative(cwd, p).split(sep).join('/'); return !/^(\.git|node_modules|\.stryker-tmp|\.testgate-prune)(\/|$)/.test(rel) } })
    for (const [from, to] of links) { mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to, 'junction') }
    if (proj.build) {
      const b = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', proj.build.script], { cwd: dir, env, encoding: 'utf8', shell: process.platform === 'win32' })
      if (b.status !== 0) return { error: `下見の build に失敗: ${(b.stderr || b.stdout || '').trim().slice(-1500)}`, failed: [] }
    }
    const { NodeTestRunner, TestStatus, DryRunStatus } = await import(pathToFileURL(join(tools.plugins, 'node-test-runner.mjs')).href)
    const quiet = { debug() {}, info() {}, warn: (...a) => log('testgate prune: 下見: ' + a.join(' ')), error: (...a) => log('testgate prune: 下見: ' + a.join(' ')) }
    const runner = new NodeTestRunner({ concurrency: 1, nodeTest: { nodeArgs: proj.nodeArgs, files: proj.files, exclude: proj.exclude, testArgs: [...proj.testArgs, `--test-timeout=${testTimeoutMs}`, ...(concurrencyFiles ? [`--test-concurrency=${concurrencyFiles}`] : [])] } }, quiet)
    process.chdir(dir)
    let r
    try { r = await runner.dryRun({}) } finally { process.chdir(prevCwd); await runner.dispose() }
    if (r.status !== DryRunStatus.Complete) return { error: `下見の試験が流れない: ${r.errorMessage || r.status}`, failed: [] }
    const failed = [...new Set(r.tests.filter(t => t.status === TestStatus.Failed && t.fileName).map(t => t.fileName))].sort()
    return { failed, tests: r.tests.length, failedTests: r.tests.filter(t => t.status === TestStatus.Failed).map(t => ({ name: t.name, error: firstErrorLine(t.failureMessage) })) }
  } finally { try { process.chdir(prevCwd) } catch {} rmSync(root, { recursive: true, force: true }) }
}

/** 失敗の本文の1行要約。断言の stack なら先頭行、読み込みで落ちたファイルの stderr（先頭は node:internal の位置）なら例外の行を拾う。 */
export function firstErrorLine(message) {
  const lines = String(message || '').split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => /^(\w*Error|\w+Exception)\b|^Error \[|^\[?\w*Error\]?:/.test(l)) || lines[0] || ''
}

/** 刈り込み1回ぶんを専用の一時物の根（tg-run-*）で包む。試験が SIGKILL で止められても根ごと消える（tmp-root.mjs）。 */
export function runPrune(opts = {}) { return withRunTmp(() => runPruneInner(opts)) }

async function runPruneInner({ cwd = process.cwd(), sample = 200, seed, out, mutate, tests, exclude = [], timeoutMs = 60000, testTimeoutMs = 60000, concurrencyFiles, keepSandbox = false, noPreflight = false, runner, env = process.env, log = m => process.stderr.write(m + '\n'), stdout = s => process.stdout.write(s) } = {}) {
  cwd = resolve(cwd)
  const runnerName = runner === 'node-test' ? 'node --test' : runner
  let proj = inspectJsProject(cwd, { mutate, tests, exclude, runner: runnerName })
  if (proj.error) { log(`testgate prune: ${proj.error}`); return 2 }
  const tools = ensurePruneTools({ env, log })
  // 下見: sandbox で落ちる試験ファイルを除外に足す（Stryker は初回に1本でも落ちると止まる）
  let pre = null
  if (!noPreflight) {
    pre = await preflight(cwd, proj, { tools, env, log, testTimeoutMs, concurrencyFiles })
    if (pre.error) log(`testgate prune: ${pre.error}`)
    else if (pre.failed.length) {
      log(`testgate prune: 下見で落ちた試験ファイルを除外する（.git や外の状態を読む試験。候補にも出ない）: ${pre.failed.join(' ')}`)
      for (const f of pre.failedTests) log(`  ${f.name}: ${f.error.slice(0, 160)}`)
      proj = inspectJsProject(cwd, { mutate, tests, exclude: [...exclude, ...pre.failed], runner: runnerName })
      if (proj.error) { log(`testgate prune: ${proj.error}`); return 2 }
    }
  }
  const name = (proj.name || basename(cwd)).replace(/[^A-Za-z0-9._-]+/g, '_')
  const runDir = join(pruneStateDir(env), name, stamp())
  mkdirSync(runDir, { recursive: true })
  seed ||= basename(runDir)
  // 変異の標本抽出（sample <= 0 は全変異）
  let mutateList = proj.sources, sampled = null // 全変異の時は実在のファイルを並べる（否定 glob の「何も除外しない」警告を出さない）
  if (sample > 0) {
    const args = [join(tools.plugins, 'sample-mutants.mjs'), '--cwd', cwd, '--sample', String(sample), '--seed', seed, ...proj.mutate.filter(g => !g.startsWith('!')).flatMap(g => ['--glob', g]), ...proj.mutate.filter(g => g.startsWith('!')).flatMap(g => ['--exclude', g.slice(1)])]
    const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) { log(`testgate prune: 変異の列挙に失敗: ${(r.stderr || '').trim().slice(-2000)}`); return 1 }
    sampled = JSON.parse(r.stdout)
    mutateList = sampled.mutate
    log(`testgate prune: ${proj.sources.length} ファイル ${sampled.total} 変異のうち ${sampled.sampled} 件を流す（seed ${seed}）`)
  }
  const reportFile = join(runDir, 'mutation.json'), failuresFile = join(runDir, 'failures.jsonl'), dryRunFailuresFile = join(runDir, 'dry-run-failures.json')
  const cfgFile = join(runDir, 'stryker.config.json'), logFile = join(runDir, 'stryker.log')
  const writeCfg = () => { const cfg = buildStrykerConfig(proj, { tools, mutate: mutateList, reportFile, failuresFile, dryRunFailuresFile, timeoutMs, testTimeoutMs, concurrencyFiles }); if (keepSandbox) cfg.cleanTempDir = false; writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n') }
  const writeProject = () => writeFileSync(join(runDir, 'project.json'), JSON.stringify({ cwd, proj, preflight: pre, dryRunExcluded, sampled: sampled && { total: sampled.total, sampled: sampled.sampled, positions: sampled.positions, seed } }, null, 2) + '\n')
  let dryRunExcluded = []
  writeCfg(); writeProject()
  log(`testgate prune: ${proj.runner} / 試験 ${proj.files.join(' ')}${proj.build ? ` / build: npm run ${proj.build.script}` : ''} / 記録 ${runDir}`)
  const started = Date.now()
  const sandboxes = () => { try { return readdirSync(join(cwd, '.stryker-tmp')).filter(d => d.startsWith('sandbox-')) } catch { return [] } }
  const before = new Set(sandboxes())
  let status = await runStryker({ tools, cfgFile, cwd, env, logFile, log })
  // 初回試験（dry run）で落ちた時は、落ちた試験ファイルを除外して一度だけ流し直す。下見は計装の無い写しで流すので、
  // 「製品ソースを文字列として読んで断言する」試験は計装（Stryker の instrument と注入ヘッダ）で初めて落ち、ここでしか拾えない
  if (!existsSync(reportFile)) {
    const dryFailed = readDryRunFailures(dryRunFailuresFile), files = dryRunFailedFiles(dryFailed)
    if (files.length) {
      log(`testgate prune: 初回試験で落ちた試験ファイルを除外して流し直す（計装でだけ落ちる。ソースを文字列で読む等。候補にも出ない）: ${files.join(' ')}`)
      for (const f of dryFailed.filter(f => f.fileName)) log(`  ${f.name}: ${firstErrorLine(f.error).slice(0, 160)}`)
      const retry = inspectJsProject(cwd, { mutate, tests, exclude: [...exclude, ...(pre?.failed || []), ...files], runner: runnerName })
      if (retry.error) { log(`testgate prune: ${retry.error}`); return 2 }
      proj = retry; dryRunExcluded = files
      rmSync(dryRunFailuresFile, { force: true })
      if (!keepSandbox) for (const d of sandboxes()) if (!before.has(d)) rmSync(join(cwd, '.stryker-tmp', d), { recursive: true, force: true }) // Stryker は失敗した回の sandbox を残すが、流し直すので要らない
      writeCfg(); writeProject()
      writeFileSync(logFile, `--- testgate prune: 初回試験で落ちた試験ファイルを除外して流し直す: ${files.join(' ')} ---\n`, { flag: 'a' })
      status = await runStryker({ tools, cfgFile, cwd, env, logFile, log })
    }
  }
  const durationMs = Date.now() - started
  if (!existsSync(reportFile)) { log(`testgate prune: Stryker が失敗（exit ${status}）。記録 ${logFile}`); await appendLog({ phase: 2, event: 'prune', cwd, name, runner: proj.runner, status, durationMs, sampled: sampled?.sampled ?? null }, env); return status || 1 }
  const a = analyzeReport(JSON.parse(readFileSync(reportFile, 'utf8')), { failures: readFailures(failuresFile), cwd })
  const text = formatCandidates(a, { notes: dryRunExcluded.length ? [`初回試験で落ちた試験ファイル ${dryRunExcluded.length} 本を除外して流し直した（計装でだけ落ちる物。ソースを文字列で読む等。候補にも出ない）: ${dryRunExcluded.join(' ')}`] : [] })
  const result = { name, cwd, commit: gitHead(cwd), platform: `${process.platform} node ${process.version}`, runner: proj.runner, seed, sampled: sampled && { total: sampled.total, sampled: sampled.sampled, positions: sampled.positions }, excluded: proj.exclude, preflightExcluded: pre?.failed || [], dryRunExcluded, durationMs, ...a }
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify(result, null, 2) + '\n')
  writeFileSync(join(runDir, 'candidates.txt'), text)
  if (out) { mkdirSync(resolve(out, '..'), { recursive: true }); writeFileSync(out, out.endsWith('.json') ? JSON.stringify(result, null, 2) + '\n' : text) }
  stdout(text)
  // 同じ名前の過去の記録と合算（seed を変えた月次の積み上げ）。2回目から candidates-merged.* を書く
  const merged = mergeRuns(join(pruneStateDir(env), name), { log, cwd })
  if (merged) {
    writeFileSync(join(runDir, 'candidates-merged.json'), JSON.stringify({ name, cwd, runner: proj.runner, ...merged.analysis, runs: merged.runs }, null, 2) + '\n')
    writeFileSync(join(runDir, 'candidates-merged.txt'), merged.text)
    stdout(`\n--- ${merged.runs.length} 回分の合算（${merged.runs.map(d => basename(d)).join(', ')}）---\n${merged.text}`)
  }
  stdout(`記録: ${runDir}（candidates.json / candidates.txt / mutation.json / stryker.log${merged ? ' / candidates-merged.json / candidates-merged.txt' : ''}）\n`)
  await appendLog({ phase: 2, event: 'prune', cwd, name, runner: proj.runner, status, durationMs, sampled: sampled?.sampled ?? null, tested: a.tested, killed: a.stat.killed, timeout: a.stat.timeout, tests: a.tests, kept: a.kept, candidates: a.candidates.length, survived: a.survived.length, runDir }, env)
  return 0
}

/** Stryker を一度流す。stdout/stderr は stryker.log に追記し、要点だけ log へ。戻りは exit code。 */
function runStryker({ tools, cfgFile, cwd, env, logFile, log }) {
  return new Promise(res => {
    const child = spawn(process.execPath, [tools.stryker, 'run', cfgFile], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buf = ''
    const onData = c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); writeFileSync(logFile, line + '\n', { flag: 'a' }); if (/Mutation testing|Initial test run|ERROR|WARN|Done in/.test(line)) log(line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d\d:\d\d:\d\d \(\d+\) /, '')) } }
    child.stdout.setEncoding('utf8').on('data', onData); child.stderr.setEncoding('utf8').on('data', onData)
    child.on('error', e => { log(`testgate prune: Stryker を起動できない: ${e.message}`); res(1) })
    child.on('exit', code => res(code ?? 1))
  })
}

/** 走者が書いた初回試験の失敗（dry-run-failures.json）。無い・読めない時は []。 */
export function readDryRunFailures(file) {
  if (!existsSync(file)) return []
  try { const v = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter(f => f && typeof f === 'object') : [] } catch { return [] }
}
/** 初回試験の失敗から、除外に足す試験ファイル（相対、重複無し、順）。(process) のようにファイルの無い失敗は数えない（除外では直らない）。 */
export function dryRunFailedFiles(failures) {
  return [...new Set(failures.map(f => f.fileName).filter(f => typeof f === 'string' && f))].sort()
}

export function readFailures(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
function gitHead(cwd) { const r = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null }

/** 名前のフォルダ（state/prune/<名前>）にある全回の mutation.json を合算して候補を出す。2回分以上ある時だけ返す。失敗の断言も全回分を読む。cwd は変異位置の元コードを読む所。 */
export function mergeRuns(nameDir, { log = () => {}, cwd = null } = {}) {
  if (!existsSync(nameDir)) return null
  const runs = readdirSync(nameDir).sort().map(d => join(nameDir, d)).filter(d => existsSync(join(d, 'mutation.json')))
  if (runs.length < 2) return null
  const reports = [], failures = []
  for (const d of runs) {
    const i = basename(d) // 回ごとの変異IDは 0 から振り直されるので、回の名前を前に付けて区別する
    try {
      const r = JSON.parse(readFileSync(join(d, 'mutation.json'), 'utf8'))
      for (const v of Object.values(r.files || {})) for (const m of v.mutants) m.id = `${i}:${m.id}`
      reports.push(r)
      failures.push(...readFailures(join(d, 'failures.jsonl')).map(f => ({ ...f, mutant: `${i}:${f.mutant}` })))
    } catch (e) { log(`testgate prune: ${d} の mutation.json を読めない: ${e.message}`) }
  }
  if (reports.length < 2) return null
  const analysis = analyzeReport(mergeReports(reports), { failures, cwd })
  return { runs, analysis, text: formatCandidates(analysis) }
}

export function parsePruneArgs(args) {
  const o = { cwd: process.cwd(), sample: 200, exclude: [], tests: [], mutate: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i], v = args[i + 1]
    if (a === '--cwd') o.cwd = v, i++
    else if (a === '--sample') o.sample = Number(v), i++
    else if (a === '--seed') o.seed = v, i++
    else if (a === '--out') o.out = v, i++
    else if (a === '--exclude') o.exclude.push(v), i++
    else if (a === '--tests') o.tests.push(v), i++
    else if (a === '--mutate') o.mutate.push(v), i++
    else if (a === '--timeout-sec') o.timeoutMs = Number(v) * 1000, i++
    else if (a === '--test-timeout-sec') o.testTimeoutMs = Number(v) * 1000, i++
    else if (a === '--jobs') o.concurrencyFiles = Number(v), i++
    else if (a === '--keep-sandbox') o.keepSandbox = true
    else if (a === '--no-preflight') o.noPreflight = true
    else if (a === '--runner') { if (!['node-test', 'jest', 'vitest'].includes(v)) return { error: `--runner は node-test|jest|vitest: ${v}` }; o.runner = v; i++ }
    else return { error: `unknown option ${a}` }
  }
  return o
}
export const PRUNE_USAGE = 'usage: testgate prune [--cwd DIR] [--sample N(=200, 0=全部)] [--seed S] [--out FILE(.json|.txt)] [--tests GLOB]... [--exclude GLOB]... [--mutate GLOB]... [--jobs N] [--timeout-sec N] [--test-timeout-sec N] [--keep-sandbox] [--no-preflight] [--runner node-test|jest|vitest]'
