// testgate prune: ミューテーションテストで「消してよい試験の候補」を出す。消すのは担当。
// 流れ: 道具を揃える → プロジェクトを読む → 変異を標本抽出 → Stryker の設定を書く → 流す → 候補を出す → 記録。
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename, resolve } from 'node:path'
import { ensurePruneTools } from './tools.mjs'
import { inspectJsProject } from './project.mjs'
import { analyzeReport, formatCandidates } from './candidates.mjs'
import { appendLog } from '../log.mjs'

export function pruneStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  return join(base, 'testgate', 'prune')
}

function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') }

/** Stryker の設定を組む（純粋。試験から確かめる）。 */
export function buildStrykerConfig(proj, { tools, mutate, reportFile, timeoutMs, testTimeoutMs, concurrencyFiles }) {
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
    cfg.nodeTest = { nodeArgs: proj.nodeArgs, files: proj.files, exclude: proj.exclude, testArgs: [...proj.testArgs, `--test-timeout=${testTimeoutMs}`, ...(concurrencyFiles ? [`--test-concurrency=${concurrencyFiles}`] : [])] }
  } else if (proj.runner === 'jest') {
    cfg.testRunner = 'jest'; cfg.plugins = [join(tools.dir, 'node_modules', '@stryker-mutator', 'jest-runner', 'dist', 'src', 'index.js')]
  } else if (proj.runner === 'vitest') {
    cfg.testRunner = 'vitest'; cfg.plugins = [join(tools.dir, 'node_modules', '@stryker-mutator', 'vitest-runner', 'dist', 'src', 'index.js')]
  }
  return cfg
}
function q(s) { return /[\s"']/.test(s) ? JSON.stringify(s) : s }

export async function runPrune({ cwd = process.cwd(), sample = 200, seed, out, mutate, tests, exclude = [], timeoutMs = 60000, testTimeoutMs = 60000, concurrencyFiles, keepSandbox = false, env = process.env, log = m => process.stderr.write(m + '\n'), stdout = s => process.stdout.write(s) } = {}) {
  cwd = resolve(cwd)
  const proj = inspectJsProject(cwd, { mutate, tests, exclude })
  if (proj.error) { log(`testgate prune: ${proj.error}`); return 2 }
  const tools = ensurePruneTools({ env, log })
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
  const reportFile = join(runDir, 'mutation.json')
  const cfg = buildStrykerConfig(proj, { tools, mutate: mutateList, reportFile, timeoutMs, testTimeoutMs, concurrencyFiles })
  if (keepSandbox) cfg.cleanTempDir = false
  const cfgFile = join(runDir, 'stryker.config.json')
  writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n')
  writeFileSync(join(runDir, 'project.json'), JSON.stringify({ cwd, proj, sampled: sampled && { total: sampled.total, sampled: sampled.sampled, positions: sampled.positions, seed } }, null, 2) + '\n')
  log(`testgate prune: ${proj.runner} / 試験 ${proj.files.join(' ')}${proj.build ? ` / build: npm run ${proj.build.script}` : ''} / 記録 ${runDir}`)
  const started = Date.now()
  const status = await new Promise(res => {
    const child = spawn(process.execPath, [tools.stryker, 'run', cfgFile], { cwd, env: { ...env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] })
    const logFile = join(runDir, 'stryker.log'); let buf = ''
    const onData = c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); writeFileSync(logFile, line + '\n', { flag: 'a' }); if (/Mutation testing|Initial test run|ERROR|WARN|Done in/.test(line)) log(line.replace(/\x1b\[[0-9;]*m/g, '').replace(/^\d\d:\d\d:\d\d \(\d+\) /, '')) } }
    child.stdout.setEncoding('utf8').on('data', onData); child.stderr.setEncoding('utf8').on('data', onData)
    child.on('error', e => { log(`testgate prune: Stryker を起動できない: ${e.message}`); res(1) })
    child.on('exit', code => res(code ?? 1))
  })
  const durationMs = Date.now() - started
  if (!existsSync(reportFile)) { log(`testgate prune: Stryker が失敗（exit ${status}）。記録 ${join(runDir, 'stryker.log')}`); await appendLog({ phase: 2, event: 'prune', cwd, name, runner: proj.runner, status, durationMs, sampled: sampled?.sampled ?? null }, env); return status || 1 }
  const a = analyzeReport(JSON.parse(readFileSync(reportFile, 'utf8')))
  const text = formatCandidates(a)
  const result = { name, cwd, runner: proj.runner, seed, sampled: sampled && { total: sampled.total, sampled: sampled.sampled }, durationMs, ...a }
  writeFileSync(join(runDir, 'candidates.json'), JSON.stringify(result, null, 2) + '\n')
  writeFileSync(join(runDir, 'candidates.txt'), text)
  if (out) { mkdirSync(resolve(out, '..'), { recursive: true }); writeFileSync(out, out.endsWith('.json') ? JSON.stringify(result, null, 2) + '\n' : text) }
  stdout(text)
  stdout(`記録: ${runDir}（candidates.json / candidates.txt / mutation.json / stryker.log）\n`)
  await appendLog({ phase: 2, event: 'prune', cwd, name, runner: proj.runner, status, durationMs, sampled: sampled?.sampled ?? null, tested: a.tested, tests: a.tests, kept: a.kept, candidates: a.candidates.length, survived: a.survived.length, runDir }, env)
  return 0
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
    else return { error: `unknown option ${a}` }
  }
  return o
}
export const PRUNE_USAGE = 'usage: testgate prune [--cwd DIR] [--sample N(=200, 0=全部)] [--seed S] [--out FILE(.json|.txt)] [--tests GLOB]... [--exclude GLOB]... [--mutate GLOB]... [--jobs N] [--timeout-sec N] [--test-timeout-sec N] [--keep-sandbox]'
