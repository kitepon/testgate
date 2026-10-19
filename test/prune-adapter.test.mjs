// 他言語の刈り込みアダプタの差し込み口（docs/prune-adapter-contract.md）。偽のアダプタで本体の経路を確かめる。
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { runPrune, parsePruneArgs, resolvePruneAdapter, defaultPruneAdapters, PRUNE_RUNNERS, readFailures } from '../lib/prune/index.mjs'
import { analyzeReport } from '../lib/prune/candidates.mjs'
import { tmp } from './tmp.mjs'

// 記録（log.jsonl）は XDG_STATE_HOME の下で断言するので、席の TESTGATE_LOG（配布確認器が固定で渡す）は外す
const { TESTGATE_LOG, ...BASE_ENV } = process.env

const REPORT = {
  schemaVersion: '1', thresholds: { high: 80, low: 60 },
  testFiles: { 'tests/a_test.go': { tests: [{ id: 'TestAdd', name: 'TestAdd', location: { start: { line: 5 } } }, { id: 'TestAddAgain', name: 'TestAddAgain', location: { start: { line: 12 } } }, { id: 'TestNothing', name: 'TestNothing', location: { start: { line: 20 } } }] } },
  files: { 'calc.go': { language: 'go', source: 'package calc\nfunc Add(a, b int) int { return a + b }\nfunc Sub(a, b int) int { return a - b }\n', mutants: [
    { id: '0', mutatorName: 'ArithmeticOperator', replacement: 'a - b', location: { start: { line: 2, column: 33 }, end: { line: 2, column: 38 } }, status: 'Killed', killedBy: ['TestAdd', 'TestAddAgain'] },
    { id: '1', mutatorName: 'ArithmeticOperator', replacement: 'a + b', location: { start: { line: 3, column: 33 }, end: { line: 3, column: 38 } }, status: 'Survived', killedBy: [] },
  ] } },
}
/** 偽のアダプタを書いて path を返す。detectHit: detect(cwd) の戻り。 */
function fakeAdapter(dir, { detectHit = false, withKind = true, noReport = false, throws = false } = {}) {
  const file = join(dir, 'prune.mjs')
  writeFileSync(file, `import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const id = 'fake'
export const runners = ['go test']
export async function detect(cwd) { return ${detectHit} }
export async function name(cwd) { return 'fake-repo' }
export async function prune({ cwd, runDir, sample, seed, mutate, tests, exclude, log }) {
  ${throws ? "throw new Error('boom')" : ''}
  log('fake: sample=' + sample + ' seed=' + seed + ' mutate=' + mutate.join(',') + ' exclude=' + exclude.join(','))
  ${noReport ? 'return { status: 3 }' : ''}
  writeFileSync(join(runDir, 'mutation.json'), JSON.stringify(${JSON.stringify(REPORT)}))
  writeFileSync(join(runDir, 'failures.jsonl'), [
    JSON.stringify({ mutant: '0', test: 'TestAdd', name: 'TestAdd', error: 'a_test.go:7: Add(1, 2) = -1, want 3'${withKind ? ", kind: '狙い'" : ''} }),
    JSON.stringify({ mutant: '0', test: 'TestAddAgain', name: 'TestAddAgain', error: 'panic: runtime error [recovered]'${withKind ? ", kind: '前提'" : ''} }),
  ].join('\\n') + '\\n')
  writeFileSync(join(runDir, 'project.json'), JSON.stringify({ cwd, runner: 'go test' }))
  return { status: 0, runner: 'go test', sampled: { total: 10, sampled: 2, positions: 2 }, excluded: exclude, notes: ['偽のアダプタの注記'] }
}
`)
  return file
}
function lastRun(state) { const d = join(state, 'testgate', 'prune', 'fake-repo'); return join(d, readdirSync(d).sort().at(-1)) }

test('--runner は他言語の名前も受け、未実装のアダプタは exit 2 で理由を出す', async () => {
  assert.deepEqual(PRUNE_RUNNERS, ['node-test', 'jest', 'vitest', 'dotnet', 'pytest', 'cargo', 'go'])
  assert.equal(parsePruneArgs(['--runner', 'dotnet']).runner, 'dotnet')
  assert.match(parsePruneArgs(['--runner', 'swift']).error, /--runner は node-test\|jest\|vitest\|dotnet\|pytest\|cargo\|go: swift/)
  const logs = []
  const code = await runPrune({ cwd: tmp('tg-pa-'), runner: 'dotnet', adapters: {}, env: { ...BASE_ENV, XDG_STATE_HOME: tmp('tg-pa-state-') }, log: m => logs.push(m), stdout: () => {} })
  assert.equal(code, 2)
  assert.match(logs.join('\n'), /--runner dotnet の刈り込みアダプタは未実装（adapters\/dotnet\/prune\.mjs が無い）/)
  assert.deepEqual(typeof defaultPruneAdapters(tmp('tg-pa-empty-')), 'object')
})

test('アダプタが書いた mutation.json と failures.jsonl（kind 付き）から本体が候補・記録・log を出す', async () => {
  const cwd = tmp('tg-pa-cwd-'), state = tmp('tg-pa-state-')
  const file = fakeAdapter(tmp('tg-pa-mod-'))
  const logs = [], outs = []
  const code = await runPrune({ cwd, runner: 'go', adapters: { go: file }, sample: 2, seed: 's1', mutate: ['calc.go'], exclude: ['tests/skip_test.go'], env: { ...BASE_ENV, XDG_STATE_HOME: state }, log: m => logs.push(m), stdout: s => outs.push(s) })
  assert.equal(code, 0, logs.join('\n'))
  assert.match(logs.join('\n'), /アダプタ go（.*prune\.mjs）\/ 記録 /)
  assert.match(logs.join('\n'), /fake: sample=2 seed=s1 mutate=calc\.go exclude=tests\/skip_test\.go/)
  const rec = lastRun(state)
  for (const f of ['mutation.json', 'failures.jsonl', 'project.json', 'candidates.json', 'candidates.txt']) assert.ok(existsSync(join(rec, f)), f)
  const c = JSON.parse(readFileSync(join(rec, 'candidates.json'), 'utf8'))
  assert.equal(c.runner, 'go test'); assert.equal(c.seed, 's1'); assert.equal(c.name, 'fake-repo')
  assert.deepEqual(c.sampled, { total: 10, sampled: 2, positions: 2 }); assert.deepEqual(c.excluded, ['tests/skip_test.go'])
  assert.equal(c.tests, 3); assert.equal(c.stat.killed, 1)
  // kind はアダプタの物を使う: TestAdd は狙い、TestAddAgain は前提（JS の AssertionError 判定なら両方「前提」になる所）
  assert.equal(c.killKinds.狙い, 1); assert.equal(c.killKinds.前提, 1)
  const names = Object.fromEntries(c.candidates.map(x => [x.test.name, x.reason]))
  assert.equal(names.TestNothing, '検出0'); assert.equal(names.TestAddAgain, '前提のみ'); assert.equal(names.TestAdd, undefined) // 狙いで独占 → 残す
  assert.match(readFileSync(join(rec, 'candidates.txt'), 'utf8'), /偽のアダプタの注記/)
  assert.match(outs.join(''), /記録: .*（candidates\.json \/ candidates\.txt \/ mutation\.json \/ prune\.log）/)
  const log = readFileSync(join(state, 'testgate', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1)
  assert.equal(log.event, 'prune'); assert.equal(log.runner, 'go test'); assert.equal(log.name, 'fake-repo'); assert.equal(log.tests, 3); assert.equal(log.killed, 1)
})

test('kind 無しの failures.jsonl は JS 向けの判定に落ち、2 回目は合算が出る', async () => {
  const cwd = tmp('tg-pa-cwd-'), state = tmp('tg-pa-state-')
  const file = fakeAdapter(tmp('tg-pa-mod-'), { withKind: false })
  const quiet = { log: () => {}, stdout: () => {} }
  assert.equal(await runPrune({ cwd, runner: 'go', adapters: { go: file }, env: { ...BASE_ENV, XDG_STATE_HOME: state }, ...quiet }), 0)
  let c = JSON.parse(readFileSync(join(lastRun(state), 'candidates.json'), 'utf8'))
  assert.equal(c.killKinds.狙い, 0); assert.equal(c.killKinds.前提, 2) // Go の失敗文は AssertionError で始まらない
  const outs = []
  await new Promise(r => setTimeout(r, 1100)) // 記録のフォルダ名は秒単位なので、2 回目を次の秒にする
  assert.equal(await runPrune({ cwd, runner: 'go', adapters: { go: file }, env: { ...BASE_ENV, XDG_STATE_HOME: state }, log: () => {}, stdout: s => outs.push(s) }), 0)
  assert.ok(existsSync(join(lastRun(state), 'candidates-merged.json')))
  assert.match(outs.join(''), /--- 2 回分の合算/)
})

test('--runner 無しで package.json が無い時は detect(cwd) が true のアダプタを使う。package.json が有れば JS の経路', async () => {
  const cwd = tmp('tg-pa-cwd-'), state = tmp('tg-pa-state-')
  const miss = fakeAdapter(tmp('tg-pa-mod-'), { detectHit: false }), hit = fakeAdapter(tmp('tg-pa-mod-'), { detectHit: true })
  const r = await resolvePruneAdapter({ runner: undefined, cwd, adapters: { pytest: miss, go: hit } })
  assert.equal(r.runner, 'go')
  assert.equal(await resolvePruneAdapter({ runner: undefined, cwd, adapters: { pytest: miss } }), null)
  writeFileSync(join(cwd, 'package.json'), '{}')
  assert.equal(await resolvePruneAdapter({ runner: undefined, cwd, adapters: { go: hit } }), null)
  const bad = tmp('tg-pa-mod-'); writeFileSync(join(bad, 'prune.mjs'), 'export const id = "bad"\n')
  assert.match((await resolvePruneAdapter({ runner: 'go', cwd, adapters: { go: join(bad, 'prune.mjs') } })).error, /prune\(\) が無い/)
  const logs = []
  assert.equal(await runPrune({ cwd, runner: 'go', adapters: { go: join(bad, 'prune.mjs') }, env: { ...BASE_ENV, XDG_STATE_HOME: state }, log: m => logs.push(m), stdout: () => {} }), 2)
})

test('アダプタが mutation.json を書かずに終わる・例外で止まる時は失敗の exit と log.jsonl の 1 行', async () => {
  const cwd = tmp('tg-pa-cwd-'), state = tmp('tg-pa-state-')
  const logs = []
  assert.equal(await runPrune({ cwd, runner: 'go', adapters: { go: fakeAdapter(tmp('tg-pa-mod-'), { noReport: true }) }, env: { ...BASE_ENV, XDG_STATE_HOME: state }, log: m => logs.push(m), stdout: () => {} }), 3)
  assert.match(logs.join('\n'), /アダプタ go が mutation\.json を書かずに終わった（exit 3）/)
  assert.equal(await runPrune({ cwd, runner: 'go', adapters: { go: fakeAdapter(tmp('tg-pa-mod-'), { throws: true }) }, env: { ...BASE_ENV, XDG_STATE_HOME: state }, log: m => logs.push(m), stdout: () => {} }), 1)
  assert.match(logs.join('\n'), /アダプタ go が例外で止まった: Error: boom/)
  const rows = readFileSync(join(state, 'testgate', 'log.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.deepEqual(rows.map(r => [r.event, r.status, r.tests]), [['prune', 3, undefined], ['prune', 1, undefined]])
})

test('集計: failures の kind が有ればそれを使い、無ければ失敗文から判定する', () => {
  const r = JSON.parse(JSON.stringify(REPORT))
  const a = analyzeReport(r, { failures: [
    { mutant: '0', test: 'TestAdd', error: 'not an assertion', kind: '狙い' },
    { mutant: '0', test: 'TestAddAgain', error: 'AssertionError [ERR_ASSERTION]: x\n    at TestContext.<anonymous> (file:///r/tests/a_test.go:12:5)', kind: 'でたらめ' },
  ] })
  assert.equal(a.killKinds.狙い, 2) // 2 本目は kind が契約外なので失敗文の判定（AssertionError かつ試験ファイルの frame → 狙い）
  assert.deepEqual(readFailures(join(tmp('tg-pa-none-'), 'nothing.jsonl')), [])
})
