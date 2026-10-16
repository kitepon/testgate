// 段階1: hook がテストコマンドを `testgate run` に包み直し、包んだコマンドを実際に流すと絞られる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmp } from './tmp.mjs'

const bin = fileURLToPath(new URL('../bin/testgate.mjs', import.meta.url))
const adapters = fileURLToPath(new URL('./fixtures/hook-adapter', import.meta.url))
const hasRtk = spawnSync('rtk', ['--version']).status === 0

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

test('claude: npm test を run に包み、包んだコマンドを sh で流すと a だけ走る', () => {
  const dir = repo()
  writeFileSync(join(dir, 'a.txt'), 'changed')
  const r = hook('claude', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'd' }, cwd: dir, tool_use_id: 'toolu_p1', session_id: 's' }, dir)
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  const cmd = out.hookSpecificOutput.updatedInput.command
  assert.match(cmd, / run --cwd .* -- npm test$/)
  assert.equal(out.hookSpecificOutput.updatedInput.description, 'd')
  const row = rows(dir).at(-1)
  assert.equal(row.phase, 1); assert.equal(row.event, 'rewrite'); assert.equal(row.adapter, 'mocknpm'); assert.equal(row.id, 'toolu_p1')
  // 包んだコマンドをそのまま流す（席が実行するのと同じ道）
  const x = spawnSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8', env: envFor(dir) })
  assert.equal(x.status, 0, x.stderr)
  assert.match(x.stdout, /running a/)
  assert.doesNotMatch(x.stdout, /\d+ ok, \d+ ng/)
  assert.match(x.stdout, /変更に関わる分だけ流した/)
  const last = rows(dir).at(-1)
  assert.equal(last.event, 'run'); assert.equal(last.mode, 'subset'); assert.equal(last.passed, 1)
})
test('前置きの環境変数（TESTGATE_FULL=1）は包んだ後も効く', () => {
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
  const c = JSON.parse(hook('codex', { tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: dir, tool_use_id: 'call_1' }, dir).stdout)
  assert.equal(c.hookSpecificOutput.permissionDecision, 'allow'); assert.match(c.hookSpecificOutput.updatedInput.command, / run --cwd /)
  const u = JSON.parse(hook('cursor', { command: 'npm test', cwd: dir, workspace_roots: [dir] }, dir).stdout)
  assert.equal(u.permission, 'allow'); assert.match(u.updated_input.command, / run --cwd /)
  const g = JSON.parse(hook('grok', { toolName: 'run_terminal_command', toolInput: { command: 'npm test', foo: 1 }, cwd: dir }, dir).stdout)
  assert.match(g.hookSpecificOutput.updatedInput.command, / run --cwd /); assert.equal(g.hookSpecificOutput.updatedInput.foo, 1)
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
