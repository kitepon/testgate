// 段階1: hook がテストコマンドを `testgate run` に包み直し、包んだコマンドを実際に流すと絞られる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmp } from './tmp.mjs'

const bin = fileURLToPath(new URL('../bin/testgate.mjs', import.meta.url))
const adapters = fileURLToPath(new URL('./fixtures/hook-adapter', import.meta.url))
const hasRtk = spawnSync('rtk', ['--version']).status === 0
const windows = process.platform === 'win32'
const shellTool = windows ? 'PowerShell' : 'Bash'
const runWrapped = (command, dir) => spawnSync(windows ? 'pwsh' : 'sh', windows
  ? ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]
  : ['-c', command], { cwd: dir, encoding: 'utf8', env: envFor(dir) })

function repo() {
  const dir = tmp('tg-p1-')
  writeFileSync(join(dir, 'mocktest.mjs'), `const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only')+1] : null\nconsole.log('running', only ?? 'all')\nconsole.log(only ? '1 ok, 0 ng' : '3 ok, 0 ng')\n`)
  writeFileSync(join(dir, 'a.txt'), 'a')
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return dir
}
const envFor = (dir, extra = {}) => ({ ...process.env, TESTGATE_PHASE: '1', TESTGATE_ADAPTERS: adapters, TESTGATE_LOG: join(dir, 'log.jsonl'), XDG_STATE_HOME: join(dir, 'state'), ...extra })
const hook = (harness, event, dir, extra) => spawnSync('node', [bin, 'hook', harness], { input: JSON.stringify(event), encoding: 'utf8', env: envFor(dir, extra) })
const rows = dir => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)

test('claude: npm test を run に包み、OSのshellで流すと a だけ走る', () => {
  const dir = repo()
  writeFileSync(join(dir, 'a.txt'), 'changed')
  const r = hook('claude', { tool_name: shellTool, tool_input: { command: 'npm test', description: 'd' }, cwd: dir, tool_use_id: 'toolu_p1', session_id: 's' }, dir)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  const cmd = out.hookSpecificOutput.updatedInput.command
  assert.match(cmd, / run --cwd .* -- npm test$/)
  assert.equal(out.hookSpecificOutput.updatedInput.description, 'd')
  const row = rows(dir).at(-1)
  assert.equal(row.phase, 1); assert.equal(row.event, 'rewrite'); assert.equal(row.adapter, 'mocknpm'); assert.equal(row.id, 'toolu_p1')
  // 包んだコマンドをそのまま流す（席が実行するのと同じ道）
  const x = runWrapped(cmd, dir)
  assert.equal(x.status, 0, x.stderr)
  assert.match(x.stdout, /running a/)
  assert.doesNotMatch(x.stdout, /\d+ ok, \d+ ng/)
  assert.match(x.stdout, /変更に関わる分だけ流した/)
  const last = rows(dir).at(-1)
  assert.equal(last.event, 'run'); assert.equal(last.mode, 'subset'); assert.equal(last.passed, 1)
})
test('POSIXの前置き環境変数（TESTGATE_FULL=1）は包んだ後も効く', { skip: windows && 'POSIXの環境変数構文' }, () => {
  const dir = repo()
  const r = hook('claude', { tool_name: 'Bash', tool_input: { command: 'TESTGATE_FULL=1 npm test' }, cwd: dir }, dir)
  const cmd = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command
  assert.match(cmd, /^TESTGATE_FULL=1 /)
  const x = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: envFor(dir) })
  assert.match(x.stdout, /running all/)
  assert.equal(rows(dir).at(-1).mode, 'full')
})
test('codex / cursor / grok の形', () => {
  const dir = repo()
  if (windows) {
    for (const [harness, event] of [
      ['codex', { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir, tool_use_id: 'call_1' }],
      ['cursor', { command: 'npm test', cwd: dir, workspace_roots: [dir] }],
      ['grok', { toolName: 'run_terminal_command', toolInput: { command: 'npm test', foo: 1 }, cwd: dir }],
    ]) {
      const r = hook(harness, event, dir)
      const relay = hook(harness, event, dir, { TESTGATE_PHASE: '0' })
      assert.equal(r.status, 0, r.stderr)
      assert.equal(r.stdout, relay.stdout, `${harness}: Windowsでは段階0へ中継する`)
      assert.equal(rows(dir).at(-2).phase, 0)
    }
    return
  }
  const c = JSON.parse(hook('codex', { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir, tool_use_id: 'call_1' }, dir).stdout)
  assert.equal(c.hookSpecificOutput.permissionDecision, 'allow'); assert.match(c.hookSpecificOutput.updatedInput.command, / run -- npm test$/)
  assert.doesNotMatch(c.hookSpecificOutput.updatedInput.command, / --cwd /) // workdir が無い codex は --cwd を付けない（unified exec は workdir を hook に渡さない）
  const u = JSON.parse(hook('cursor', { command: 'npm test', cwd: dir, workspace_roots: [dir] }, dir).stdout)
  assert.equal(u.permission, 'allow'); assert.match(u.updated_input.command, / run --cwd /)
  const g = JSON.parse(hook('grok', { toolName: 'run_terminal_command', toolInput: { command: 'npm test', foo: 1 }, cwd: dir }, dir).stdout)
  assert.match(g.hookSpecificOutput.updatedInput.command, / run --cwd /); assert.equal(g.hookSpecificOutput.updatedInput.foo, 1)
})
test('codex: workdir が hook に来ない時（unified exec の exec_command）は --cwd を付けず、実行時の cwd（Codex が workdir で起動する）で動く', { skip: windows && 'Windows では codex を中継する' }, () => {
  const dir = repo()
  const sub = repo() // ターンの cwd（event.cwd）は dir、実際の実行は workdir の sub。hook には workdir が来ない
  writeFileSync(join(sub, 'a.txt'), 'changed')
  const r = hook('codex', { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir, tool_use_id: 'call_i1' }, dir)
  assert.equal(r.status, 0, r.stderr)
  const cmd = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command
  assert.doesNotMatch(cmd, / --cwd /); assert.match(cmd, / run -- npm test$/)
  assert.equal(rows(dir).at(-1).inheritCwd, true)
  const x = spawnSync('sh', ['-c', cmd], { cwd: sub, encoding: 'utf8', env: envFor(sub) })
  assert.equal(x.status, 0, x.stderr)
  assert.match(x.stdout, /running a/) // sub の変更に合わせて a だけ流れた（dir ではなく sub で動いた証拠）
  const last = rows(sub).at(-1)
  assert.equal(last.event, 'run'); assert.equal(last.cwd, sub); assert.equal(last.mode, 'subset')
})
test('codex: tool_input.workdir があれば包んだ run の --cwd はそこ（相対なら cwd 基準）', { skip: windows && 'Windows では codex を中継する' }, () => {
  const dir = repo()
  const sub = repo() // 別の repo を workdir にする（相対指定は dir からの相対で辿る）
  const abs = JSON.parse(hook('codex', { tool_name: 'Bash', tool_input: { command: 'npm test', workdir: sub }, cwd: dir, tool_use_id: 'call_w1' }, dir).stdout)
  assert.match(abs.hookSpecificOutput.updatedInput.command, new RegExp(` run --cwd ${sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} `))
  const rel = JSON.parse(hook('codex', { tool_name: 'Bash', tool_input: { command: 'npm test', workdir: relative(dir, sub) }, cwd: dir, tool_use_id: 'call_w2' }, dir).stdout)
  assert.equal(rel.hookSpecificOutput.updatedInput.command, abs.hookSpecificOutput.updatedInput.command)
  const rows2 = rows(dir).filter(r => r.id === 'call_w1' || r.id === 'call_w2')
  assert.equal(rows2.length, 2); for (const r of rows2) assert.equal(r.cwd, sub)
})
test('WindowsのBashは包まず段階0へ中継する', { skip: !windows && 'Windowsの限定仕様' }, () => {
  const dir = repo()
  const event = { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir }
  const r = hook('claude', event, dir)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, hook('claude', event, dir, { TESTGATE_PHASE: '0' }).stdout)
  assert.equal(rows(dir).at(-2).phase, 0)
})
test('PowerShell は & で包む', () => {
  const dir = repo()
  const r = hook('claude', { tool_name: 'PowerShell', tool_input: { command: 'npm test' }, cwd: dir }, dir)
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.command, /^& /)
})
for (const [label, command] of [['複合', 'cd x && npm test'], ['アダプタが扱わない', 'pytest -q'], ['テストでない', 'ls -la'], ['time の包み', 'time npm test']]) {
  test(`${label}: 包まず段階0の中継（RTK と同じ出力）`, { skip: !hasRtk && 'rtk が無い' }, () => {
    const dir = repo()
    const raw = { tool_name: 'Bash', tool_input: { command }, cwd: dir }
    const r = hook('claude', raw, dir)
    assert.equal(r.stdout, spawnSync('rtk', ['hook', 'claude'], { input: JSON.stringify(raw), encoding: 'utf8' }).stdout)
    assert.equal(r.status, 0)
    if (existsSync(join(dir, 'log.jsonl'))) assert.equal(rows(dir).at(-1).phase, 0)
  })
}
test('TESTGATE_PHASE=0 なら包まない', { skip: !hasRtk && 'rtk が無い' }, () => {
  const dir = repo()
  const raw = { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir }
  const r = hook('claude', raw, dir, { TESTGATE_PHASE: '0' })
  assert.equal(r.stdout, spawnSync('rtk', ['hook', 'claude'], { input: JSON.stringify(raw), encoding: 'utf8' }).stdout)
})
test('hook claude に相乗り（Shell）が来たら段階1でも黙って通す', () => {
  const dir = repo()
  const r = hook('claude', { tool_name: 'Shell', tool_input: { command: 'npm test' }, cwd: dir }, dir)
  assert.equal(r.stdout, ''); assert.equal(existsSync(join(dir, 'log.jsonl')), false)
})
