import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as adapter from '../adapter.mjs'
import { tmp } from '../../../test/tmp.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = path.join(here, '..', 'fixtures')
const env = process.env
const has = (cmd) => spawnSync(cmd, ['--version'], { env }).status === 0 || spawnSync(cmd, ['version'], { env }).status === 0
const HAS_CARGO = has('cargo')
const HAS_GO = has('go')
const skipCargo = HAS_CARGO ? false : 'cargo が無い'
const skipGo = HAS_GO ? false : 'go が無い'

function repo(name) {
  const dir = tmp('tg-rustgo-')
  cpSync(path.join(fx, name), dir, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}
const sel = (dir, argv, changed, extra = {}) =>
  adapter.select({ argv, cwd: dir, env, changed, base: null, full: false, ...extra })
const sample = (n) => readFileSync(path.join(fx, 'samples', n), 'utf8')

test('契約の形', () => {
  assert.equal(adapter.id, 'rustgo')
  assert.match(adapter.id, /^[a-z]+$/)
  assert.deepEqual(adapter.runners, ['cargo test', 'go test'])
})

test('detect: ランナーだけ true', () => {
  const t = (a) => adapter.detect(a, { cwd: '.', env })
  for (const a of [
    ['cargo', 'test'], ['cargo', 'test', '--workspace'], ['cargo', '+nightly', 'test'], ['cargo', 't'],
    ['go', 'test', './...'], ['go', 'test'], ['rtk', 'cargo', 'test'], ['rtk', 'go', 'test', './...'],
    ['RUST_LOG=debug', 'cargo', 'test', '--', '--nocapture'], ['/usr/local/go/bin/go', 'test', '-v', './core'],
  ]) assert.equal(t(a), true, a.join(' '))
  for (const a of [
    ['ls'], ['pytest', '--version'], ['cargo', 'build'], ['cargo', 'test', '--help'], ['cargo', 'test', '--', '--list'],
    ['cargo', 'nextest', 'run'], ['go', 'build', './...'], ['go', 'version'], ['go', 'test', '-list', '.'],
    ['go', 'test', '-c'], ['go', 'vet', './...'], ['gotestsum'], [],
  ]) assert.equal(t(a), false, a.join(' '))
})

test('cargo: 1crate変更 → subset。依存先を含み、独立crateを含まない。実際に流せる', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  const ws = path.join(dir)
  const r = await sel(ws, ['cargo', 'test'], ['core/src/lib.rs'])
  assert.equal(r.mode, 'subset')
  assert.match(r.reason, /^cargo test: /)
  const pk = r.argv.filter((_, i) => r.argv[i - 1] === '-p')
  assert.deepEqual(pk.sort(), ['app', 'fxcore', 'util'])
  assert.ok(!pk.includes('indep'))
  const out = spawnSync(r.argv[0], r.argv.slice(1), { cwd: ws, env, encoding: 'utf8' })
  assert.equal(out.status, 0)
  const text = out.stdout + out.stderr
  assert.ok(!/indep-/.test(text) && !/Doc-tests indep/.test(text))
  assert.ok(/fxcore-/.test(text))
  rmSync(dir, { recursive: true })
})

test('cargo: 単一crateのrepoは full で、reasonに選択手段が無い旨を書く', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  const r = await sel(path.join(dir, 'indep'), ['cargo', 'test'], ['indep/src/lib.rs'])
  assert.equal(r.mode, 'full')
  assert.match(r.reason, /単一crateのためcrate内の選択手段が無い/)
  const w = await sel(dir, ['cargo', 'test', '--workspace'], ['indep/src/lib.rs', 'core/src/lib.rs', 'util/src/lib.rs', 'app/src/lib.rs'])
  assert.match(w.reason, /選べたが全部/)
  rmSync(dir, { recursive: true })
})

test('cargo: 末端crateだけの変更・後ろの引数は残る', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  const r = await sel(dir, ['cargo', 'test', '--release', '--', '--nocapture'], ['app/src/lib.rs'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['cargo', 'test', '-p', 'app', '--release', '--', '--nocapture'])
  rmSync(dir, { recursive: true })
})

test('cargo: --workspace は選択で置き換わる', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  const r = await sel(dir, ['cargo', 'test', '--workspace', '--exclude', 'util'], ['indep/src/lib.rs'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['cargo', 'test', '-p', 'indep'])
  rmSync(dir, { recursive: true })
})

test('cargo: 変更なし → none / full:true → 元のargv', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  const none = await sel(dir, ['cargo', 'test'], [])
  assert.equal(none.mode, 'none')
  const argv = ['cargo', 'test', '--workspace']
  const f = await sel(dir, argv, ['core/src/lib.rs'], { full: true })
  assert.deepEqual(f.argv, argv)
  assert.equal(f.mode, 'full')
  rmSync(dir, { recursive: true })
})

test('cargo: 属さないファイルだけ → none、全体に効くファイル・crateごと消えた → full', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  assert.equal((await sel(dir, ['cargo', 'test'], ['README.md', 'docs/a.md'])).mode, 'none')
  for (const f of ['Cargo.lock', 'Cargo.toml', 'rust-toolchain.toml', '.cargo/config.toml']) {
    const r = await sel(dir, ['cargo', 'test'], [f])
    assert.equal(r.mode, 'full', f)
    assert.deepEqual(r.argv, ['cargo', 'test'])
  }
  const gone = await sel(dir, ['cargo', 'test'], ['old/src/lib.rs', 'old/Cargo.toml'])
  assert.equal(gone.mode, 'full')
  rmSync(dir, { recursive: true })
})

test('cargo: 人が絞っていれば passthrough', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  for (const a of [
    ['cargo', 'test', '-p', 'util'], ['cargo', 'test', '--package=util'], ['cargo', 'test', 'adds'],
    ['cargo', 'test', '--test', 'integ'], ['cargo', 'test', '-pindep'],
  ]) {
    const r = await sel(dir, a, ['core/src/lib.rs'])
    assert.equal(r.mode, 'passthrough', a.join(' '))
    assert.deepEqual(r.argv, a)
  }
  rmSync(dir, { recursive: true })
})

test('cargo: crateの中で打つと、そのcrateの範囲だけを見る', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  const inUtil = path.join(dir, 'util')
  const a = await sel(inUtil, ['cargo', 'test'], ['indep/src/lib.rs'])
  assert.equal(a.mode, 'none')
  const b = await sel(inUtil, ['cargo', 'test'], ['core/src/lib.rs'])
  assert.deepEqual(b.argv, ['cargo', 'test'])
  rmSync(dir, { recursive: true })
})

test('cargo: metadata が取れない（壊れた manifest）→ full', { skip: skipCargo }, async () => {
  const dir = repo('rust-ws')
  writeFileSync(path.join(dir, 'util', 'Cargo.toml'), 'this is = not [toml')
  const r = await sel(dir, ['cargo', 'test'], ['core/src/lib.rs'])
  assert.equal(r.mode, 'full')
  assert.deepEqual(r.argv, ['cargo', 'test'])
  rmSync(dir, { recursive: true })
})

test('cargo が無い環境では passthrough', async () => {
  const dir = repo('rust-ws')
  const r = await sel(dir, ['cargo', 'test'], ['core/src/lib.rs'], { env: { PATH: '/nonexistent' } })
  assert.equal(r.mode, 'passthrough')
  assert.match(r.reason, /見つからない/)
  rmSync(dir, { recursive: true })
})

// go の初回は cache が冷えていて go list だけで依存解決の上限（4.5 秒）に掛かる事がある（fox の v0.3.8 で 4.97 秒 → passthrough）。
// 試験が測るのはアダプタの判断なので、先に一度 go list を流して温めておく。
if (HAS_GO) { const d = repo('go-mod'); spawnSync('go', ['list', './...'], { cwd: d, env }); rmSync(d, { recursive: true }) }

test('go: 1package変更 → subset。importする側を含み、独立packageを含まない。実際に流せる', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  const r = await sel(dir, ['go', 'test', './...'], ['core/core.go'])
  assert.equal(r.mode, 'subset')
  assert.match(r.reason, /^go test: /)
  assert.deepEqual(r.argv.slice(0, 2), ['go', 'test'])
  const pk = r.argv.slice(2).sort()
  assert.deepEqual(pk, ['example.com/fx/app', 'example.com/fx/core', 'example.com/fx/util'])
  const out = spawnSync(r.argv[0], r.argv.slice(1), { cwd: dir, env, encoding: 'utf8' })
  assert.equal(out.status, 0)
  assert.ok(!/indep/.test(out.stdout))
  rmSync(dir, { recursive: true })
})

test('go: 末端の変更・テストファイルの変更・後ろの引数は残る', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  const r = await sel(dir, ['go', 'test', '-v', '-count=1', './...'], ['indep/indep_test.go'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['go', 'test', 'example.com/fx/indep', '-v', '-count=1'])
  const r2 = await sel(dir, ['go', 'test', './...', '-args', '-x'], ['app/app.go'])
  assert.deepEqual(r2.argv, ['go', 'test', 'example.com/fx/app', '-args', '-x'])
  rmSync(dir, { recursive: true })
})

test('go: 変更なし → none / full:true → 元のargv / READMEだけ → none', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  assert.equal((await sel(dir, ['go', 'test', './...'], [])).mode, 'none')
  assert.equal((await sel(dir, ['go', 'test', './...'], ['README.md'])).mode, 'none')
  const argv = ['go', 'test', './...']
  const f = await sel(dir, argv, ['core/core.go'], { full: true })
  assert.deepEqual(f.argv, argv)
  assert.equal(f.mode, 'full')
  rmSync(dir, { recursive: true })
})

test('go: go.mod・go.work は全体へ効く', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  for (const f of ['go.mod', 'go.work']) {
    const r = await sel(dir, ['go', 'test', './...'], [f])
    assert.equal(r.mode, 'full', f)
    assert.deepEqual(r.argv, ['go', 'test', './...'])
  }
  rmSync(dir, { recursive: true })
})

test('go: -run・明示package・ファイル指定は passthrough', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  for (const a of [
    ['go', 'test', '-run', 'TestAdd', './...'], ['go', 'test', './core'], ['go', 'test', 'example.com/fx/core'],
    ['go', 'test', './core/core_test.go'], ['go', 'test', './core/...'], ['go', 'test', '-skip=Neg', './...'],
  ]) {
    const r = await sel(dir, a, ['core/core.go'])
    assert.equal(r.mode, 'passthrough', a.join(' '))
    assert.deepEqual(r.argv, a)
  }
  rmSync(dir, { recursive: true })
})

test('go: 引数なしはカレントpackageだけを範囲にする', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  const a = await sel(path.join(dir, 'indep'), ['go', 'test'], ['core/core.go'])
  assert.equal(a.mode, 'none')
  const b = await sel(path.join(dir, 'util'), ['go', 'test'], ['core/core.go'])
  assert.deepEqual(b.argv, ['go', 'test'])
  rmSync(dir, { recursive: true })
})

test('go: testdata・embed したファイルの変更も属するpackageを選ぶ', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  mkdirSync(path.join(dir, 'indep', 'testdata'))
  writeFileSync(path.join(dir, 'indep', 'testdata', 'x.txt'), 'x')
  const r = await sel(dir, ['go', 'test', './...'], ['indep/testdata/x.txt'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['go', 'test', 'example.com/fx/indep'])
  rmSync(dir, { recursive: true })
})

test('go: 消えたpackage → それをimportしていた側を選ぶ', { skip: skipGo }, async () => {
  const dir = repo('go-mod')
  rmSync(path.join(dir, 'util'), { recursive: true })
  const r = await sel(dir, ['go', 'test', './...'], ['util/util.go', 'util/util_test.go'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['go', 'test', 'example.com/fx/app'])
  rmSync(dir, { recursive: true })
})

test('go: go.work の複数モジュール。別モジュールの依存側も選ぶ', { skip: skipGo }, async () => {
  const dir = tmp('tg-gowork-')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const w = (f, s) => { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), s) }
  w('go.work', 'go 1.21\n\nuse (\n\t./liba\n\t./libb\n\t./libc\n)\n')
  w('liba/go.mod', 'module example.com/liba\n\ngo 1.21\n')
  w('liba/a.go', 'package liba\n\nfunc A() int { return 1 }\n')
  w('liba/a_test.go', 'package liba\n\nimport "testing"\n\nfunc TestA(t *testing.T) { _ = A() }\n')
  w('libb/go.mod', 'module example.com/libb\n\ngo 1.21\n\nrequire example.com/liba v0.0.0\n')
  w('libb/b.go', 'package libb\n\nimport "example.com/liba"\n\nfunc B() int { return liba.A() }\n')
  w('libb/b_test.go', 'package libb\n\nimport "testing"\n\nfunc TestB(t *testing.T) { _ = B() }\n')
  w('libc/go.mod', 'module example.com/libc\n\ngo 1.21\n')
  w('libc/c.go', 'package libc\n\nfunc C() int { return 3 }\n')
  w('libc/c_test.go', 'package libc\n\nimport "testing"\n\nfunc TestC(t *testing.T) { _ = C() }\n')
  w('libb/inner/i.go', 'package inner\n\nfunc I() int { return 2 }\n')
  w('libb/inner/i_test.go', 'package inner\n\nimport "testing"\n\nfunc TestI(t *testing.T) { _ = I() }\n')
  const inB = path.join(dir, 'libb')
  const r = await sel(inB, ['go', 'test', './...'], ['liba/a.go'])
  assert.equal(r.mode, 'subset') // 別モジュールの変更が、依存する libb だけを選ぶ（inner は独立）
  assert.deepEqual(r.argv, ['go', 'test', 'example.com/libb'])
  const r2 = await sel(dir, ['go', 'test', './...'], ['liba/a.go'])
  assert.equal(r2.mode, 'passthrough') // go.work のルートでは ./... 自体が解決しない
  const r3 = await sel(path.join(dir, 'liba'), ['go', 'test', './...'], ['libc/c.go'])
  assert.equal(r3.mode, 'none')
  rmSync(dir, { recursive: true })
})

test('parseOutput: cargo の成功・失敗（生）', () => {
  const ok = adapter.parseOutput(sample('cargo-pass.txt'))
  assert.equal(ok.failed, 0)
  assert.equal(ok.passed, 6)
  const ng = adapter.parseOutput(sample('cargo-fail.txt'))
  assert.equal(ng.failed, 1)
  assert.equal(ng.passed, 5)
  assert.deepEqual(ng.failures, ['tests::adds'])
})

test('parseOutput: go の成功・失敗（-v / 生 / -json）', () => {
  const v = adapter.parseOutput(sample('go-pass-v.txt'))
  assert.equal(v.passed, 5)
  assert.equal(v.failed, 0)
  const ng = adapter.parseOutput(sample('go-fail.txt'))
  assert.equal(ng.failed, 1)
  assert.equal(ng.passed, undefined)
  assert.deepEqual(ng.failures, ['TestAdd'])
  assert.equal(adapter.parseOutput(sample('go-pass.txt')).passed, undefined)
  const js = adapter.parseOutput(sample('go-fail.json'))
  assert.equal(js.failed, 1)
  assert.equal(js.passed, 1)
})

test('parseOutput: rtk 短縮後', () => {
  assert.equal(adapter.parseOutput(sample('rtk-cargo-pass.txt')).passed, 6)
  const cf = adapter.parseOutput(sample('rtk-cargo-fail.txt'))
  assert.equal(cf.failed, 1)
  assert.deepEqual(cf.failures, ['tests::adds'])
  assert.equal(adapter.parseOutput(sample('rtk-go-pass.txt')).passed, 5)
  const gf = adapter.parseOutput(sample('rtk-go-fail.txt'))
  assert.equal(gf.failed, 1)
  assert.equal(gf.passed, 4)
  assert.deepEqual(gf.failures, ['TestAdd'])
})

test('parseOutput: ビルド失敗は errors に数え、failed にも含める', () => {
  const c = adapter.parseOutput('   Compiling x v0.1.0\nerror[E0425]: cannot find value `y`\nerror: could not compile `x` (lib test) due to 1 previous error\n')
  assert.equal(c.errors, 1)
  assert.equal(c.failed, 1)
  const g = adapter.parseOutput('# example.com/fx/core [example.com/fx/core.test]\ncore/core_test.go:3:1: syntax error\nFAIL\texample.com/fx/core [build failed]\nok  \texample.com/fx/indep\t0.002s\nFAIL\n')
  assert.equal(g.errors, 1)
  assert.equal(g.failed, 1)
  assert.deepEqual(g.failures, ['example.com/fx/core'])
  assert.equal(adapter.parseOutput(sample('cargo-pass.txt')).errors, undefined)
})

test('parseOutput: 空・読めない文字列では数を作らない', () => {
  assert.deepEqual(adapter.parseOutput(''), {})
  assert.deepEqual(adapter.parseOutput('warning: unused variable'), {})
})

test('stripCounts: 合計行が消え、失敗の詳細が残る', () => {
  const totals = /test result: ok|\d+ passed|^running \d+ test|^ok\s|^PASS$|Go test: \d|cargo test: \d|\.\.\. ok$/m
  for (const n of ['cargo-pass.txt', 'cargo-fail.txt', 'go-pass.txt', 'go-pass-v.txt', 'go-fail.txt', 'rtk-cargo-pass.txt', 'rtk-cargo-fail.txt', 'rtk-go-pass.txt', 'rtk-go-fail.txt']) {
    const out = adapter.stripCounts(sample(n))
    assert.ok(!totals.test(out), `${n}\n${out}`)
  }
  const cf = adapter.stripCounts(sample('cargo-fail.txt'))
  for (const s of ['tests::adds', 'left: 3', 'right: 4', 'panicked at core/src/lib.rs', 'FAILED']) assert.ok(cf.includes(s), s)
  const gf = adapter.stripCounts(sample('go-fail.txt'))
  for (const s of ['--- FAIL: TestAdd', 'core_test.go:7: bad', 'FAIL\texample.com/fx/core']) assert.ok(gf.includes(s), s)
  const rg = adapter.stripCounts(sample('rtk-go-fail.txt'))
  assert.ok(rg.includes('[FAIL] TestAdd') && rg.includes('core_test.go:7: bad'))
})
