// run の子プロセス起動。Windows は shell を通さず、.cmd/.bat だけ cmd.exe に引用して渡す。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { resolveWin, quoteCmd, winSpawnArgs, execCapture, envGet } from '../lib/run.mjs'

const files = new Set(['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files\\nodejs\\npm', 'C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files\\dotnet\\dotnet.exe', 'C:\\tools\\gradlew.bat'])
const env = { Path: 'C:\\Windows;C:\\Program Files\\nodejs;C:\\Program Files\\dotnet', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
const deps = { exists: p => files.has(p), pathMod: path.win32 }

test('envGet は大文字小文字を区別しない（Path / PATH）', () => {
  assert.equal(envGet(env, 'PATH'), env.Path)
  assert.equal(envGet({}, 'PATH'), undefined)
})
test('resolveWin: PATH と PATHEXT で実行ファイルを見つけ、.cmd/.bat だけ batch', () => {
  assert.deepEqual(resolveWin('dotnet', env, deps), { file: 'C:\\Program Files\\dotnet\\dotnet.exe', batch: false })
  assert.deepEqual(resolveWin('npm', env, deps), { file: 'C:\\Program Files\\nodejs\\npm.cmd', batch: true })
  assert.deepEqual(resolveWin('C:\\Program Files\\nodejs\\npm', env, deps), { file: 'C:\\Program Files\\nodejs\\npm.cmd', batch: true }) // 拡張子無しの POSIX 用 npm より npm.cmd を先に取る（fox で spawn ENOENT になった）
  assert.deepEqual(resolveWin('C:\\Program Files\\nodejs\\node.exe', env, deps), { file: 'C:\\Program Files\\nodejs\\node.exe', batch: false })
  assert.deepEqual(resolveWin('C:\\tools\\gradlew', env, deps), { file: 'C:\\tools\\gradlew.bat', batch: true })
  assert.deepEqual(resolveWin('nothere', env, deps), { file: 'nothere', batch: false })
})
test('quoteCmd: 空白と cmd のメタ文字だけ引用し、| は文字のまま', () => {
  assert.equal(quoteCmd('--no-restore'), '--no-restore')
  assert.equal(quoteCmd('FullyQualifiedName~A|FullyQualifiedName~B'), '"FullyQualifiedName~A|FullyQualifiedName~B"')
  assert.equal(quoteCmd('C:\\Program Files\\x.exe'), '"C:\\Program Files\\x.exe"')
  assert.equal(quoteCmd('say "hi"'), '"say \\"hi\\""')
  assert.equal(quoteCmd('C:\\dir\\'), 'C:\\dir\\')
  assert.equal(quoteCmd('C:\\Program Files\\'), '"C:\\Program Files\\\\"')
  assert.equal(quoteCmd(''), '""')
})
test('winSpawnArgs: .exe は直接、.cmd は cmd.exe /d /s /c に引用して渡す', () => {
  const filter = 'FullyQualifiedName~A.Tests.X|FullyQualifiedName~A.Tests.Y'
  const exe = winSpawnArgs(['dotnet', 'test', 'A.csproj', '--filter', filter, '--no-restore'], env, deps)
  assert.equal(exe.file, 'C:\\Program Files\\dotnet\\dotnet.exe')
  assert.deepEqual(exe.args, ['test', 'A.csproj', '--filter', filter, '--no-restore'])
  assert.equal(exe.options.windowsVerbatimArguments, undefined)
  const cmd = winSpawnArgs(['npm', 'test', '--', '--grep', 'a b'], env, deps)
  assert.equal(cmd.file, env.ComSpec)
  assert.deepEqual(cmd.args, ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" test -- --grep "a b""'])
  assert.equal(cmd.options.windowsVerbatimArguments, true)
})
test('execCapture: 引数は引用なしでそのまま子へ届く', async () => {
  const r = await execCapture(['node', '-e', 'console.log(process.argv.slice(1).join("\\n"))', 'a|b', 'c d'], { cwd: process.cwd(), env: process.env, timeoutMs: 0 })
  assert.equal(r.status, 0)
  assert.equal(r.output, 'a|b\nc d\n')
})
test('execCapture: timeout後、終了した子の強制終了タイマーを残さない', async () => {
  const start = Date.now()
  const source = `import { execCapture } from ${JSON.stringify(new URL('../lib/run.mjs', import.meta.url).href)}; const r = await execCapture([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env: process.env, cwd: process.cwd(), timeoutMs: 100 }); process.exitCode = r.timedOut ? 0 : 1`
  const r = await execCapture([process.execPath, '--input-type=module', '-e', source], { env: process.env, cwd: process.cwd(), timeoutMs: 3000 })
  assert.equal(r.status, 0, r.output)
  assert.equal(r.timedOut, false)
  assert.ok(Date.now() - start < 3000)
})
