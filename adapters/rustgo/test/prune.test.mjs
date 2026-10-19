// 刈り込みアダプタ（prune.mjs）の試験。契約: docs/prune-adapter-contract.md
// 道具（go・cargo）が要らない部分（字句・変異の列挙・結果の変換・kind の判定・標本）は skip しない。実物の一巡だけ、道具が無い環境で skip する。
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmp } from '../../../test/tmp.mjs'
import {
  id, runners, detect, name, prune, languageOf, lex, goMutants, rustScan, describeMutant, applyMutant, sampleMutants, seededRandom, globToRegExp, matchesAny,
  parseGoTestJson, goFailedTests, goFailureText, classifyGoFailure, parseCargoTest, rustPanic, classifyRustFailure, judgeRun, goPatterns,
} from '../prune.mjs'
import { analyzeReport } from '../../../lib/prune/candidates.mjs'
import { runPrune, readFailures } from '../../../lib/prune/index.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PRUNE = path.join(here, '..', 'prune.mjs')
const FIX = path.join(here, '..', 'fixtures')
const has = cmd => spawnSync(cmd, cmd === 'go' ? ['version'] : ['--version'], { encoding: 'utf8' }).status === 0
const HAS_GO = has('go'), HAS_CARGO = has('cargo')

const mut = (list, mutatorName) => list.filter(m => m.mutatorName === mutatorName)
const apply = (src, list) => list.map(m => applyMutant(src, m))

// ============================================================ 字句 ============================================================

test('lex: Go の文字列・raw 文字列・rune・コメントの中は読まない', () => {
  const src = 'a := "x + y" // z + w\n/* q - r */ b := `p * q` + \'+\'\n'
  const toks = lex(src, 'go').map(t => t.s)
  assert.deepEqual(toks, ['a', ':=', '"x + y"', 'b', ':=', '`p * q`', '+', "'+'"])
})

test('lex: Rust の raw 文字列・lifetime・入れ子コメント・数値の接尾辞', () => {
  const src = "fn f<'a>(x: &'a str) -> u8 { /* a /* b */ c */ let s = r#\"a \"+\" b\"#; let c = 'x'; 10u8 }"
  const toks = lex(src, 'rust')
  const strs = toks.filter(t => t.k === 'str').map(t => t.s)
  assert.deepEqual(strs, ['r#"a "+" b"#'])
  assert.deepEqual(toks.filter(t => t.k === 'life').map(t => t.s), ["'a", "'a"])
  assert.deepEqual(toks.filter(t => t.k === 'chr').map(t => t.s), ["'x'"])
  assert.ok(toks.some(t => t.k === 'num' && t.s === '10u8'))
  assert.ok(!toks.some(t => t.s === 'c' && t.k === 'id' && t.i < src.indexOf('let')), 'コメントの中の c は読まない')
})

// ============================================================ Go の変異 ============================================================

test('goMutants: 演算子・真偽値・否定・整数リテラル。文字列・コメント・単項・型の * は変異しない', () => {
  const src = `package p

import "fmt"

// a + b は変異しない
func F(a, b int, p *int, s []*int) bool {
	msg := "x" + fmt.Sprint(a)
	n := -a
	m := *p * b
	if !(a < b) && a == 1 || true {
		n += 2
	}
	_ = msg
	_ = n
	_ = m
	return a != 0
}
`
  const ms = goMutants(src)
  const by = n => mut(ms, n).map(m => `${src.slice(m.off, m.end)}→${m.repl}`)
  assert.deepEqual(by('ArithmeticOperator'), ['*→/'], '文字列の + は変異しない。単項の - と型の * も変異しない。*p * b の 2 つ目の * だけ')
  assert.deepEqual(by('EqualityOperator').sort(), ['!=→==', '<→<=', '==→!='].sort())
  assert.deepEqual(by('LogicalOperator').sort(), ['&&→||', '||→&&'].sort())
  assert.deepEqual(by('AssignmentOperator'), ['+=→-='])
  assert.deepEqual(by('BooleanLiteral'), ['true→false'])
  assert.deepEqual(by('UnaryOperator'), ['!→'])
  assert.deepEqual(by('IntegerLiteral').sort(), ['0→1', '1→2', '2→3'].sort())
  // 全部、適用した結果が元と違う
  for (const m of ms) assert.notEqual(applyMutant(src, m), src)
})

test('goMutants: x.0 のような添字は無く、浮動小数・16 進・e 表記は整数リテラルの変異にしない', () => {
  const ms = goMutants('package p\nvar a = 1.5\nvar b = 0x10\nvar c = 1e3\nvar d = 007\nvar e = 7\n')
  assert.deepEqual(mut(ms, 'IntegerLiteral').map(m => m.repl), ['8'])
})

test('describeMutant: location は行全体（1 始まり）、replacement は置換後のその行の全文', () => {
  const src = 'package p\n\nfunc Add(a, b int) int {\n\treturn a + b // 和\n}\n'
  const m = goMutants(src).find(x => x.mutatorName === 'ArithmeticOperator')
  const d = describeMutant(src, m)
  assert.equal(d.line, 4)
  assert.equal(d.replacement, 'return a - b // 和')
  assert.deepEqual(d.location, { start: { line: 4, column: 2 }, end: { line: 4, column: 'return a + b // 和'.length + 2 } })
  assert.equal(d.code, 'return a + b // 和')
  assert.equal(applyMutant(src, m), 'package p\n\nfunc Add(a, b int) int {\n\treturn a - b // 和\n}\n')
  // CRLF でも行末の \r を replacement に入れない
  const crlf = src.replace(/\n/g, '\r\n'), m2 = goMutants(crlf).find(x => x.mutatorName === 'ArithmeticOperator')
  assert.equal(describeMutant(crlf, m2).replacement, 'return a - b // 和')
})

test('describeMutant: ! を外す変異の replacement は ! の無い行', () => {
  const src = 'package p\nfunc F(ok bool) bool {\n\tif !ok {\n\t\treturn true\n\t}\n\treturn false\n}\n'
  const m = goMutants(src).find(x => x.mutatorName === 'UnaryOperator')
  assert.equal(describeMutant(src, m).replacement, 'if ok {')
})

// ============================================================ Rust の変異 ============================================================

test('rustScan: cfg(test) の mod・#[test] の関数・属性・macro_rules の中は変異しない。試験関数と範囲を拾う', () => {
  const src = `pub fn add(a: i32, b: i32) -> i32 {
    a + b
}

#[derive(Debug, PartialEq)]
pub struct P { x: i32 }

macro_rules! m {
    ($a:expr) => { $a + 1 };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn t1() {
        assert_eq!(add(1, 2), 3);
        assert!(1 < 2);
    }

    mod inner {
        #[test]
        fn t2() { assert!(true); }
    }
}

#[test]
fn outside() { assert!(1 + 1 == 2); }
`
  const sc = rustScan(src)
  assert.deepEqual(sc.mutants.map(m => `${m.mutatorName}:${src.slice(m.off, m.end)}→${m.repl}`), ['ArithmeticOperator:+→-'])
  assert.deepEqual(sc.testFns.map(t => `${t.modPath.join('::')}|${t.name}`), ['tests|t1', 'tests::inner|t2', '|outside'])
  const covered = line => sc.regions.some(r => line >= r.start && line <= r.end)
  assert.ok(covered(14) && covered(18) && covered(24) && covered(29), '試験コードの行')
  assert.ok(!covered(2) && !covered(6), '製品コードの行')
})

test('rustScan: 総称の < > は比較として変異しない。比較は変異する', () => {
  const src = `use std::collections::HashMap;
pub fn f<T: Clone>(v: Vec<T>, m: HashMap<String, Vec<u8>>, a: usize, b: usize) -> Option<usize> {
    let x: Vec<Vec<u8>> = Vec::new();
    let y = Vec::<u8>::new();
    if a < b && b > a { Some(a) } else { None }
}
`
  const sc = rustScan(src)
  const eq = sc.mutants.filter(m => m.mutatorName === 'EqualityOperator').map(m => `${src.slice(m.off, m.end)}→${m.repl}`)
  assert.deepEqual(eq.sort(), ['<→<=', '>→>='].sort())
})

test('rustScan: ! は単項だけ外す。マクロの ! と != は外さない。単項の - ・ * ・ & は変異しない', () => {
  const src = `pub fn f(ok: bool, v: &[i32], p: &i32) -> i32 {
    assert!(ok);
    if !ok { return -1; }
    let s: i32 = *p * 2;
    if s != 3 { 0 } else { v.len() as i32 - 1 }
}
`
  const sc = rustScan(src)
  const m = n => sc.mutants.filter(x => x.mutatorName === n).map(x => `${src.slice(x.off, x.end)}→${x.repl}`)
  assert.deepEqual(m('UnaryOperator'), ['!→'])
  assert.deepEqual(m('ArithmeticOperator').sort(), ['*→/', '-→+'].sort())
  assert.deepEqual(m('EqualityOperator'), ['!=→=='])
  assert.deepEqual(m('IntegerLiteral').sort(), ['1→2', '1→2', '2→3', '0→1', '3→4'].sort())
})

test('rustScan: #[cfg(test)] mod x; は testModFiles に、整数リテラルは接尾辞を保つ、タプル添字は変異しない', () => {
  const src = '#[cfg(test)]\nmod tests;\npub fn f(t: (u8, u8)) -> u8 { t.0 + 10u8 }\n'
  const sc = rustScan(src)
  assert.deepEqual(sc.testModFiles, ['tests'])
  assert.deepEqual(sc.mutants.filter(m => m.mutatorName === 'IntegerLiteral').map(m => m.repl), ['11u8'])
})

// ============================================================ 標本・glob ============================================================

test('sampleMutants: 同じ seed・同じ列挙なら同じ標本。seed が違えば変わる。0 と全数以上は全部', () => {
  const all = Array.from({ length: 50 }, (_, i) => ({ file: 'a.go', off: i }))
  const a = sampleMutants(all, 10, 'x'), b = sampleMutants(all, 10, 'x'), c = sampleMutants(all, 10, 'y')
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  assert.equal(a.length, 10)
  assert.deepEqual(a.map(m => m.off), [...a.map(m => m.off)].sort((p, q) => p - q), '元の順')
  assert.equal(sampleMutants(all, 0, 'x').length, 50)
  assert.equal(sampleMutants(all, 99, 'x').length, 50)
  const r1 = seededRandom('s'), r2 = seededRandom('s')
  assert.equal(r1(), r2())
})

test('glob: ** と * と ?、ワイルドカード無しは basename・名前の末尾とも比べる', () => {
  assert.ok(globToRegExp('src/**/*.go').test('src/a/b/c.go'))
  assert.ok(globToRegExp('src/**').test('src/a/b.go'))
  assert.ok(!globToRegExp('src/*.go').test('src/a/b.go'))
  assert.ok(globToRegExp('a?.go').test('ab.go'))
  assert.ok(matchesAny(['calc_test.go'], ['pkg/calc_test.go']))
  assert.ok(matchesAny(['TestAdd'], ['example.com/p.TestAdd', 'TestAdd']))
  assert.ok(matchesAny(['tests::slow'], ['prunefix::tests::slow']))
  assert.ok(!matchesAny(['TestAdd'], ['example.com/p.TestAddAgain']))
  assert.ok(!matchesAny([], ['x']))
})

// ============================================================ Go の結果 ============================================================

const ev = o => JSON.stringify(o)
test('parseGoTestJson: 試験・subtest・package・panic・build 失敗・timeout を読む', () => {
  const lines = [
    ev({ Action: 'run', Package: 'p', Test: 'TestA' }),
    ev({ Action: 'output', Package: 'p', Test: 'TestA', Output: '=== RUN   TestA\n' }),
    ev({ Action: 'output', Package: 'p', Test: 'TestA', Output: '    a_test.go:7: Add = -1, want 3\n' }),
    ev({ Action: 'output', Package: 'p', Test: 'TestA', Output: '--- FAIL: TestA (0.00s)\n' }),
    ev({ Action: 'fail', Package: 'p', Test: 'TestA' }),
    ev({ Action: 'pass', Package: 'p', Test: 'TestB' }),
    ev({ Action: 'output', Package: 'p', Output: 'FAIL\tp\t0.01s\n' }),
    ev({ Action: 'fail', Package: 'p' }),
  ].join('\n')
  const r = parseGoTestJson(lines)
  assert.equal(r.tests.get('p\u0000TestA').status, 'fail')
  assert.equal(goFailureText(r.tests.get('p\u0000TestA').output), 'a_test.go:7: Add = -1, want 3')
  assert.equal(r.tests.get('p\u0000TestB').status, 'pass')
  assert.equal(r.pkgs.get('p').status, 'fail')
  assert.equal(r.buildFailed, false); assert.equal(r.timedOut, false)
  assert.equal(parseGoTestJson(ev({ Action: 'output', Package: 'p', Output: 'FAIL\tp [build failed]\n' }) + '\n# p\n./a.go:3:9: undefined: x').buildFailed, true)
  assert.equal(parseGoTestJson(ev({ ImportPath: 'p', Action: 'build-fail' }) + '\n' + ev({ Action: 'output', Package: 'p', FailedBuild: 'p', Output: 'x' })).buildFailed, true)
  assert.equal(parseGoTestJson(ev({ Action: 'output', Package: 'p', Test: 'TestSlow', Output: 'panic: test timed out after 5s\n' })).timedOut, true)
  assert.equal(parseGoTestJson('not json at all\n').stray.length, 1)
})

test('goFailedTests: 子を持つ親は要約だけなら数えない。panic でプロセスごと落ちて run のまま残った試験は、自分の出力に panic が有れば落ちた試験として数える', () => {
  const e = (Action, Test, Output) => ev({ Action, Package: 'p', ...(Test ? { Test } : {}), ...(Output !== undefined ? { Output } : {}) })
  const lines = [
    e('run', 'TestParent'), e('run', 'TestParent/a'), e('output', 'TestParent/a', '    x_test.go:5: bad a\n'), e('output', 'TestParent/a', '--- FAIL: TestParent/a (0.00s)\n'), e('fail', 'TestParent/a'),
    e('output', 'TestParent', '--- FAIL: TestParent (0.00s)\n'), e('fail', 'TestParent'),
    e('run', 'TestOk'), e('pass', 'TestOk'),
    e('run', 'TestCrash'), e('output', 'TestCrash', 'panic: runtime error: invalid memory address or nil pointer dereference\n'),
    e('output', undefined, 'FAIL\tp\t0.01s\n'), e('fail'),
  ].join('\n')
  const g = goFailedTests(parseGoTestJson(lines))
  assert.deepEqual(g.failed.map(f => f.testName).sort(), ['TestCrash', 'TestParent/a'])
  assert.equal(g.failed.find(f => f.testName === 'TestCrash').kind, '前提')
  assert.equal(g.failed.find(f => f.testName === 'TestParent/a').kind, '狙い')
  assert.deepEqual(g.seen.filter(t => t.status === 'pass').map(t => t.testName), ['TestOk'])
  // 途中の試験が複数で、自分の出力に panic が無い物は数えない（別の試験の panic に巻き込まれただけかもしれない）
  const two = [e('run', 'TestA'), e('run', 'TestB'), e('output', 'TestB', 'panic: boom\n'), e('output', undefined, 'FAIL\tp\t0.01s\n'), e('fail')].join('\n')
  assert.deepEqual(goFailedTests(parseGoTestJson(two)).failed.map(f => f.testName), ['TestB'])
  // package が落ちていなければ run のままでも数えない
  assert.deepEqual(goFailedTests(parseGoTestJson(e('run', 'TestA'))).failed, [])
})

test('classifyGoFailure: 試験本文の t.Error・testify は狙い、panic・製品側の行・記録なしは前提', () => {
  assert.equal(classifyGoFailure('calc_test.go:12: Add = -1, want 3'), '狙い')
  assert.equal(classifyGoFailure('    calc_test.go:12:5: bad\n    calc_test.go:13: worse'), '狙い')
  assert.equal(classifyGoFailure('        \tError Trace:\t/tmp/x/calc_test.go:12\n        \tError:      \tNot equal:'), '狙い')
  assert.equal(classifyGoFailure('panic: runtime error: integer divide by zero [recovered]\ngoroutine 6 [running]:\ncalc_test.go:38'), '前提')
  assert.equal(classifyGoFailure('calc.go:28: unexpected state'), '前提')
  assert.equal(classifyGoFailure('calc_test.go:9: msg\npanic: boom'), '前提')
  assert.equal(classifyGoFailure(''), '前提')
  assert.equal(classifyGoFailure('fatal error: all goroutines are asleep - deadlock!'), '前提')
})

// ============================================================ Rust の結果 ============================================================

const CARGO_OUT = `   Compiling prunefix v0.1.0 (/tmp/w0)
    Finished \`test\` profile [unoptimized + debuginfo] target(s) in 0.5s
     Running unittests src/lib.rs (target/debug/deps/prunefix-1a2b3c4d5e6f7a8b)

running 3 tests
test tests::add_works ... FAILED
test tests::positive ... ok
test tests::slow ... ignored

failures:

---- tests::add_works stdout ----

thread 'tests::add_works' panicked at src/lib.rs:49:9:
assertion \`left == right\` failed
  left: -1
 right: 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::add_works

test result: FAILED. 1 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: test failed, to rerun pass \`--lib\`
     Running tests/api.rs (target/debug/deps/api-9f8e7d6c5b4a3210)

running 1 test
test first_unwraps ... FAILED

failures:

---- first_unwraps stdout ----

thread 'first_unwraps' panicked at tests/api.rs:12:5:
called \`Option::unwrap()\` on a \`None\` value

failures:
    first_unwraps

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

error: 2 targets failed:
    \`--lib\`
    \`--test api\`
   Doc-tests prunefix
`
test('parseCargoTest: target ごとの試験と、失敗の本文（panic の位置・書式の新旧）を読む', () => {
  const r = parseCargoTest(CARGO_OUT)
  assert.deepEqual(r.sections.map(s => `${s.target}|${s.header}`), ['prunefix|unittests src/lib.rs', 'api|tests/api.rs'])
  const lib = r.sections[0]
  assert.equal(lib.tests.get('tests::add_works').status, 'fail')
  assert.equal(lib.tests.get('tests::positive').status, 'pass')
  assert.equal(lib.tests.get('tests::slow').status, 'skip')
  assert.match(lib.tests.get('tests::add_works').output.join('\n'), /assertion `left == right` failed/)
  assert.equal(r.compileError, false)
  assert.equal(parseCargoTest('error[E0308]: mismatched types\nerror: could not compile `prunefix` (lib test) due to 1 previous error').compileError, true)
  assert.deepEqual(rustPanic("thread 'x' panicked at src/lib.rs:49:9:\nassertion failed: x > 0\nnote: run with"), { file: 'src/lib.rs', line: 49, message: 'assertion failed: x > 0' })
  assert.deepEqual(rustPanic("thread 'x' panicked at 'assertion failed: x', src/lib.rs:7:5"), { file: 'src/lib.rs', line: 7, message: 'assertion failed: x' })
  assert.equal(rustPanic('no panic here'), null)
})

test('classifyRustFailure: 試験コードでの assert は狙い。unwrap・添字・製品側の panic・位置なしは前提', () => {
  const isTest = (f, l) => f.startsWith('tests/') || (f === 'src/lib.rs' && l >= 40)
  const at = (file, line, msg) => `thread 't' panicked at ${file}:${line}:5:\n${msg}\n`
  assert.equal(classifyRustFailure(at('src/lib.rs', 49, 'assertion `left == right` failed\n  left: 1\n right: 2'), isTest), '狙い')
  assert.equal(classifyRustFailure(at('tests/api.rs', 5, 'assertion failed: ok'), isTest), '狙い')
  assert.equal(classifyRustFailure(at('tests/api.rs', 12, 'called `Option::unwrap()` on a `None` value'), isTest), '前提')
  assert.equal(classifyRustFailure(at('tests/api.rs', 12, 'index out of bounds: the len is 1 but the index is 1'), isTest), '前提')
  assert.equal(classifyRustFailure(at('src/lib.rs', 20, 'attempt to divide by zero'), isTest), '前提', '製品コードの panic')
  assert.equal(classifyRustFailure(at('src/lib.rs', 20, 'assertion failed: x'), isTest), '前提', '製品コードの assert')
  assert.equal(classifyRustFailure(at('/rustc/abc/library/core/src/option.rs', 10, 'assertion failed'), isTest), '前提')
  assert.equal(classifyRustFailure(at('tests/api.rs', 3, 'unexpected variant'), isTest), '狙い', '試験本文の panic!')
  assert.equal(classifyRustFailure('', isTest), '前提')
})

// ============================================================ 判定 ============================================================

test('judgeRun: Killed は落ちた試験を全部、除外した試験・下見で落ちる試験は数えない、時間切れ・build 失敗・道具の異常終了を分ける', () => {
  const f = (id, kind = '狙い') => ({ id, name: id, error: 'e', kind })
  const run = (o = {}) => ({ timedOut: false, compileError: false, failed: [], exitCode: 0, ...o })
  assert.deepEqual(judgeRun(run({ failed: [f('a'), f('b')], exitCode: 1 })).killedBy, ['a', 'b'])
  assert.equal(judgeRun(run({ failed: [f('a'), f('b')], exitCode: 1 })).status, 'Killed')
  const ex = judgeRun(run({ failed: [f('a'), f('b')], exitCode: 1 }), { excludedTest: x => x.id === 'a' })
  assert.deepEqual(ex.killedBy, ['b'])
  assert.equal(judgeRun(run({ failed: [f('a')], exitCode: 1 }), { excludedTest: () => true }).status, 'Survived')
  assert.equal(judgeRun(run({ failed: [f('base')], exitCode: 1 }), { baselineFailed: new Set(['base']) }).status, 'Survived')
  assert.equal(judgeRun(run()).status, 'Survived')
  assert.equal(judgeRun(run({ timedOut: true, failed: [f('a')] })).status, 'Timeout')
  assert.deepEqual(judgeRun(run({ timedOut: true })).killedBy, [])
  assert.equal(judgeRun(run({ compileError: true, exitCode: 1 })).status, 'CompileError')
  assert.equal(judgeRun(run({ exitCode: 2 })).status, 'RuntimeError')
})

// ============================================================ 検出・名前・go.work ============================================================

test('detect・name・languageOf: go.mod / go.work / Cargo.toml を見て分ける', async () => {
  const g = tmp('tg-rg-g-'), r = tmp('tg-rg-r-'), e = tmp('tg-rg-e-'), w = tmp('tg-rg-w-')
  writeFileSync(path.join(g, 'go.mod'), 'module example.com/foo/bar\n\ngo 1.21\n')
  writeFileSync(path.join(r, 'Cargo.toml'), '[workspace]\nmembers=["a"]\n\n[package]\nname = "my-crate"\nversion = "0.1.0"\n')
  writeFileSync(path.join(w, 'go.work'), 'go 1.21\n\nuse (\n\t./a\n\t./b // x\n)\nuse ./c\n')
  assert.equal(id, 'rustgo'); assert.deepEqual(runners, ['cargo test', 'go test'])
  assert.equal(await detect(g), true); assert.equal(await detect(r), true); assert.equal(await detect(w), true); assert.equal(await detect(e), false)
  assert.equal(await name(g), 'example.com/foo/bar'); assert.equal(await name(r), 'my-crate'); assert.equal(await name(e), path.basename(e))
  assert.equal(languageOf(g), 'go'); assert.equal(languageOf(r), 'cargo'); assert.equal(languageOf(e), null)
  assert.equal(languageOf(g, 'cargo'), 'cargo'); assert.equal(languageOf(r, 'go'), 'go')
  writeFileSync(path.join(g, 'Cargo.toml'), '[package]\nname="x"\n')
  assert.equal(languageOf(g), 'go', '両方ある時は go（runner が渡されればそれ）')
  assert.deepEqual(goPatterns(g), ['./...'])
  assert.deepEqual(goPatterns(w), ['./a/...', './b/...', './c/...'])
})

test('道具の無い cwd・go.mod も Cargo.toml も無い cwd は status 2 で mutation.json を書かない', async () => {
  const dir = tmp('tg-rg-none-'), runDir = tmp('tg-rg-run-')
  const logs = []
  const r = await prune({ cwd: dir, runDir, logFile: path.join(runDir, 'prune.log'), sample: 5, seed: 's', mutate: [], tests: [], exclude: [], timeoutMs: 1000, env: process.env, log: m => logs.push(m) })
  assert.equal(r.status, 2)
  assert.equal(existsSync(path.join(runDir, 'mutation.json')), false)
})

// ============================================================ 実物（道具がある環境だけ） ============================================================

const leftovers = () => readdirSync(tmpdir()).filter(n => n.startsWith('tg-prune-rustgo-')).length
function fixtureCopy(name) {
  const dir = tmp('tg-rg-fix-')
  cpSync(path.join(FIX, name), dir, { recursive: true, filter: p => !/[\\/]target([\\/]|$)|Cargo\.lock$/.test(p) })
  return dir
}
async function runAdapter(cwd, extra = {}) {
  const runDir = tmp('tg-rg-run-'), logs = []
  const before = leftovers()
  const r = await prune({ cwd, runDir, logFile: path.join(runDir, 'prune.log'), sample: 0, seed: 'fixture', mutate: [], tests: [], exclude: [], timeoutMs: 60000, env: process.env, log: m => logs.push(m), ...extra })
  assert.equal(leftovers(), before, '作業の写し（tg-prune-rustgo-*）を残さない')
  return { r, runDir, logs, report: JSON.parse(readFileSync(path.join(runDir, 'mutation.json'), 'utf8')), failures: readFailures(path.join(runDir, 'failures.jsonl')) }
}
const allMutants = report => Object.entries(report.files).flatMap(([file, v]) => v.mutants.map(m => ({ file, ...m })))

test('Go の実物: killedBy が試験ごと（落ちた試験を全部）、kind は狙いと前提の両方、panic の後の試験も落ちた物は拾う', { skip: HAS_GO ? false : 'go が無い' }, async () => {
  const cwd = fixtureCopy('prune-go')
  const { r, report, failures, runDir } = await runAdapter(cwd)
  assert.equal(r.status, 0); assert.equal(r.runner, 'go test')
  assert.equal(r.sampled.total, r.sampled.sampled); assert.ok(r.sampled.total >= 15)
  assert.deepEqual(r.dryRunExcluded, [])
  assert.equal(report.schemaVersion, '1')
  const ms = allMutants(report)
  assert.ok(ms.every(m => /^\d+$/.test(m.id)) && new Set(ms.map(m => m.id)).size === ms.length, 'id はこの回の中で一意な文字列')
  assert.ok(ms.some(m => m.status === 'Killed') && ms.some(m => m.status === 'Survived'))
  // Add の + → - は、同じ変異を TestAdd と TestAddAgain の両方が殺す
  const add = ms.find(m => m.file === 'calc.go' && m.replacement === 'return a - b')
  assert.deepEqual(add.killedBy, ['example.com/prunefix.TestAdd', 'example.com/prunefix.TestAddAgain'])
  assert.equal(add.replacement, 'return a - b'); assert.equal(add.location.start.line, 5)
  // Mean の空判定: panic する TestMeanEmpty の後に走る TestMean も、落ちたなら killedBy に入る
  const mean = ms.find(m => m.file === 'calc.go' && m.replacement === 'if len(xs) != 0 {')
  assert.deepEqual([...mean.killedBy].sort(), ['example.com/prunefix.TestMean', 'example.com/prunefix.TestMeanEmpty'])
  // 別の goroutine の panic でプロセスごと落ちた変異も、走っていた試験の kill として拾う（RuntimeError にしない）。後ろの試験は流し直して集める
  const run = ms.find(m => m.file === 'run.go' && m.replacement === 'if fn != nil {')
  assert.equal(run.status, 'Killed'); assert.deepEqual(run.killedBy, ['example.com/prunefix.TestRun'])
  assert.equal(failures.find(f => f.mutant === run.id).kind, '前提')
  assert.ok(!ms.some(m => m.status === 'RuntimeError'), ms.filter(m => m.status === 'RuntimeError').map(m => m.replacement).join(' / '))
  const kind = (mutant, test) => failures.find(f => f.mutant === mutant && f.test === test)?.kind
  assert.equal(kind(mean.id, 'example.com/prunefix.TestMeanEmpty'), '前提', '製品側の 0 除算 panic')
  assert.equal(kind(mean.id, 'example.com/prunefix.TestMean'), '狙い', '試験本文の t.Errorf')
  assert.equal(kind(add.id, 'example.com/prunefix.TestAdd'), '狙い')
  assert.ok(new Set(failures.map(f => f.kind)).size === 2, '狙いと前提の両方が出る')
  // 失敗文に作業の写しの絶対 path を残さない
  assert.ok(failures.every(f => !f.error.includes('tg-prune-rustgo-')))
  assert.ok(failures.every(f => f.error.length <= 4000))
  // subtest は leaf の id（親の要約は数えない）
  const clamp = ms.flatMap(m => m.killedBy).filter(x => x.includes('TestClamp'))
  assert.ok(clamp.every(x => x.includes('TestClamp/')), `親の TestClamp は killedBy に入れない: ${clamp}`)
  // testFiles: 試験の id・ファイル・行
  const tests = report.testFiles['calc_test.go'].tests
  assert.ok(tests.some(t => t.id === 'example.com/prunefix.TestAdd' && t.location.start.line === 5))
  assert.ok(tests.every(t => !/TestClamp$/.test(t.id)), '子を持つ親は試験の一覧に入れない')
  // project.json / prune.log
  const pj = JSON.parse(readFileSync(path.join(runDir, 'project.json'), 'utf8'))
  assert.equal(pj.runner, 'go test'); assert.ok(pj.mutateFiles.includes('calc.go'))
  assert.ok(readFileSync(path.join(runDir, 'prune.log'), 'utf8').includes('# 下見'))
  // 本体の集計に通る: 冗長・検出0 が試験から決まる
  const a = analyzeReport(report, { failures, cwd })
  assert.equal(a.tests, Object.values(report.testFiles).flatMap(v => v.tests).length)
  assert.ok(a.killKinds.狙い > 0 && a.killKinds.前提 > 0)
  assert.ok(a.candidates.some(c => c.test.name === 'example.com/prunefix.TestAddAgain' || c.test.name === 'example.com/prunefix.TestAdd'), '同じ変異を狙いで殺す 2 本のうち 1 本は冗長の候補')
})

test('Go の実物: 同じ seed・同じ commit なら同じ標本。--mutate で範囲を絞る。--exclude の試験は数えない', { skip: HAS_GO ? false : 'go が無い' }, async () => {
  const cwd = fixtureCopy('prune-go')
  const a = await runAdapter(cwd, { sample: 6, seed: 'k1' }), b = await runAdapter(cwd, { sample: 6, seed: 'k1' })
  const sig = x => allMutants(x.report).map(m => `${m.file}:${m.location.start.line}:${m.replacement}`)
  assert.deepEqual(sig(a), sig(b)); assert.equal(sig(a).length, 6)
  assert.equal(a.r.sampled.sampled, 6); assert.ok(a.r.sampled.total > 6)
  const only = await runAdapter(cwd, { mutate: ['stats.go'] })
  assert.deepEqual(Object.keys(only.report.files), ['stats.go'])
  const ex = await runAdapter(cwd, { exclude: ['TestAddAgain'] })
  const all = Object.values(ex.report.testFiles).flatMap(v => v.tests).map(t => t.id)
  assert.ok(!all.includes('example.com/prunefix.TestAddAgain'))
  assert.ok(ex.failures.every(f => f.test !== 'example.com/prunefix.TestAddAgain'))
  assert.ok(ex.r.excluded.length >= 1)
  const tg = await runAdapter(cwd, { tests: ['calc_test.go'] })
  assert.ok(Object.values(tg.report.testFiles).flatMap(v => v.tests).length > 0)
})

test('Go の実物: 変異で build が落ちた物は CompileError、下見で落ちる試験は除外、元のファイルは書き戻される', { skip: HAS_GO ? false : 'go が無い' }, async () => {
  const cwd = fixtureCopy('prune-go')
  writeFileSync(path.join(cwd, 'stats.go'), readFileSync(path.join(cwd, 'stats.go'), 'utf8') + '\nfunc Concat(a, b string) string {\n\tx := 1 + 1\n\t_ = x\n\treturn a + b\n}\n')
  writeFileSync(path.join(cwd, 'broken_test.go'), 'package prunefix\n\nimport "testing"\n\nfunc TestAlwaysFails(t *testing.T) { t.Error("baseline failure") }\n')
  const { r, report } = await runAdapter(cwd)
  assert.deepEqual(r.dryRunExcluded, ['example.com/prunefix.TestAlwaysFails'])
  const ms = allMutants(report)
  assert.ok(ms.every(m => !m.killedBy.includes('example.com/prunefix.TestAlwaysFails')))
  assert.ok(!Object.values(report.testFiles).flatMap(v => v.tests).some(t => t.id.endsWith('TestAlwaysFails')))
  assert.ok(ms.every(m => ['Killed', 'Survived', 'Timeout', 'CompileError', 'RuntimeError'].includes(m.status)))
  const src = readFileSync(path.join(cwd, 'calc.go'), 'utf8')
  assert.equal(src, readFileSync(path.join(FIX, 'prune-go', 'calc.go'), 'utf8'), '元のファイルは変えない')
})

test('Go の実物: 無限ループになる変異は Timeout で止まり、killedBy は空', { skip: HAS_GO ? false : 'go が無い' }, async () => {
  const cwd = tmp('tg-rg-loop-')
  writeFileSync(path.join(cwd, 'go.mod'), 'module example.com/loop\n\ngo 1.21\n')
  writeFileSync(path.join(cwd, 'loop.go'), 'package loop\n\nfunc Sum(n int) int {\n\ts := 0\n\tfor i := 0; i < n; i++ {\n\t\ts += i\n\t}\n\treturn s\n}\n')
  writeFileSync(path.join(cwd, 'loop_test.go'), 'package loop\n\nimport "testing"\n\nfunc TestSum(t *testing.T) {\n\tif Sum(4) != 6 {\n\t\tt.Error("Sum(4)")\n\t}\n}\nfunc TestSumZero(t *testing.T) {\n\tif Sum(0) != 0 {\n\t\tt.Error("Sum(0)")\n\t}\n}\n')
  const t0 = Date.now()
  const { report, r } = await runAdapter(cwd, { timeoutMs: 15000 })
  const loop = allMutants(report).find(m => m.replacement === 'for i := 0; i < n; i-- {')
  assert.equal(loop.status, 'Timeout'); assert.deepEqual(loop.killedBy, [])
  assert.ok(r.sampled.total >= 3)
  assert.ok(Date.now() - t0 < 60000, '上限を毎回いっぱい待たない')
})

test('Rust の実物: 単体試験と tests/ の統合試験の id・場所、狙い（assert）と前提（unwrap の None）の kind、killedBy が試験ごと', { skip: HAS_CARGO ? false : 'cargo が無い' }, async () => {
  const cwd = fixtureCopy('prune-rust')
  const { r, report, failures } = await runAdapter(cwd)
  assert.equal(r.status, 0); assert.equal(r.runner, 'cargo test')
  const ms = allMutants(report)
  assert.deepEqual(Object.keys(report.files), ['src/lib.rs'], 'tests/ と cfg(test) の中は変異しない')
  assert.ok(!ms.some(m => m.location.start.line >= 45), '#[cfg(test)] mod tests の行（45 行以降）に変異は無い')
  assert.ok(ms.some(m => m.status === 'Killed') && ms.some(m => m.status === 'Survived'))
  const add = ms.find(m => m.replacement === 'a - b')
  assert.deepEqual([...add.killedBy].sort(), ['api::adds_in_integration', 'prunefix::tests::add_again', 'prunefix::tests::add_works'])
  const tf = report.testFiles
  assert.ok(tf['src/lib.rs'].tests.some(t => t.id === 'prunefix::tests::add_works' && t.location.start.line > 40))
  assert.ok(tf['tests/api.rs'].tests.some(t => t.id === 'api::first_unwraps'))
  // `if !xs.is_empty()` の ! を外すと first が None を返し、統合試験の unwrap が panic する → 前提
  const bang = ms.find(m => m.mutatorName === 'UnaryOperator')
  assert.deepEqual(bang.killedBy, ['api::first_unwraps'])
  assert.equal(failures.find(f => f.mutant === bang.id).kind, '前提')
  assert.equal(failures.find(f => f.mutant === add.id && f.test === 'prunefix::tests::add_works').kind, '狙い')
  assert.equal(failures.find(f => f.mutant === add.id && f.test === 'api::adds_in_integration').kind, '狙い')
  assert.ok(failures.every(f => !f.error.includes('tg-prune-rustgo-')))
  const a = analyzeReport(report, { failures, cwd })
  assert.ok(a.killKinds.狙い > 0 && a.killKinds.前提 > 0)
})

test('本体の testgate prune --runner go で候補（candidates.txt）まで出る', { skip: HAS_GO ? false : 'go が無い' }, async () => {
  const cwd = fixtureCopy('prune-go'), state = tmp('tg-rg-state-')
  const logs = [], outs = []
  const before = leftovers()
  const code = await runPrune({ cwd, runner: 'go', adapters: { go: PRUNE, cargo: PRUNE }, sample: 0, seed: 'fx', env: { ...process.env, XDG_STATE_HOME: state }, log: m => logs.push(m), stdout: s => outs.push(s) })
  assert.equal(code, 0, logs.join('\n'))
  const nameDir = path.join(state, 'testgate', 'prune', 'example.com_prunefix')
  const run = path.join(nameDir, readdirSync(nameDir).sort().at(-1))
  for (const f of ['mutation.json', 'failures.jsonl', 'project.json', 'candidates.json', 'candidates.txt', 'prune.log']) assert.ok(existsSync(path.join(run, f)), f)
  const txt = readFileSync(path.join(run, 'candidates.txt'), 'utf8')
  assert.match(txt, /TestAddAgain|TestAdd/)
  assert.match(txt, /自前の字句ベース変異/)
  const c = JSON.parse(readFileSync(path.join(run, 'candidates.json'), 'utf8'))
  assert.equal(c.runner, 'go test'); assert.ok(c.stat.killed > 0); assert.ok(c.killKinds.前提 > 0)
  assert.equal(leftovers(), before)
})
