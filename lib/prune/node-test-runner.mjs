// Stryker の test runner plugin: node --test 用。試験1本単位の結果（killedBy が試験名）を取る。
// 設定（stryker config の nodeTest）:
//   node:      実行ファイル（既定 "node"）
//   nodeArgs:  node に渡す引数（例 ["--import","./test/seat-env.mjs"]）。変異番号の preload はこの前に自動で付ける
//   files:     試験ファイルの glob（cwd = sandbox）。ファイル指定無しの node --test は流さない（根から拾う事故を避ける）
//   exclude:   外す試験ファイルの glob（src を見ない試験、sandbox では成り立たない試験）
//   testArgs:  --test の後に足す引数（例 ["--test-concurrency=2"]）
//   killSignal: 止める時の signal（既定 SIGKILL）
//   failuresFile: 変異ごとの試験の失敗（mutant, test, name, error。Stryker の報告は試験を番号で持つので name でも対応を取る）を JSONL で追記するファイル（絶対パス）。候補に「どの断言／例外で落ちたか」を付けるのに使う
//   doneGraceMs: 初回に分かった試験が全部報告された後、process の終了を待つ時間（既定 1000）。過ぎたら子（hook など）が居残っていても止めて結果を返す
//               （node --test の集計 event は子の終了を待つので、集計ではなく試験IDの揃いで判断する）
// 制約: 変異番号は env と、sandbox 直下の .active-mutant（env を渡さない子プロセス向け）で届ける。
//       sandbox は1つしか無いので、この走者を使う時は Stryker の concurrency を 1 にする（並列は --test-concurrency で取る）。
import { spawn } from 'node:child_process'
import { globSync, appendFileSync } from 'node:fs'
import { relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declareClassPlugin, PluginKind, commonTokens, tokens } from '@stryker-mutator/api/plugin'
import { DryRunStatus, TestStatus, toMutantRunResult } from '@stryker-mutator/api/test-runner'
import { INSTRUMENTER_CONSTANTS } from '@stryker-mutator/api/core'

const here = dirname(fileURLToPath(import.meta.url))
const REPORTER = resolve(here, 'node-test-jsonl-reporter.mjs')
const PRELOAD = resolve(here, 'active-mutant-preload.mjs')

export const strykerValidationSchema = {
  properties: {
    nodeTest: {
      type: 'object',
      properties: {
        node: { type: 'string', default: 'node' },
        nodeArgs: { type: 'array', items: { type: 'string' }, default: [] },
        files: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' }, default: [] },
        testArgs: { type: 'array', items: { type: 'string' }, default: [] },
        killSignal: { type: 'string', default: 'SIGKILL' },
        failuresFile: { type: 'string' },
        doneGraceMs: { type: 'number', default: 1000 },
      },
      required: ['files'],
    },
  },
}

export class NodeTestRunner {
  static inject = tokens(commonTokens.options, commonTokens.logger)
  constructor(options, log) {
    this.log = log
    this.cfg = { node: 'node', nodeArgs: [], exclude: [], testArgs: [], killSignal: 'SIGKILL', doneGraceMs: 1000, ...options.nodeTest }
    if (options.concurrency && options.concurrency > 1) {
      log.warn('nodeTest 走者は sandbox 直下の .active-mutant を使うため concurrency は 1 にすること（今は %s）', options.concurrency)
    }
    this.child = null
  }
  capabilities() { return { reloadEnvironment: true } }
  async init() {}
  async dryRun(_options) {
    const r = await this.run(undefined, null)
    if (r.status === DryRunStatus.Complete) this.expectedIds = new Set(r.tests.map(t => t.id))
    return r
  }
  async mutantRun({ activeMutant }) { return toMutantRunResult(await this.run(activeMutant.id, this.expectedIds), true) }
  async dispose() { await this.kill() }

  async kill() {
    const c = this.child
    if (!c || c.exitCode !== null || c.signalCode !== null) return
    try { process.kill(-c.pid, this.cfg.killSignal) } catch { try { c.kill(this.cfg.killSignal) } catch {} }
    await new Promise(r => c.once('exit', r))
  }

  run(activeMutantId, expectedIds) {
    const cwd = process.cwd()
    const excluded = new Set(this.cfg.exclude.flatMap(g => globSync(g, { cwd })))
    const files = [...new Set(this.cfg.files.flatMap(g => globSync(g, { cwd })))].filter(f => !excluded.has(f)).sort()
    if (files.length === 0) return Promise.resolve({ status: DryRunStatus.Error, errorMessage: `nodeTest.files に合う試験ファイルが無い: ${JSON.stringify(this.cfg.files)} (cwd ${cwd})` })
    const args = ['--import', PRELOAD, ...this.cfg.nodeArgs, '--test', `--test-reporter=${REPORTER}`, '--test-reporter-destination=stdout', ...this.cfg.testArgs, ...files]
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT // 親が node --test の子だと、この変数で子扱いになって reporter に event が来ない
    if (activeMutantId === undefined) delete env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE]
    else env[INSTRUMENTER_CONSTANTS.ACTIVE_MUTANT_ENV_VARIABLE] = String(activeMutantId)
    const started = Date.now()
    return new Promise(res => {
      const child = spawn(this.cfg.node, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      const tests = []
      const seen = new Map()
      let doneTimer = null, skipped = 0
      let buf = ''
      const stderr = []
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buf += chunk
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1)
          const j = line.indexOf('\u001e')
          if (j < 0) continue
          let row
          try { row = JSON.parse(line.slice(j + 1)) } catch { continue }
          if (row.done) continue
          const rel = relative(cwd, row.file).split('\\').join('/')
          if (resolve(cwd, row.name) === row.file) continue // ファイル自体の行
          let id = `${rel}#${row.name}`
          const n = (seen.get(id) || 0) + 1; seen.set(id, n)
          if (n > 1) { id += `#${n}`; seen.set(id, 1) }
          const base = { id, name: `${rel} > ${row.name}`, fileName: rel, startPosition: { line: row.line, column: 0 }, timeSpentMs: row.duration_ms }
          if (row.status === 'skip') { skipped++; continue } // 走っていない試験は候補にしない（報告にも出さない）
          tests.push(row.status === 'fail' ? { ...base, status: TestStatus.Failed, failureMessage: row.error || 'failed' } : { ...base, status: TestStatus.Success })
          if (expectedIds && !doneTimer && tests.length >= expectedIds.size && [...expectedIds].every(x => seen.has(x))) {
            // 初回の試験が全部報告された。居残る子（hook など）のせいで process が終わらない事があるので、少し待って止める
            doneTimer = setTimeout(() => { this.log.debug('全試験が報告されて %sms 経っても終了しないので止める', this.cfg.doneGraceMs); this.kill() }, this.cfg.doneGraceMs)
          }
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', c => { if (stderr.join('').length < 20000) stderr.push(c) })
      child.on('error', e => { this.child = null; res({ status: DryRunStatus.Error, errorMessage: String(e) }) })
      child.on('exit', (code, signal) => {
        this.child = null
        if (doneTimer) { clearTimeout(doneTimer); if (signal === this.cfg.killSignal) code = 0 } // こちらで止めた物は正常終了として扱う（結果は試験ごとに揃っている）
        this.log.debug('node --test 終了 code=%s signal=%s tests=%s skipped=%s %sms', code, signal, tests.length, skipped, Date.now() - started)
        if (this.cfg.failuresFile && activeMutantId !== undefined) {
          try { appendFileSync(this.cfg.failuresFile, tests.filter(t => t.status === TestStatus.Failed).map(t => JSON.stringify({ mutant: String(activeMutantId), test: t.id, name: t.name, error: String(t.failureMessage || '').slice(0, 2000) }) + '\n').join('')) } catch (e) { this.log.warn('failuresFile に書けない: %s', e.message) }
        }
        if (tests.length === 0) return res({ status: DryRunStatus.Error, errorMessage: `試験の結果が1本も取れない (exit ${code} ${signal ?? ''})\n${stderr.join('')}` })
        if (code !== 0 && !tests.some(t => t.status === TestStatus.Failed)) {
          // 失敗した試験は無いのに exit が 0 でない: 試験ファイルの読み込み失敗など。失敗として1本足す
          tests.push({ id: '(process)', name: `node --test exit ${code} ${signal ?? ''}`, status: TestStatus.Failed, failureMessage: stderr.join('').slice(-4000), timeSpentMs: 0 })
        }
        res({ status: DryRunStatus.Complete, tests })
      })
    })
  }
}

export const strykerPlugins = [declareClassPlugin(PluginKind.TestRunner, 'node-test', NodeTestRunner)]
