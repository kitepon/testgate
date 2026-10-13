// fixtures/outputs/ は実ランナーの出力（fixtures/capture-outputs.mjs で取った物）。
//   agent  Bot の席の形（AI_AGENT があると Jest と Vitest は出力を短くする）
//   plain  人が端末で打った形（色つき）
//   rtk    rtk 短縮後
//   spec / tap  node --test のレポーター

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseOutput, stripCounts } from '../adapter.mjs'
import { sample } from './helpers.mjs'

const counts = ({ passed, failed, skipped, errors }) => ({ passed, failed, skipped, errors })

test('生の出力から件数を読む（成功・失敗・読み込みの失敗）', () => {
  const expected = {
    pass: { passed: 6, failed: 0, skipped: 1, errors: undefined },
    fail: { passed: 3, failed: 3, skipped: 1, errors: undefined },
    // slug のテストファイルが読み込めない。errors は failed にも数える。
    error: { passed: 1, failed: 4, skipped: 1, errors: 1 },
  }
  for (const kind of ['jest-agent', 'jest-plain', 'vitest-agent', 'vitest-plain']) {
    for (const [state, want] of Object.entries(expected)) {
      const result = parseOutput(sample(`${kind}-${state}`))
      assert.deepEqual(counts(result), want, `${kind}-${state}`)
      assert.equal(typeof result.durationMs, 'number', `${kind}-${state}`)
    }
  }
  // node の fixtures はテストが一つ多い（greeting）。
  const node = {
    pass: { passed: 7, failed: 0, skipped: 1, errors: undefined },
    fail: { passed: 4, failed: 3, skipped: 1, errors: undefined },
    error: { passed: 2, failed: 4, skipped: 1, errors: 1 },
  }
  for (const kind of ['node-spec', 'node-tap']) {
    for (const [state, want] of Object.entries(node)) {
      const result = parseOutput(sample(`${kind}-${state}`))
      assert.deepEqual(counts(result), want, `${kind}-${state}`)
      assert.equal(typeof result.durationMs, 'number', `${kind}-${state}`)
    }
  }
})

test('失敗したテストの名前か場所を返す。成功なら failures は無い', () => {
  assert.deepEqual(parseOutput(sample('jest-agent-fail')).failures, [
    'taxFor › 税額を地域の税率で計算する',
    'totalPrice › 小計に税を足して合計を出す',
    'totalPrice › 空のカートは0になる',
  ])
  assert.ok(parseOutput(sample('jest-plain-error')).failures.includes('test/slug.test.js: Test suite failed to run'))
  assert.deepEqual(parseOutput(sample('vitest-plain-fail')).failures, [
    'test/price.test.js > totalPrice > 小計に税を足して合計を出す',
    'test/price.test.js > totalPrice > 空のカートは0になる',
    'test/tax.test.js > taxFor > 税額を地域の税率で計算する',
  ])
  assert.deepEqual(parseOutput(sample('node-spec-fail')).failures, [
    '小計に税を足して合計を出す (test/price.test.mjs:6:1)',
    '空のカートは0になる (test/price.test.mjs:10:1)',
    '税額を地域の税率で計算する (test/tax.test.mjs:5:1)',
  ])
  assert.deepEqual(parseOutput(sample('node-tap-error')).failures, [
    '小計に税を足して合計を出す',
    '空のカートは0になる',
    'test/slug.test.mjs',
    '税額を地域の税率で計算する',
  ])
  for (const name of ['jest-agent-pass', 'vitest-plain-pass', 'node-spec-pass', 'node-tap-pass', 'jest-rtk-pass']) {
    assert.equal(parseOutput(sample(name)).failures, undefined, name)
  }
})

test('rtk 短縮後は、残っている分だけ読む。数が無ければ undefined', () => {
  assert.deepEqual(parseOutput(sample('jest-rtk-pass')), { passed: 6, failed: 0, skipped: 1 })
  const failed = parseOutput(sample('jest-rtk-fail'))
  assert.deepEqual(counts(failed), { passed: 3, failed: 3, skipped: 1, errors: undefined })
  assert.deepEqual(failed.failures, ['taxFor 税額を地域の税率で計算する', 'totalPrice 小計に税を足して合計を出す', 'totalPrice 空のカートは0になる'])

  // rtk test は node --test の出力の末尾 5 行だけを残す。pass の行は消えている。
  assert.deepEqual(parseOutput(sample('node-rtk-pass')), { failed: 0, skipped: 1, durationMs: 43 })
  assert.deepEqual(parseOutput(sample('node-rtk-fail')), {})
  // rtk 0.51 は Vitest 5 の出力を読めず、件数も失敗の詳細も残さない。
  assert.deepEqual(parseOutput(sample('vitest-rtk-pass')), {})
  assert.deepEqual(parseOutput(sample('vitest-rtk-fail')), {})
})

test('ランナーの出力でない文字列では何も返さない', () => {
  for (const text of ['', 'hello', undefined, 'No tests found related to files changed since last commit.\n', 'Tests are fun\n# heading\n']) {
    assert.deepEqual(parseOutput(text), {})
  }
})

// 件数の合計行。どのランナーの形でも、これに合う行が残っていてはいけない。
const TOTALS = [
  /^Tests:\s/m,
  /^Test Suites:\s/m,
  /^Snapshots:\s/m,
  /^\s*Test Files\s+\d/m,
  /^\s*Tests\s+\d/m,
  /^\s*[ℹ#] (tests|suites|pass|fail|cancelled|skipped|todo) \d/m,
  /^\s*1\.\.\d+\s*$/m,
  /^PASS \(\d+\)/m,
  /\(\d+ tests?[ )]/,
  /\d+ (passed|skipped)\b/,
]
const colorless = text => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

test('stripCounts の出力に合計行が無い', () => {
  const kinds = ['jest-agent', 'jest-plain', 'jest-rtk', 'vitest-agent', 'vitest-plain', 'vitest-rtk', 'node-spec', 'node-tap', 'node-rtk']
  for (const kind of kinds) {
    for (const state of ['pass', 'fail', 'error']) {
      const stripped = colorless(stripCounts(sample(`${kind}-${state}`)))
      for (const pattern of TOTALS) assert.doesNotMatch(stripped, pattern, `${kind}-${state}`)
      // 落とした後の出力からは、もう件数を読めない。
      const parsed = parseOutput(stripped)
      assert.equal(parsed.passed, undefined, `${kind}-${state}`)
    }
  }
})

test('stripCounts は失敗の詳細と例外を残す', () => {
  const cases = {
    'jest-agent-fail': ['FAIL test/tax.test.js', '● taxFor › 税額を地域の税率で計算する', 'Expected: 100', 'Received: 101', 'at Object.toBe (test/tax.test.js:5:26)', 'Time:'],
    'jest-plain-error': ['● Test suite failed to run', 'SyntaxError: /work/jest-repo/src/slug.js: Unexpected token (13:0)'],
    'jest-rtk-fail': ['1. taxFor 税額を地域の税率で計算する', 'Expected: 275', 'Received: 276'],
    'vitest-agent-fail': ['❯ test/tax.test.js (1 failed)', '× 税額を地域の税率で計算する', 'FAIL  test/price.test.js > totalPrice > 空のカートは0になる', 'AssertionError: expected 276 to be 275', '❯ test/price.test.js:11:30', 'Duration'],
    'vitest-plain-error': ['Failed Suites 1', 'test/slug.test.js [ test/slug.test.js ]', 'Error: Failed to parse source for import analysis'],
    'node-spec-fail': ['✖ 税額を地域の税率で計算する', 'test at test/tax.test.mjs:5:1', '101 !== 100', "code: 'ERR_ASSERTION'", 'file:///work/node-repo/test/tax.test.mjs:6:10', 'duration_ms'],
    'node-spec-error': ["SyntaxError: Unexpected token '}'", '✖ test/slug.test.mjs'],
    'node-tap-fail': ['not ok 2 - 小計に税を足して合計を出す', "location: '/work/node-repo/test/price.test.mjs:6:1'", '276 !== 275'],
    'node-rtk-fail': ['actual: 101,', 'expected: 100,'],
  }
  for (const [name, fragments] of Object.entries(cases)) {
    const stripped = colorless(stripCounts(sample(name)))
    for (const fragment of fragments) assert.ok(stripped.includes(fragment), `${name}: 「${fragment}」が残っている`)
  }
})

test('stripCounts は合計行以外を書き換えない', () => {
  const text = ['$ node build.mjs', 'Tests: see below', 'pass 3 of the pipeline', '  1..2 is a range', 'ℹ note 5', ''].join('\n')
  assert.equal(stripCounts(text), text)
  assert.equal(stripCounts(''), '')
})
