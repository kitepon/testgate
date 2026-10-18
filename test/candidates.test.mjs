// 候補集計の分類（狙い／前提）・同因の束ね・Timeout の内訳（v0.3.10、2026-10-18 の担当 3 人の採否から）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.mjs'
import { analyzeReport, formatCandidates, classifyKill, firstFrameFile, failureSignature } from '../lib/prune/candidates.mjs'
import { readFailures } from '../lib/prune/index.mjs'

const SB = 'file:///r/.stryker-tmp/sandbox-abc/'
const assertIn = (file, line = 5, msg = 'Expected values to be strictly equal:\n\n1 !== 2') => `AssertionError [ERR_ASSERTION]: ${msg}\n\n    at TestContext.<anonymous> (${SB}${file}:${line}:3)\n    at Test.run (node:internal/test_runner/test:1402:25)`
const typeErrorIn = file => `TypeError: Cannot read properties of undefined (reading 'note_tweet')\n    at pick (${SB}${file}:12:9)\n    at TestContext.<anonymous> (${SB}test/a.test.mjs:30:5)`

test('殺しの分類: 試験ファイルの断言は狙い、例外・製品コードや helper の断言・記録無しは前提／不明', () => {
  assert.equal(classifyKill(assertIn('test/a.test.mjs'), 'test/a.test.mjs'), '狙い')
  assert.equal(classifyKill(assertIn('test/a.test.mjs'), 'test/b.test.mjs'), '前提') // 別の試験ファイルの断言（helper）
  assert.equal(classifyKill(assertIn('test/helpers.mjs'), 'test/a.test.mjs'), '前提')
  assert.equal(classifyKill(typeErrorIn('src/x.mjs'), 'test/a.test.mjs'), '前提')
  assert.equal(classifyKill('Error: CHANNEL_STATE_INVALID\n    at f (' + SB + 'test/a.test.mjs:3:1)', 'test/a.test.mjs'), '前提')
  assert.equal(classifyKill(null, 'test/a.test.mjs'), '不明')
  // frame の形: file:// 無し、node: の内部 frame は飛ばす、Windows の区切り
  assert.equal(firstFrameFile('TypeError: x\n    at parse (/r/.stryker-tmp/sandbox-n2/src/client/s.ts:197:32)'), 'src/client/s.ts')
  assert.equal(firstFrameFile('AssertionError: x\n    at async Test.run (node:internal/test_runner/test:1409:7)\n    at ' + SB + 'test/a.test.mjs:9:1'), 'test/a.test.mjs')
  assert.equal(firstFrameFile('AssertionError: x\n    at f (C:\\r\\.stryker-tmp\\sandbox-q\\test\\a.test.mjs:9:1)'), 'test/a.test.mjs')
  assert.equal(firstFrameFile('AssertionError: x'), '')
  // 正規化: 数値・path・UUID・hex・引用の中身を消し、1 行目と最初の frame のファイルだけ残す
  const sig = failureSignature("AssertionError [ERR_ASSERTION]: 'abc' !== 'xyz' at /tmp/steer-1a2b3c/x.mjs 42 0x1f3a 3f2504e0-4f89-11d3-9a0c-0305e82c3301\n    at TestContext.<anonymous> (" + SB + 'test/a.test.mjs:61:10)')
  assert.equal(sig, 'AssertionError [ERR_ASSERTION]: <q> !== <q> at <path> <n> <n> <uuid>\u0000test/a.test.mjs')
  assert.equal(failureSignature(assertIn('test/a.test.mjs', 5, 'got 1')), failureSignature(assertIn('test/a.test.mjs', 9, 'got 2')))
  assert.notEqual(failureSignature(assertIn('test/a.test.mjs')), failureSignature(assertIn('test/b.test.mjs')))
})

/** 小さな記録を tmp() に書く。試験 T0〜T5（test/a.test.mjs）と T6（test/b.test.mjs）。 */
function writeRecord({ sameCause = true } = {}) {
  const dir = tmp('tg-cand-')
  const ids = Array.from({ length: 7 }, (_, i) => `${i < 6 ? 'test/a.test.mjs' : 'test/b.test.mjs'}#T${i}`)
  const t = (id, i) => ({ id, name: id.replace('#', ' > '), location: { start: { line: i + 1, column: 1 } } })
  const src = ['export function parse(s) {', '  const kind = s ? "background" : ""', '  return kind', '}', 'export const digest = (x) => {', '  return sha(x)', '}', 'export function unused(y) {', '  return y + 1', '}']
  const loc = (line, c1, c2) => ({ start: { line, column: c1 }, end: { line, column: c2 } })
  const report = {
    schemaVersion: '2',
    testFiles: { 'test/a.test.mjs': { tests: ids.slice(0, 6).map(t) }, 'test/b.test.mjs': { tests: ids.slice(6).map(t) } },
    files: { 'src/x.mjs': { source: src.join('\n'), mutants: [
      // 変異 0: fixture の値を空にする前提の破壊。T0〜T3 の 4 本が同じ形で落ちる（T0〜T2 は断言、T3 は TypeError）。T4 は別の形の断言
      { id: '0', mutatorName: 'StringLiteral', replacement: '""', status: 'Killed', killedBy: ids.slice(0, 5), location: loc(2, 19, 31) },
      // 変異 1: T4 と T5 が狙いで殺す（同じ形だが 2 本）
      { id: '1', mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Killed', killedBy: [ids[4], ids[5]], location: loc(2, 16, 17) },
      // 変異 2: T5 だけが狙いで殺す
      { id: '2', mutatorName: 'ArrowFunction', replacement: '() => undefined', status: 'Killed', killedBy: [ids[5]], location: loc(5, 23, 24) },
      // 変異 3: T6 が製品コードの TypeError で殺す（前提）
      { id: '3', mutatorName: 'MethodExpression', replacement: 'x', status: 'Killed', killedBy: [ids[6]], location: loc(6, 10, 16) },
      // 変異 4: Timeout（killedBy 無し）、変異 5: 生存（parse の中。同関数に殺された変異あり）、変異 6: 生存（unused の中。同関数に無し）
      { id: '4', mutatorName: 'BlockStatement', replacement: '{}', status: 'Timeout', killedBy: [], location: loc(1, 27, 28) },
      { id: '5', mutatorName: 'StringLiteral', replacement: '""', status: 'Survived', killedBy: [], location: loc(2, 33, 35) },
      { id: '6', mutatorName: 'ArithmeticOperator', replacement: 'y - 1', status: 'Survived', killedBy: [], location: loc(9, 10, 15) },
    ] } },
  }
  writeFileSync(join(dir, 'mutation.json'), JSON.stringify(report))
  const rows = []
  for (let i = 0; i < 3; i++) rows.push({ mutant: '0', test: ids[i], name: ids[i].replace('#', ' > '), error: assertIn('test/a.test.mjs', 10 + i, sameCause ? `kind is '' (case ${i})` : `message ${i} ${'!'.repeat(i)} differs${i}x`) })
  rows.push({ mutant: '0', test: ids[3], error: typeErrorIn('src/x.mjs') })
  rows.push({ mutant: '0', test: ids[4], error: assertIn('test/a.test.mjs', 20, 'parse returned nothing') })
  rows.push({ mutant: '1', test: ids[4], error: assertIn('test/a.test.mjs', 21) }, { mutant: '1', test: ids[5], error: assertIn('test/a.test.mjs', 25) })
  rows.push({ mutant: '2', test: ids[5], error: assertIn('test/a.test.mjs', 26, 'digest') })
  rows.push({ mutant: '3', test: ids[6], error: typeErrorIn('src/x.mjs') })
  writeFileSync(join(dir, 'failures.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return { dir, ids, report }
}

test('集計: 同じ変異で 3 本以上が同じ形で落ちた断言は前提、冗長は狙いの殺しだけで決め、狙いの無い試験は「前提のみ」', () => {
  const { dir, ids } = writeRecord()
  const a = analyzeReport(JSON.parse(require_(join(dir, 'mutation.json'))), { failures: readFailures(join(dir, 'failures.jsonl')) })
  const by = Object.fromEntries(a.candidates.map(c => [c.test.id, c]))
  // T0〜T2 は断言でも 3 本同じ形 → 前提。T3 は TypeError → 前提。よって T0〜T3 は前提のみ
  // 残す側の T4 は変異 0 を狙いで殺すので「同じ変異を狙いで殺す残す試験」に出る（前提の殺しの代替ではなく、変異の守り手の案内）
  for (const i of [0, 1, 2, 3]) { assert.equal(by[ids[i]].reason, '前提のみ', ids[i]); assert.equal(by[ids[i]].detail[0].kind, '前提'); assert.deepEqual(by[ids[i]].detail[0].others, ['test/a.test.mjs > T4']) }
  assert.equal(by[ids[0]].detail[0].same, 3); assert.equal(by[ids[3]].detail[0].same, 1)
  // T4 は変異 0 を別の形の断言で狙い、変異 1 も狙う。T5 は変異 2 を独占 → 残す。T4 の狙いの殺し {0} は誰も代替しない → 残す
  assert.ok(!by[ids[4]]); assert.ok(!by[ids[5]]); assert.equal(a.kept, 2)
  // T6 は製品コードの TypeError だけ → 前提のみ（広域ではない）
  assert.equal(by[ids[6]].reason, '前提のみ'); assert.equal(by[ids[6]].detail[0].kind, '前提'); assert.equal(by[ids[6]].detail[0].failure, "TypeError: Cannot read properties of undefined (reading 'note_tweet')")
  assert.deepEqual(a.killKinds, { 狙い: 4, 前提: 5, 不明: 0 })
  // Timeout は Killed と分け、被覆に入れない
  assert.deepEqual(a.stat, { killed: 4, timeout: 1, survived: 2, errors: 0 })
  assert.deepEqual(a.timeouts, [{ id: '4', mutant: 'src/x.mjs:1:27-1:28 BlockStatement → {}' }])
  assert.deepEqual(a.survived, ['5 src/x.mjs:2:33-2:35 StringLiteral → ""', '6 src/x.mjs:9:10-9:15 ArithmeticOperator → y - 1'])
  const text = formatCandidates(a)
  assert.match(text, /^変異 7 件を流した（Killed 4・Timeout 1、生存 2）。試験 7 本のうち残す 2 本、候補 5 本（冗長 0、前提のみ 5、広域のみ 0、検出0 0）/)
  assert.match(text, /\[前提のみ\] test\/a.test.mjs > T0\n  殺す変異: \[0\] src\/x.mjs:2:19-2:31 StringLiteral → "" \[前提\]（同じ形で 3 本が落ちる）\n    失敗: AssertionError/)
  assert.match(text, /同じ変異を狙いで殺す残す試験: 無し/)
  assert.match(text, /\nTimeout の変異（1 件。[^\n]*）:\n  \[4\] src\/x.mjs:1:27-1:28 BlockStatement → \{\}\n/)
  // 閾値を上げれば（4 本）T0〜T2 の断言は狙いに戻る。変異 1 は残す T5 が被覆済みなので、変異 0 だけ残る T0 が先に残り、T1・T2・T4 が冗長
  const b = analyzeReport(JSON.parse(require_(join(dir, 'mutation.json'))), { failures: readFailures(join(dir, 'failures.jsonl')), sameCauseMin: 4 })
  const byB = Object.fromEntries(b.candidates.map(c => [c.test.id, c]))
  assert.equal(b.kept, 2); assert.deepEqual(b.candidates.filter(c => c.reason === '冗長').map(c => c.test.id), [ids[1], ids[2], ids[4]])
  assert.equal(byB[ids[1]].reason, '冗長'); assert.equal(byB[ids[1]].detail[0].kind, '狙い'); assert.equal(byB[ids[1]].detail[0].others.length, 1)
  assert.equal(byB[ids[3]].reason, '前提のみ')
  assert.match(formatCandidates(b), /同じ変異で 4 本以上の試験が同じ形/)
})

test('集計: 失敗の形が違えば束ねない', () => {
  const { dir, ids } = writeRecord({ sameCause: false })
  const a = analyzeReport(JSON.parse(require_(join(dir, 'mutation.json'))), { failures: readFailures(join(dir, 'failures.jsonl')) })
  const by = Object.fromEntries(a.candidates.map(c => [c.test.id, c]))
  assert.equal(by[ids[1]].reason, '冗長'); assert.equal(by[ids[1]].detail[0].kind, '狙い'); assert.equal(by[ids[1]].detail[0].same, 1)
})

function require_(p) { return readFileSync(p, 'utf8') }
