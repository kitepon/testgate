import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rewriteCompound, compoundCommands } from '../lib/compound.mjs'
import { tmp } from './tmp.mjs'

const bin = fileURLToPath(new URL('../bin/testgate.mjs', import.meta.url))
const mockAdapters = fileURLToPath(new URL('./fixtures/hook-adapter', import.meta.url))
const posix = { skip: process.platform === 'win32' && 'POSIXの複合コマンド' }
const wrap = part => `WRAPPED(${part.argv.join(',')})`

test('連結子、引用符、コメント、前後のコマンドはそのまま残す', () => {
  const source = `cd 'repo with spaces' && npm test > 'out log' 2>&1 | tail -n 20; status=$?\n# npm test\nexit "$status"`
  const result = rewriteCompound(source, wrap)
  assert.equal(result.command, `cd 'repo with spaces' && WRAPPED(npm,test) > 'out log' 2>&1 | tail -n 20; status=$?\n# npm test\nexit "$status"`)
  assert.equal(result.count, 1)
})
test('リダイレクト先をargvに入れず、順序を保つ', () => {
  const result = rewriteCompound('> out npm 2> err test 2>&1', wrap)
  assert.equal(result.command, 'WRAPPED(npm,test) > out 2> err 2>&1')
})
test('複数のテスト呼び出しをそれぞれ置き換える', () => {
  assert.equal(rewriteCompound('npm test && node --test | tail', wrap).count, 2)
})
test('引用中の制御文字をコマンドに分割しない', () => {
  assert.equal(rewriteCompound(`echo 'npm test && nope'; npm test -- '--name=a|b'`, wrap).command,
    `echo 'npm test && nope'; WRAPPED(npm,test,--,--name=a|b)`)
})
test('変数展開を含むテスト引数を固定化しない', () => {
  assert.equal(rewriteCompound('node --test "$TESTS" > log', wrap), null)
  assert.equal(rewriteCompound('cd "$REPO" && npm test', wrap).command, 'cd "$REPO" && WRAPPED(npm,test)')
})
for (const command of [
  'if true; then npm test; fi', 'for x in a; do npm test; done',
  '(npm test)', '{ npm test; }', 'npm test &', 'npm test |& tail',
  'npm test <<EOF\nx\nEOF', 'npm test <<< x', 'npm test >',
  'echo $(npm test); npm test', 'echo `npm test`; npm test',
  'npm test &&', 'npm test ;; echo ok', 'npm test > >(cat)',
  'npm test 3> log', 'npm test 2>&3', 'npm test 1>&-',
  '. ./environment.sh; npm test', 'eval "alias npm=other"; npm test',
  "npm test 'unterminated", 'npm test \\\n--flag', 'npm test; function f { echo hi; }',
]) {
  test(`解釈対象外は元のシェルへ渡す: ${JSON.stringify(command)}`, () => {
    assert.equal(rewriteCompound(command, wrap), null)
  })
}
test(' && の後の改行、空行、末尾のコメントを扱う', () => {
  assert.equal(rewriteCompound('cd repo &&\n\nnpm test # last', wrap).command, 'cd repo &&\n\nWRAPPED(npm,test) # last')
  assert.equal(compoundCommands('npm test &&\n'), null)
})

function fixture() {
  const parent = tmp('tg-compound-')
  const dir = join(parent, 'repo with spaces')
  mkdirSync(join(dir, 'src'), { recursive: true }); mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
  for (const name of ['a', 'b']) {
    writeFileSync(join(dir, 'src', `${name}.mjs`), `export const value = 1\n`)
    writeFileSync(join(dir, 'test', `${name}.test.mjs`), `import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { value } from '../src/${name}.mjs'\ntest('${name}-selected', () => assert.ok(value > 0))\n`)
  }
  const g = (...args) => { const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr) }
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'initial')
  writeFileSync(join(dir, 'src/a.mjs'), 'export const value = 2\n')
  const env = { ...process.env, TESTGATE_PHASE: '1', TESTGATE_LOG: join(parent, 'log.jsonl'), XDG_STATE_HOME: join(parent, 'state') }
  delete env.TESTGATE_ADAPTERS
  delete env.NODE_TEST_CONTEXT // 実際のCLIと同じく、子のnode --testを独立した走者にする。
  const rows = () => readFileSync(env.TESTGATE_LOG, 'utf8').trim().split('\n').map(JSON.parse)
  const hook = (command, harness = 'claude') => {
    const payload = harness === 'cursor' ? { command, cwd: parent } : harness === 'grok'
      ? { toolName: 'run_terminal_command', toolInput: { command }, cwd: parent }
      : { tool_name: 'Bash', tool_input: { command }, cwd: parent, tool_use_id: 'compound-call', session_id: 'compound-session' }
    const r = spawnSync(process.execPath, [bin, 'hook', harness], { input: JSON.stringify(payload), cwd: parent, encoding: 'utf8', env })
    assert.equal(r.status, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    return out.updated_input?.command ?? out.hookSpecificOutput.updatedInput.command
  }
  const run = (command, executionDir = parent) => spawnSync('/bin/sh', ['-c', command], { cwd: executionDir, encoding: 'utf8', env })
  return { parent, dir, env, hook, run, rows }
}

for (const harness of ['claude', 'codex', 'cursor', 'grok']) {
  test(`${harness}: cd後のrepoで実際に一部だけ実行し、ログへ出力する`, posix, () => {
    const f = fixture()
    const command = f.hook(`cd 'repo with spaces' && node --test > out.log 2> err.log`, harness)
    const r = f.run(command)
    assert.equal(r.status, 0, r.stderr)
    const out = readFileSync(join(f.dir, 'out.log'), 'utf8')
    assert.match(out, /a-selected/); assert.doesNotMatch(out, /b-selected/)
    const [rewrite, run] = f.rows()
    assert.equal(rewrite.compound, true); assert.equal(run.mode, 'subset')
    assert.equal(run.cwd, realpathSync(f.dir))
    assert.equal(rewrite.invocationId, run.invocationId)
    assert.equal(run.passed, 1); assert.equal(run.failed, 0)
  })
}
test('パイプと後続処理を維持する', posix, () => {
  const f = fixture()
  const cmd = f.hook(`cd 'repo with spaces' && node --test | cat > pipe.log; printf after > after.log`)
  const r = f.run(cmd)
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(f.dir, 'pipe.log'), 'utf8'), /a-selected/)
  assert.doesNotMatch(readFileSync(join(f.dir, 'pipe.log'), 'utf8'), /b-selected/)
  assert.equal(readFileSync(join(f.dir, 'after.log'), 'utf8'), 'after')
})
test('cd失敗時はテストと後続の&&処理を実行しない', posix, () => {
  const f = fixture()
  const r = f.run(f.hook('cd missing && node --test && touch should-not-exist'))
  assert.notEqual(r.status, 0)
  assert.equal(f.rows().filter(r => r.event === 'run').length, 0)
})
test('Codexが別workdirで実行しても、その場所のcdと変更に従う', posix, () => {
  const f = fixture()
  const command = f.hook('node --test > out.log', 'codex')
  const r = f.run(command, f.dir)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(f.rows().at(-1).cwd, realpathSync(f.dir))
  assert.equal(f.rows().at(-1).mode, 'subset')
})
test('環境変数とstdout/stderrの出力先、失敗の終了値、||を維持する', posix, () => {
  const f = fixture()
  f.env.TESTGATE_ADAPTERS = mockAdapters
  writeFileSync(join(f.dir, 'mocktest.mjs'), `console.log('out:' + process.env.CASE_VALUE); console.error('err:kept'); process.exit(7)\n`)
  const command = f.hook(`cd 'repo with spaces' && CASE_VALUE='a b' npm test > out.log 2> err.log; result=$?; printf '%s' "$result" > status.log; exit "$result"`)
  const r = f.run(command)
  assert.equal(r.status, 7, r.stderr)
  assert.equal(readFileSync(join(f.dir, 'out.log'), 'utf8'), 'out:a b\n')
  assert.equal(readFileSync(join(f.dir, 'err.log'), 'utf8'), 'err:kept\n')
  assert.equal(readFileSync(join(f.dir, 'status.log'), 'utf8'), '7')
  assert.equal(f.rows().at(-1).status, 7)
})
test('実行場所に対応アダプタが無い場合も元コマンドを飛ばさない', posix, () => {
  const f = fixture()
  const fake = join(f.parent, 'ctest')
  writeFileSync(fake, '#!/bin/sh\nprintf original-out\nprintf original-err >&2\nexit 9\n', { mode: 0o755 })
  f.env.PATH = f.parent + ':' + f.env.PATH
  const r = f.run(f.hook('ctest > out.log 2> err.log || exit 19'))
  assert.equal(r.status, 19)
  assert.equal(readFileSync(join(f.parent, 'out.log'), 'utf8'), 'original-out')
  assert.equal(readFileSync(join(f.parent, 'err.log'), 'utf8'), 'original-err')
  assert.equal(f.rows().at(-1).status, 9)
  assert.equal(f.rows().at(-1).mode, 'passthrough')
})
test('元の指定がテストファイルなら減らさない', posix, () => {
  const f = fixture()
  const r = f.run(f.hook(`cd 'repo with spaces' && node --test test/b.test.mjs > named.log`))
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(f.dir, 'named.log'), 'utf8'), /b-selected/)
  assert.equal(f.rows().at(-1).mode, 'passthrough')
})
test('前置きの秘密値をfallback引数やranのログへ複製しない', posix, () => {
  const f = fixture()
  const command = f.hook(`cd 'repo with spaces' && API_TOKEN=private-example-value node --test > out.log`)
  assert.match(command, /API_TOKEN=private-example-value/)
  assert.doesNotMatch(f.rows()[0].ran, /private-example-value/)
  assert.doesNotMatch(f.rows()[0].command, /private-example-value/)
  const r = f.run(command)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(f.rows().at(-1).mode, 'subset')
})
test('失敗したテストで&&を止めて||へ進む', posix, () => {
  const f = fixture()
  f.env.TESTGATE_ADAPTERS = mockAdapters
  writeFileSync(join(f.dir, 'mocktest.mjs'), 'process.exit(7)\n')
  const r = f.run(f.hook(`cd 'repo with spaces' && npm test && printf wrong || printf recovered`))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, 'recovered')
  assert.equal(f.rows().at(-1).status, 7)
})
test('大きい出力をパイプへ転送し終えてから終了する', posix, () => {
  const f = fixture()
  const fake = join(f.parent, 'ctest')
  writeFileSync(fake, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(512 * 1024))\n`, { mode: 0o755 })
  f.env.PATH = f.parent + ':' + f.env.PATH
  const r = f.run(f.hook('ctest | cat > large.log'))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(readFileSync(join(f.parent, 'large.log'), 'utf8'), 'x'.repeat(512 * 1024))
})
test('シグナルで終了したテストも元の143を後続処理へ渡す', posix, () => {
  const f = fixture()
  f.env.TESTGATE_ADAPTERS = mockAdapters
  writeFileSync(join(f.dir, 'mocktest.mjs'), "process.kill(process.pid, 'SIGTERM')\n")
  const r = f.run(f.hook(`cd 'repo with spaces' && npm test; result=$?; printf '%s' "$result"`))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '143')
  assert.equal(f.rows().at(-1).status, 143)
})
