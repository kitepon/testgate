import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseOutput, stripCounts } from '../adapter.mjs'
import { read } from './helpers.mjs'

const out = f => read(`outputs/${f}`)
const pub = f => read(`outputs/public/${f}`)
const rtk = f => read(`rtk/${f}`)

// ───────── swift test（この席で実際に走らせた出力）─────────

test('swift: 成功（XCTest 3 + Swift Testing 2）', () => {
  const r = parseOutput(out('swift-success.txt'))
  assert.equal(r.passed, 5)
  assert.equal(r.failed, 0)
  assert.equal(r.skipped, 0)
  assert.equal(r.errors, undefined)
  assert.equal(r.failures, undefined)
})

test('swift: 失敗と skip（XCTest の表明失敗と Swift Testing の失敗を足す）', () => {
  const r = parseOutput(out('swift-failure.txt'))
  assert.equal(r.passed, 3)
  assert.equal(r.failed, 2)
  assert.equal(r.skipped, 1)
  assert.deepEqual(r.failures, ['CalcTests.testMul', 'shoutsEmpty()'])
  assert.equal(r.errors, undefined)
})

test('swift: --filter で絞った出力（Swift Testing は 0 件）', () => {
  const r = parseOutput(out('swift-filtered.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 1, 1])
})

test('swift: コンパイル失敗は errors（failed にも数える）。テストの件数は出ない', () => {
  const r = parseOutput(out('swift-build-failure.txt'))
  assert.equal(r.errors, 1)
  assert.equal(r.failed, 1)
  assert.equal(r.passed, undefined)
  assert.match(r.failures[0], /Calc\.swift:1:50: error: cannot find 'undefinedName'/)
})

// ───────── 公開された実ログ（swift test・xcodebuild）─────────

test('swift test の Linux・macOS: XCTest 4（1 失敗）+ Swift Testing 2（1 失敗）', () => {
  for (const f of ['MixedTestLog_6_0_Linux.txt', 'MixedTestLog_6_0_macOS.txt']) {
    const r = parseOutput(pub(f))
    assert.equal(r.passed, 4, f)
    assert.equal(r.failed, 2, f)
    assert.equal(r.skipped, 0, f)
    assert.equal(r.failures.length, 2, f)
  }
})

test('swift test: 83 件・1 失敗・1 skip（古い要約は skip を数えない）', () => {
  const r = parseOutput(pub('TestLog.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [81, 1, 1])
  assert.deepEqual(r.failures, ['XcbeautifyLibTests.XcbeautifyLibTests testAggregateTarget'])
})

test('swift test: XCTest 113 + Swift Testing 351（失敗2・skip1）', () => {
  const r = parseOutput(pub('swift_test_log_macOS.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [461, 2, 1])
  assert.equal(r.failures.length, 2)
})

test('Swift Testing だけ（SF Symbols の記号）: 3 件・1 失敗・1 skip', () => {
  const r = parseOutput(pub('demo_swift_testing_log.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [1, 1, 1])
  assert.deepEqual(r.failures, ['secondExample()'])
})

test('Swift Testing: 4 件・3 失敗', () => {
  const r = parseOutput(pub('spi_swift_testing_short_log.txt'))
  assert.deepEqual([r.passed, r.failed], [1, 3])
  assert.equal(r.failures.length, 3)
})

test('xcodebuild 並列（要約なし。ケース行から数える）', () => {
  const r = parseOutput(pub('ParallelTestLog.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [19, 1, 1])
  assert.deepEqual(r.failures, ['BuildFlagTests.test_failIntentionally()'])
})

test('xcodebuild 2013 年形式（octest 922 件・1 失敗）', () => {
  const r = parseOutput(pub('specta_fail_octest.txt'))
  assert.deepEqual([r.passed, r.failed], [921, 1])
  assert.deepEqual(r.failures, ['RACTupleSpec RACTupleUnpack_should_unpack_multiple_values'])
  assert.equal(r.durationMs, 6743)
})

test('xcodebuild 成功の抜粋（バンドル要約なし。スイートごとの要約も二重に数えない）', () => {
  const r = parseOutput(pub('xcpretty_xcodebuild_excerpt.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [110, 0, 0])
})

test('xcodebuild のコンパイル失敗（clang の error 2 件）', () => {
  const r = parseOutput(pub('xcpretty_kiwi_compile_fail.txt'))
  assert.equal(r.errors, 2)
  assert.equal(r.failed, 2)
  assert.equal(r.passed, undefined)
})

test('xcodebuild の ** TEST BUILD FAILED **（作った物。error 行が無くても 1 以上）', () => {
  const r = parseOutput(out('constructed-xcodebuild-test-build-failed.txt'))
  assert.equal(r.errors, 2)
  assert.equal(r.failed, 2)
  const bare = parseOutput('** TEST BUILD FAILED **\n')
  assert.equal(bare.errors, 1)
  assert.equal(bare.failed, 1)
})

test('xcodebuild の ** TEST FAILED ** はテストの失敗。errors に数えない', () => {
  const r = parseOutput([
    "Test Case '-[AppTests.FooTests testA]' started.",
    "/src/FooTests.swift:12: error: -[AppTests.FooTests testA] : XCTAssertEqual failed: (\"1\") is not equal to (\"2\")",
    "Test Case '-[AppTests.FooTests testA]' failed (0.001 seconds).",
    "Test Suite 'Selected tests' failed at 2026-10-13 10:00:00.000.",
    "\t Executed 1 test, with 1 failure (0 unexpected) in 0.001 (0.002) seconds",
    '** TEST FAILED **'
  ].join('\n'))
  assert.equal(r.errors, undefined)
  assert.deepEqual([r.passed, r.failed], [0, 1])
})

// ───────── gradle（この席で実際に走らせた出力）─────────

test('gradle: 成功の既定出力には件数が無い。数を作らない', () => {
  const r = parseOutput(out('gradle-success.txt'))
  assert.equal(r.passed, undefined)
  assert.equal(r.failed, undefined)
  assert.equal(r.durationMs, 3000)
})

test('gradle: testLogging を付けた成功は PASSED 行を数える', () => {
  const r = parseOutput(out('gradle-success-logging.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [4, 0, 0])
})

test('gradle: 失敗（既定）。失敗の数は分かる。通った数は他のタスクが分からないので出さない', () => {
  const r = parseOutput(out('gradle-failure.txt'))
  assert.equal(r.failed, 1)
  assert.equal(r.passed, undefined)
  assert.deepEqual(r.failures, ['CalcTest > mulWorks()'])
  assert.equal(r.errors, undefined)
})

test('gradle: 失敗（testLogging あり）は通った数も出る', () => {
  const r = parseOutput(out('gradle-failure-logging.txt'))
  assert.deepEqual([r.passed, r.failed, r.skipped], [3, 1, 0])
  assert.deepEqual(r.failures, ['CalcTest > mulWorks()'])
})

test('gradle: compileJava の失敗は errors（テストの失敗ではない）', () => {
  const r = parseOutput(out('gradle-compile-failure.txt'))
  assert.equal(r.errors, 1)
  assert.equal(r.failed, 1)
  assert.equal(r.passed, undefined)
  assert.match(r.failures[0], /Calc\.java:3: error: illegal start of expression/)
})

test('gradle: 依存解決の失敗（コンパイルの error 行が無い）も errors', () => {
  const r = parseOutput([
    '> Task :app:compileJava FAILED',
    '',
    'FAILURE: Build failed with an exception.',
    '',
    '* What went wrong:',
    "Execution failed for task ':app:compileJava'.",
    "> Could not resolve all files for configuration ':app:compileClasspath'.",
    '',
    'BUILD FAILED in 1s'
  ].join('\n'))
  assert.equal(r.errors, 1)
  assert.equal(r.failed, 1)
})

test('gradle: 設定の失敗（FAILED タスクが無い）も errors', () => {
  const r = parseOutput([
    'FAILURE: Build failed with an exception.',
    '',
    '* Where:',
    "Build file '/x/build.gradle' line: 3",
    '',
    '* What went wrong:',
    'A problem occurred evaluating root project.',
    '',
    'BUILD FAILED in 400ms'
  ].join('\n'))
  assert.equal(r.errors, 1)
  assert.equal(r.durationMs, 400)
})

test('gradle: 時間の読み取り（分・時間・ミリ秒）', () => {
  assert.equal(parseOutput('BUILD SUCCESSFUL in 1m 2s\n').durationMs, 62000)
  assert.equal(parseOutput('BUILD SUCCESSFUL in 1h 2m 3s\n').durationMs, 3723000)
  assert.equal(parseOutput('BUILD SUCCESSFUL in 850ms\n').durationMs, 850)
})

// ───────── rtk 短縮後 ─────────
// rtk test はこれらのランナーを知らず、末尾5行だけを残す。件数は一部しか見えないので返さない。
// 見えている失敗名は残す。

test('rtk 短縮後: 件数を作らない・失敗名は残す', () => {
  for (const f of ['swift-success.rtk.txt', 'swift-failure.rtk.txt', 'gradle-success.rtk.txt', 'gradle-failure.rtk.txt']) {
    const r = parseOutput(rtk(f))
    assert.equal(r.passed, undefined, f)
    assert.equal(r.failed, undefined, f)
    assert.equal(r.errors, undefined, f)
  }
  assert.deepEqual(parseOutput(rtk('swift-failure.rtk.txt')).failures, ['shoutsEmpty()'])
})

test('数が取れない物（空・無関係な文）は空のオブジェクト', () => {
  assert.deepEqual(parseOutput(''), {})
  assert.deepEqual(parseOutput('hello\nworld\n'), {})
  assert.deepEqual(parseOutput(undefined), {})
})

test('ANSI 色と CRLF が混ざっても読める', () => {
  const t = read('outputs/swift-failure.txt').replace(/Test Case/g, '\u001b[31mTest Case\u001b[0m').replace(/\n/g, '\r\n')
  const r = parseOutput(t)
  assert.deepEqual([r.passed, r.failed, r.skipped], [3, 2, 1])
})

test('failures は 50 件まで', () => {
  const lines = []
  for (let i = 0; i < 80; i++) lines.push(`Test Case 'S.t${i}' failed (0.0 seconds)`)
  const r = parseOutput(lines.join('\n'))
  assert.equal(r.failures.length, 50)
  assert.equal(r.failed, 80)
})

// ───────── stripCounts ─────────

const COUNT_RE = /Executed \d+ tests?|Test run with \d+ tests?|\d+ tests? completed|^\d+ errors?$|errors? generated/m

test('stripCounts: swift の合計行が無く、失敗の詳細は残る', () => {
  const src = out('swift-failure.txt')
  assert.match(src, COUNT_RE)
  const s = stripCounts(src)
  assert.doesNotMatch(s, COUNT_RE)
  assert.match(s, /XCTAssertEqual failed: \("5"\) is not equal to \("6"\)/)
  assert.match(s, /Test Case 'CalcTests\.testMul' failed/)
  assert.match(s, /Expectation failed: \(shout\(""\)/)
  assert.match(s, /Test shoutsEmpty\(\) failed after/)
  assert.match(s, /Test Suite 'All tests' failed at/)
})

test('stripCounts: gradle の合計行が無く、失敗の詳細は残る', () => {
  const src = out('gradle-failure.txt')
  assert.match(src, COUNT_RE)
  const s = stripCounts(src)
  assert.doesNotMatch(s, COUNT_RE)
  assert.match(s, /CalcTest > mulWorks\(\) FAILED/)
  assert.match(s, /AssertionFailedError at CalcTest\.java:6/)
  assert.match(s, /There were failing tests/)
  assert.match(s, /BUILD FAILED/)
})

test('stripCounts: コンパイル失敗の error 行は残り、「1 error」だけが落ちる', () => {
  const s = stripCounts(out('gradle-compile-failure.txt'))
  assert.match(s, /error: illegal start of expression/)
  assert.doesNotMatch(s, /^1 error$/m)
  const x = stripCounts(pub('xcpretty_kiwi_compile_fail.txt'))
  assert.match(x, /use of undeclared identifier 'trololo'/)
  assert.doesNotMatch(x, /2 errors generated/)
})

test('stripCounts: 公開ログ（xcodebuild・Swift Testing の記号つき）', () => {
  for (const f of ['TestLog.txt', 'ParallelTestLog.txt', 'demo_swift_testing_log.txt', 'swift_test_log_macOS.txt', 'specta_fail_octest.txt']) {
    const src = pub(f)
    const s = stripCounts(src)
    assert.doesNotMatch(s, /^\s*Executed \d+ tests?, with/m, f)
    assert.doesNotMatch(s, /Test run with \d+ tests?/, f)
    assert.ok(s.length > src.length * 0.5, f) // 合計行だけ落ちる。本文は残る
  }
  assert.match(stripCounts(pub('demo_swift_testing_log.txt')), /Expectation failed: true == false/)
})

test('stripCounts: 失敗の無い出力でも壊れない。行の並びを保つ', () => {
  const s = stripCounts('a\n\tExecuted 3 tests, with 0 failures (0 unexpected) in 0.1 (0.1) seconds\nb\n')
  assert.equal(s, 'a\nb\n')
  assert.equal(stripCounts(''), '')
})

test('stripCounts: rtk 短縮後でも動く', () => {
  const s = stripCounts(rtk('swift-failure.rtk.txt'))
  assert.doesNotMatch(s, /Test run with/)
  assert.match(s, /shoutsEmpty\(\) failed after/)
  assert.match(stripCounts(rtk('gradle-failure.rtk.txt')), /BUILD FAILED/)
})
