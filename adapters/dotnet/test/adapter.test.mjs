import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as adapter from '../adapter.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fx = path.join(here, '..', 'fixtures')
const env = process.env
const HAS_DOTNET = spawnSync('dotnet', ['--version'], { env }).status === 0
const skipDotnet = HAS_DOTNET ? false : 'dotnet が無い'

// fixtures を tmp へ写して git init。bin/obj は持ち込まない。
function repo(name = 'dotnet-sln') {
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-dotnet-'))
  cpSync(path.join(fx, name), dir, { recursive: true, filter: (s) => !/[\\/](bin|obj)([\\/]|$)/.test(s) })
  execFileSync('git', ['init', '-q'], { cwd: dir })
  return dir
}
const sel = (dir, changed, argv = ['dotnet', 'test'], extra = {}) =>
  adapter.select({ argv, cwd: dir, env, changed, base: null, full: false, ...extra })
const sample = (n) => readFileSync(path.join(fx, 'samples', n), 'utf8')
const FQ = (...cls) => cls.map((c) => `FullyQualifiedName~${c}`).join('|')

test('契約の形', () => {
  assert.equal(adapter.id, 'dotnet')
  assert.match(adapter.id, /^[a-z]+$/)
  assert.deepEqual(adapter.runners, ['dotnet test'])
})

test('detect: ランナーだけ true', () => {
  const t = (a) => adapter.detect(a, { cwd: '.', env })
  for (const a of [
    ['dotnet', 'test'],
    ['dotnet', 'test', 'Fx.sln'],
    ['dotnet', 'test', '-c', 'Release', '--no-build'],
    ['rtk', 'dotnet', 'test'],
    ['DOTNET_CLI_UI_LANGUAGE=en', 'dotnet', 'test'],
    ['/usr/share/dotnet/dotnet', 'test'],
    ['dotnet.exe', 'test', '--filter', 'X'],
  ]) assert.equal(t(a), true, a.join(' '))
  for (const a of [
    ['ls'], ['pytest', '--version'], ['dotnet', 'build'], ['dotnet', '--version'], ['dotnet', 'run'],
    ['dotnet', 'test', '--help'], ['dotnet', 'test', '-h'], ['dotnet', 'test', '--list-tests'], ['dotnet', 'test', '-t'],
    ['dotnet', 'watch', 'test'], ['dotnet', 'vstest', 'a.dll'], ['cargo', 'test'], [],
  ]) assert.equal(t(a), false, a.join(' '))
})

test('変更なし → none', async () => {
  const dir = repo()
  const r = await sel(dir, [])
  assert.equal(r.mode, 'none')
  assert.deepEqual(r.argv, ['dotnet', 'test'])
})

test('full: true → 元の argv', async () => {
  const dir = repo()
  const argv = ['dotnet', 'test', '-c', 'Release']
  const r = await sel(dir, ['src/Core/Greeter.cs'], argv, { full: true })
  assert.equal(r.mode, 'full')
  assert.deepEqual(r.argv, argv)
})

test('ランナーでなければ passthrough', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Core/Greeter.cs'], ['ls'])
  assert.equal(r.mode, 'passthrough')
})

test('Core の Greeter.cs → Main.Tests の GreeterTests だけ（独立のテストは含まない）', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Core/Greeter.cs'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['dotnet', 'test', 'tests/Main.Tests/Main.Tests.csproj', '--filter', FQ('Fx.Tests.GreeterTests')])
  assert.match(r.reason, /^dotnet test: /)
})

test('Core の Money.cs → 型を使うクラスへ広がる（Formatter・Report は拡張メソッドと推移で届く）', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Core/Money.cs'])
  assert.equal(r.mode, 'subset')
  assert.equal(r.argv[4], FQ('Fx.Tests.FormatterTests', 'Fx.Tests.MoneyTests', 'Fx.Tests.ReportTests'))
  assert.ok(!r.argv[4].includes('GreeterTests'))
})

test('Util の Formatter.cs → Core 側のテストは含まない', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Util/Formatter.cs'])
  assert.equal(r.argv[4], FQ('Fx.Tests.FormatterTests', 'Fx.Tests.ReportTests'))
})

test('入れ子のテストクラスは外側の名前で拾う', async () => {
  const dir = repo()
  const r = await sel(dir, ['tests/Main.Tests/ReportTests.cs'])
  assert.equal(r.argv[4], FQ('Fx.Tests.ReportTests'))
})

test('実装クラスの変更は、基底の interface を使う側にも届く', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Util/Clock.cs'])
  assert.equal(r.mode, 'subset')
  assert.match(r.argv[2], /\.slnf$/)
  assert.ok(r.argv[4].includes('Fx.Tests.SchedulerTests') && r.argv[4].includes('Fx.UtilTests.ClockTests'))
  assert.ok(!r.argv[4].includes('GreeterTests') && !r.argv[4].includes('CounterTests'))
  const slnf = JSON.parse(readFileSync(r.argv[2], 'utf8'))
  assert.deepEqual(slnf.solution.projects, ['tests\\Main.Tests\\Main.Tests.csproj', 'tests\\Util.Tests\\Util.Tests.csproj'])
})

test('テスト内の test double（FakeClock : IClock）の変更は、本体の IClock 側へ逆流しない', async () => {
  const dir = repo()
  const r = await sel(dir, ['tests/Main.Tests/SchedulerTests.cs'])
  assert.equal(r.mode, 'subset')
  assert.ok(r.argv[4].includes('Fx.Tests.SchedulerTests'))
  assert.ok(!r.argv[4].includes('ClockTests'))
  assert.ok(!r.argv.some((a) => /\.slnf$/.test(a)), 'Util.Tests まで広げない')
})

test('コメントの中の型名は言及に数えない', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'tests/Main.Tests/GreeterTests.cs'),
    readFileSync(path.join(dir, 'tests/Main.Tests/GreeterTests.cs'), 'utf8') + '\n// Money を使わない\n')
  const r = await sel(dir, ['src/Core/Money.cs'])
  assert.ok(!r.argv.join(' ').includes('GreeterTests'))
})

test('文字リテラル \'"\' の後ろの言及を落とさない', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'tests/Main.Tests/GreeterTests.cs'),
    readFileSync(path.join(dir, 'tests/Main.Tests/GreeterTests.cs'), 'utf8') + "\nclass Q { object F(char c) { if (c == '\"') return new Money(); return null; } }\n")
  const r = await sel(dir, ['src/Core/Money.cs'])
  assert.ok(r.argv.join(' ').includes('Fx.Tests.Q'))
})

test('テストだけが宣言した名前が本体の同名識別子と衝突しても、本体へ逆流しない', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'tests/Main.Tests/ClashTests.cs'),
    'namespace Fx.Tests;\npublic class Candidates { }\npublic class ClashTests { Candidates c; }\n')
  writeFileSync(path.join(dir, 'src/Core/Pick.cs'),
    'namespace Fx.Core;\npublic class Pick { public int Candidates = 1; }\n')
  writeFileSync(path.join(dir, 'tests/Main.Tests/PickTests.cs'),
    'using Fx.Core;\nnamespace Fx.Tests;\npublic class PickTests { Pick p; }\n')
  const r = await sel(dir, ['tests/Main.Tests/ClashTests.cs'])
  assert.ok(r.argv.join(' ').includes('ClashTests'))
  assert.ok(!r.argv.join(' ').includes('PickTests'))
})

test('同じファイルの別の型の言及へは広がらない（波及は型単位）', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'src/Core/Sel.cs'), 'namespace Fx.Core;\npublic class Sel { }\n')
  writeFileSync(path.join(dir, 'src/Core/Host.cs'), 'namespace Fx.Core;\npublic class Host { Sel s; }\npublic class Phys { }\n')
  writeFileSync(path.join(dir, 'src/Core/Rt.cs'), 'namespace Fx.Core;\npublic class Rt { Phys p; }\n')
  writeFileSync(path.join(dir, 'tests/Main.Tests/HostTests.cs'), 'using Fx.Core;\nnamespace Fx.Tests;\npublic class HostTests { Host h; }\n')
  writeFileSync(path.join(dir, 'tests/Main.Tests/RtTests.cs'), 'using Fx.Core;\nnamespace Fx.Tests;\npublic class RtTests { Rt r; }\n')
  const r = await sel(dir, ['src/Core/Sel.cs'])
  assert.equal(r.mode, 'subset')
  assert.ok(r.argv[4].includes('HostTests'))
  assert.ok(!r.argv[4].includes('RtTests'), 'Phys を言及する Rt へは広がらない')
})

test('private の入れ子型は、別ファイルの同名の入れ子型と取り違えない', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'tests/Main.Tests/AAATests.cs'),
    'using Fx.Core;\nnamespace Fx.Tests;\npublic class AAATests { private sealed class Fake { } Greeter g; }\n')
  writeFileSync(path.join(dir, 'tests/Main.Tests/BBBTests.cs'),
    'namespace Fx.Tests;\npublic class BBBTests { private sealed class Fake { } Fake f; }\n')
  const r = await sel(dir, ['tests/Main.Tests/AAATests.cs'])
  assert.ok(r.argv.join(' ').includes('AAATests'))
  assert.ok(!r.argv.join(' ').includes('BBBTests'))
})

test('public の入れ子型の名前は他のファイルからの言及に届く', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'tests/Main.Tests/CCCTests.cs'),
    'namespace Fx.Tests;\npublic class CCCTests { public sealed class Shared { } }\n')
  writeFileSync(path.join(dir, 'tests/Main.Tests/DDDTests.cs'),
    'namespace Fx.Tests;\npublic class DDDTests { CCCTests.Shared s; }\n')
  const r = await sel(dir, ['tests/Main.Tests/CCCTests.cs'])
  assert.ok(r.argv.join(' ').includes('DDDTests'))
})

test('top-level statements は直後の型へ帰属させない', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'src/Core/Sink.cs'), 'namespace Fx.Core;\npublic interface ISink { }\n')
  writeFileSync(path.join(dir, 'src/Core/Program.cs'),
    'using Fx.Core;\nvar g = new Greeter();\nConsole.WriteLine(g);\npublic record NullSink : ISink;\n')
  writeFileSync(path.join(dir, 'tests/Main.Tests/SinkTests.cs'), 'using Fx.Core;\nnamespace Fx.Tests;\npublic class SinkTests { ISink s; }\n')
  // Program.cs の top-level statements が言及する Greeter の変更は、空の record NullSink（ISink）の使い手へ広がらない
  const r = await sel(dir, ['src/Core/Greeter.cs'])
  assert.ok(r.argv.join(' ').includes('GreeterTests'))
  assert.ok(!r.argv.join(' ').includes('SinkTests'))
})

test('独立の Indep の変更 → Indep.Tests だけ。全体がその1クラスなので filter は付かない', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Indep/Counter.cs'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['dotnet', 'test', 'tests/Indep.Tests/Indep.Tests.csproj'])
})

test('csproj の変更は、そのプロジェクトに依存するテスト全体（filter なし）', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Core/Core.csproj'])
  assert.equal(r.mode, 'subset')
  assert.match(r.argv[2], /\.slnf$/)
  assert.deepEqual(JSON.parse(readFileSync(r.argv[2], 'utf8')).solution.projects, ['tests\\Main.Tests\\Main.Tests.csproj', 'tests\\Util.Tests\\Util.Tests.csproj'])
  assert.ok(!r.argv.includes('--filter'))
  const one = await sel(dir, ['src/App/App.csproj'])
  assert.deepEqual(one.argv, ['dotnet', 'test', 'tests/Main.Tests/Main.Tests.csproj'])
})

test('README だけ → none。テストと無関係なファイルは影響しない', async () => {
  const dir = repo()
  assert.equal((await sel(dir, ['README.md'])).mode, 'none')
  assert.equal((await sel(dir, ['src/Core/obj/project.assets.json'])).mode, 'none')
})

test('全体に効くファイル → full', async () => {
  const dir = repo()
  for (const f of ['Directory.Build.props', 'global.json', 'Fx.sln']) {
    const r = await sel(dir, [f])
    assert.equal(r.mode, 'full', f)
    assert.deepEqual(r.argv, ['dotnet', 'test'])
  }
})

test('全部のテストプロジェクトに全部のクラスで届く時は full で、reason が「選べたが全部」', async () => {
  const dir = repo()
  const r = await sel(dir, ['tests/Main.Tests/Main.Tests.csproj', 'tests/Indep.Tests/Indep.Tests.csproj', 'tests/Util.Tests/Util.Tests.csproj'])
  assert.equal(r.mode, 'full')
  assert.match(r.reason, /選べたが全部/)
  assert.deepEqual(r.argv, ['dotnet', 'test'])
})

test('テストプロジェクト1つの repo で絞る手掛かりが無い時は full、reason は「単一」と分かる', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'tests/Main.Tests/appsettings.json'), '{}')
  // Main.Tests だけの solution にする
  const sln = readFileSync(path.join(dir, 'Fx.sln'), 'utf8')
  const keep = sln.replace(/Project\("\{FAE04EC0[^\n]*"(Indep|Util)\.Tests"[^\n]*\r?\nEndProject\r?\n/g, '')
  writeFileSync(path.join(dir, 'Fx.sln'), keep)
  const r = await sel(dir, ['tests/Main.Tests/appsettings.json'])
  assert.equal(r.mode, 'full')
  assert.match(r.reason, /単一テストプロジェクト/)
})

test('人が範囲を絞っている時は passthrough', async () => {
  const dir = repo()
  const ch = ['src/Core/Greeter.cs']
  for (const argv of [
    ['dotnet', 'test', '--filter', 'Name~X'],
    ['dotnet', 'test', '--filter=Name~X'],
    ['dotnet', 'test', 'tests/Main.Tests/Main.Tests.csproj'],
    ['dotnet', 'test', 'tests/Main.Tests/bin/Debug/net8.0/Main.Tests.dll'],
  ]) {
    const r = await sel(dir, ch, argv)
    assert.equal(r.mode, 'passthrough', argv.join(' '))
    assert.deepEqual(r.argv, argv)
  }
})

test('solution の名指しと他のオプションは残す', async () => {
  const dir = repo()
  const r = await sel(dir, ['src/Core/Greeter.cs'], ['dotnet', 'test', 'Fx.sln', '-c', 'Release', '--no-build', '-l', 'trx', '--', 'RunConfiguration.MaxCpuCount=1'])
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, [
    'dotnet', 'test', 'tests/Main.Tests/Main.Tests.csproj', '--filter', FQ('Fx.Tests.GreeterTests'),
    '-c', 'Release', '--no-build', '-l', 'trx', '--', 'RunConfiguration.MaxCpuCount=1',
  ])
  assert.match(r.reason, /^dotnet test: /)
})

test('テストプロジェクトの中で打った時（引数なし）は、そのプロジェクトが範囲', async () => {
  const dir = repo()
  const cwd = path.join(dir, 'tests', 'Main.Tests')
  const r = await adapter.select({ argv: ['dotnet', 'test'], cwd, env, changed: ['src/Core/Greeter.cs'], base: null, full: false })
  assert.equal(r.mode, 'subset')
  assert.deepEqual(r.argv, ['dotnet', 'test', 'Main.Tests.csproj', '--filter', FQ('Fx.Tests.GreeterTests')])
  const none = await adapter.select({ argv: ['dotnet', 'test'], cwd, env, changed: ['src/Indep/Counter.cs'], base: null, full: false })
  assert.equal(none.mode, 'none')
})

test('削除されたソースはクラスへ分けられないので、そのプロジェクト全体', async () => {
  const dir = repo()
  rmSync(path.join(dir, 'src/Core/Money.cs'))
  const r = await sel(dir, ['src/Core/Money.cs'])
  assert.equal(r.mode, 'subset')
  assert.ok(!r.argv.includes('--filter'))
})

test('宣言の読み取り: 文字列・コメント・record・file-scoped namespace', async () => {
  const dir = repo()
  writeFileSync(
    path.join(dir, 'tests/Main.Tests/OddTests.cs'),
    [
      'using Fx.Core;',
      'namespace Fx.Odd;',
      '// class Fake {}',
      'public record struct Pair(int A, int B);',
      'public class OddTests<T> where T : class, new()',
      '{',
      '    string s = $"{{class Nope}} {(new Greeter().Hello("x") ?? "}")}";',
      '    string v = @"namespace Nope { class AlsoNope {} }";',
      '}',
      '',
    ].join('\n'),
  )
  const r = await sel(dir, ['src/Core/Greeter.cs'])
  // Pair は Greeter を言及しないので、型単位では入らない
  assert.equal(r.argv[4], FQ('Fx.Odd.OddTests', 'Fx.Tests.GreeterTests'))
})

test('parseOutput: 成功・失敗・ビルド失敗（生）', () => {
  assert.deepEqual(adapter.parseOutput(sample('dotnet-pass.txt')), { passed: 9, failed: 0, skipped: 0, durationMs: 3 })
  const f = adapter.parseOutput(sample('dotnet-fail.txt'))
  assert.equal(f.passed, 8)
  assert.equal(f.failed, 1)
  assert.deepEqual(f.failures, ['Fx.Tests.MoneyTests.Fails_on_purpose_when_enabled'])
  const b = adapter.parseOutput(sample('dotnet-buildfail.txt'))
  assert.equal(b.errors, 1)
  assert.equal(b.failed, 1 + 0)
  assert.equal(b.passed, 1)
  assert.match(b.failures[0], /Clock\.cs\(5,5\): CS0246/)
})

test('parseOutput: rtk 短縮後', () => {
  assert.deepEqual(adapter.parseOutput(sample('rtk-dotnet-pass.txt')), { passed: 9, failed: 0, skipped: 0, durationMs: 588 })
  const f = adapter.parseOutput(sample('rtk-dotnet-fail.txt'))
  assert.equal(f.passed, 8)
  assert.equal(f.failed, 1)
  assert.deepEqual(f.failures, ['Fx.Tests.MoneyTests.Fails_on_purpose_when_enabled'])
  const b = adapter.parseOutput(sample('rtk-dotnet-buildfail.txt'))
  assert.equal(b.errors, 1)
  assert.match(b.failures[0], /Clock\.cs\(10,37\): CS0117/)
})

test('parseOutput: 数が読めない時は何も返さない・古い形式も読む', () => {
  assert.deepEqual(adapter.parseOutput('hello'), {})
  assert.deepEqual(adapter.parseOutput(''), {})
  const old = 'Test Run Successful.\nTotal tests: 5\n     Passed: 5\n Total time: 1.2 Seconds\n'
  assert.deepEqual(adapter.parseOutput(old), { passed: 5, failed: 0, skipped: 0, durationMs: 1200 })
})

test('stripCounts: 合計行が消え、失敗の詳細は残る', () => {
  for (const n of ['dotnet-pass.txt', 'rtk-dotnet-pass.txt']) {
    const s = adapter.stripCounts(sample(n))
    assert.doesNotMatch(s, /Passed!|Passed:\s+\d|\d+ tests? passed|total of \d+ test files/)
  }
  const f = adapter.stripCounts(sample('dotnet-fail.txt'))
  assert.doesNotMatch(f, /Passed:\s+\d|Total:\s+\d/)
  assert.match(f, /Fails_on_purpose_when_enabled/)
  assert.match(f, /Assert\.Equal\(\) Failure/)
  assert.match(f, /^Failed! - Main\.Tests\.dll \(net8\.0\)$/m)
  const r = adapter.stripCounts(sample('rtk-dotnet-fail.txt'))
  assert.match(r, /Fails_on_purpose_when_enabled/)
  assert.doesNotMatch(r, /\d+ passed/)
  const b = adapter.stripCounts(sample('dotnet-buildfail.txt'))
  assert.match(b, /error CS0246/)
})

test('実機: select の argv を dotnet test で流すと、選んだクラスだけ走る', { skip: skipDotnet, timeout: 600000 }, async (t) => {
  const dir = repo()
  const restore = spawnSync('dotnet', ['restore', 'Fx.sln', '-v', 'q'], { cwd: dir, env, encoding: 'utf8' })
  if (restore.status !== 0) return t.skip('dotnet restore ができない（NuGet に届かない）')
  const r = await sel(dir, ['src/Core/Greeter.cs'])
  assert.equal(r.mode, 'subset')
  const res = spawnSync(r.argv[0], r.argv.slice(1), { cwd: dir, env, encoding: 'utf8' })
  const p = adapter.parseOutput(res.stdout + res.stderr)
  assert.equal(p.failed, 0)
  assert.equal(p.passed, 2)
})
