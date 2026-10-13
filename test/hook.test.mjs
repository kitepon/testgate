// 段階0の中継: testgate hook X の出力が rtk hook X と一致し、テスト実行だけが記録される。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../bin/testgate.mjs', import.meta.url))
const hasRtk = spawnSync('rtk', ['--version']).status === 0

function run(harness, event, env) {
  const raw = JSON.stringify(event)
  const ours = spawnSync('node', [bin, 'hook', harness], { input: raw, encoding: 'utf8', env: { ...process.env, ...env } })
  const theirs = spawnSync('rtk', ['hook', harness], { input: raw, encoding: 'utf8', env: { ...process.env, ...env } })
  return { ours, theirs }
}

const cases = [
  ['claude', { tool_name: 'Bash', tool_input: { command: 'pytest -q' }, cwd: '/tmp' }, 'pytest'],
  ['claude', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd: '/tmp' }, null],
  ['claude', { tool_name: 'Bash', tool_input: { command: 'cd x && npm test' }, cwd: '/tmp' }, 'npm test'],
  ['cursor', { command: 'cargo test', cwd: '/tmp' }, 'cargo test'],
  ['codex', { tool_name: 'Bash', tool_input: { command: 'go test ./...' }, cwd: '/tmp' }, 'go test'],
]

for (const [harness, event, runner] of cases) {
  test(`中継 ${harness}: ${event.tool_input?.command ?? event.command}`, { skip: !hasRtk && 'rtk が無い' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'testgate-'))
    const log = join(dir, 'log.jsonl')
    const { ours, theirs } = run(harness, event, { TESTGATE_LOG: log, BELLTEAM_BOT_ID: 'bot-test' })
    assert.equal(ours.stdout, theirs.stdout, 'stdout が RTK と一致する')
    assert.equal(ours.status, theirs.status, '終了コードが RTK と一致する')
    if (runner) {
      const rows = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].runner, runner)
      assert.equal(rows[0].harness, harness)
      assert.equal(rows[0].bot, 'bot-test')
    } else {
      assert.equal(existsSync(log), false, 'テスト以外は記録しない')
    }
  })
}

test('rtk が無い時は何も書き換えずに通す', () => {
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: JSON.stringify({ tool_input: { command: 'pytest' } }), encoding: 'utf8', env: { ...process.env, RTK_BIN: '/nonexistent/rtk', TESTGATE_LOG: join(mkdtempSync(join(tmpdir(), 'tg-')), 'l') } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('grok: BellTeam の grok-hook.mjs と同じ出力', { skip: !hasRtk && 'rtk が無い' }, () => {
  const ref = '/srv/bellteam/bots/bot-47fad91c/work/BellTeam/integrations/rtk/grok-hook.mjs'
  if (!existsSync(ref)) return
  for (const command of ['pytest -q', 'ls -la', 'echo hi']) {
    const raw = JSON.stringify({ toolName: 'run_terminal_command', toolInput: { command, foo: 1 }, cwd: '/tmp' })
    const log = join(mkdtempSync(join(tmpdir(), 'tg-')), 'l')
    const ours = spawnSync('node', [bin, 'hook', 'grok'], { input: raw, encoding: 'utf8', env: { ...process.env, TESTGATE_LOG: log } })
    const theirs = spawnSync('node', [ref], { input: raw, encoding: 'utf8', env: { ...process.env, RTK_BIN: 'rtk' } })
    assert.equal(ours.stdout, theirs.stdout, `grok ${command}`)
    assert.equal(ours.status, theirs.status)
    assert.equal(existsSync(log), command.startsWith('pytest'))
  }
})
