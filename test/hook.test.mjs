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

test('BOM 付きの入力でも判定できる', { skip: !hasRtk && 'rtk が無い' }, () => {
  const log = join(mkdtempSync(join(tmpdir(), 'tg-')), 'l')
  const raw = '﻿' + JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'pytest' }, cwd: '/tmp' })
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: raw, encoding: 'utf8', env: { ...process.env, TESTGATE_LOG: log } })
  assert.equal(r.status, spawnSync('rtk', ['hook', 'claude'], { input: raw, encoding: 'utf8' }).status)
  assert.equal(existsSync(log), true)
})

test('rtk hook が時間内に返らない時は、書き換えずに通して exit 1 で知らせる（2 は使わない）', () => {
  const fake = fileURLToPath(new URL('./fixtures/bin/rtk', import.meta.url))
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: JSON.stringify({ tool_input: { command: 'ls' } }), encoding: 'utf8', env: { ...process.env, RTK_BIN: fake, TESTGATE_RTK_TIMEOUT_MS: '300', TESTGATE_LOG: join(mkdtempSync(join(tmpdir(), 'tg-')), 'l') } })
  assert.equal(r.status, 1)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /rtk hook failed/)
})

test('ログの書き込みに失敗しても hook は通る', { skip: !hasRtk && 'rtk が無い' }, () => {
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: JSON.stringify({ tool_input: { command: 'pytest' } }), encoding: 'utf8', env: { ...process.env, TESTGATE_LOG: '/proc/nonexistent/log.jsonl' } })
  assert.equal(r.status, 0)
  assert.match(r.stderr, /log failed/)
})

test('段階0の影の判断: アダプタがあれば選択の結果を記録し、出力は RTK と同じ', { skip: !hasRtk && 'rtk が無い' }, () => {
  const adapters = fileURLToPath(new URL('./fixtures/mock-adapter', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'tg-shadow-'))
  const g = (...a) => spawnSync('git', a, { cwd: dir })
  g('init', '-q'); spawnSync('sh', ['-c', 'echo a > a.txt && echo m > mocktest.mjs'], { cwd: dir }); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i')
  spawnSync('sh', ['-c', 'echo b > a.txt'], { cwd: dir })
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node mocktest.mjs' }, cwd: dir })
  const log = join(dir, 'log.jsonl')
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: raw, encoding: 'utf8', env: { ...process.env, TESTGATE_ADAPTERS: adapters, TESTGATE_LOG: log, XDG_STATE_HOME: join(dir, 'state') } })
  assert.equal(r.stdout, spawnSync('rtk', ['hook', 'claude'], { input: raw, encoding: 'utf8' }).stdout)
  // 判定表に node mocktest.mjs は無いので記録されない（影の判断はアダプタの detect と判定表の両方が要る）: ここでは記録が無いことを確かめる
  assert.equal(existsSync(log), false)
})

test('hook に知らない名前を渡しても 2 は返さない', () => {
  const r = spawnSync('node', [bin, 'hook', 'nope'], { input: '{}', encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /unknown harness/)
})

test('記録では前置きの環境変数の値を消し、id・session・transcript を残す', { skip: !hasRtk && 'rtk が無い' }, () => {
  const log = join(mkdtempSync(join(tmpdir(), 'tg-')), 'l')
  const raw = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'TOKEN=abc123 npm test' }, cwd: '/tmp', tool_use_id: 'toolu_1', session_id: 'sess_1', transcript_path: '/x/t.jsonl' })
  spawnSync('node', [bin, 'hook', 'claude'], { input: raw, encoding: 'utf8', env: { ...process.env, TESTGATE_LOG: log } })
  const row = JSON.parse(readFileSync(log, 'utf8').trim())
  assert.equal(row.command, 'TOKEN=*** npm test')
  assert.equal(row.id, 'toolu_1'); assert.equal(row.session, 'sess_1'); assert.equal(row.transcript, '/x/t.jsonl')
})

test('既定の記録先は ~/.local/state/testgate', async () => {
  const { logPath } = await import('../lib/log.mjs')
  assert.equal(logPath({ HOME: '/h' }), '/h/.local/state/testgate/log.jsonl')
  assert.equal(logPath({ HOME: '/h', XDG_STATE_HOME: '/s' }), '/s/testgate/log.jsonl')
})

// Grok（tool_name=run_terminal_command）と Cursor（tool_name=Shell）が ~/.claude/settings.json の hook を相乗りで呼んだ時は、記録も書き換えもせず通す
for (const [name, event] of [
  ['grok 相乗り', { tool_name: 'run_terminal_command', tool_input: { command: 'node --test a.test.mjs' }, tool_use_id: 'call-1', session_id: 's', transcript_path: '/home/x/.grok/sessions/s/updates.jsonl', cwd: '/tmp' }],
  ['cursor 相乗り', { tool_name: 'Shell', tool_input: { command: 'node --test a.test.mjs' }, tool_use_id: '350753db', session_id: 's', cwd: '/tmp' }],
]) {
  test(`hook claude に Bash 以外の道具名が来たら黙って通す（${name}）`, () => {
    const log = join(mkdtempSync(join(tmpdir(), 'tg-')), 'l')
    const r = spawnSync('node', [bin, 'hook', 'claude'], { input: JSON.stringify(event), encoding: 'utf8', env: { ...process.env, TESTGATE_LOG: log } })
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(existsSync(log), false, '相乗りの分は記録しない')
  })
}

// Windows の Claude Code は tool_name=PowerShell で来る（fox、ドリリーの実物 2026-10-13）。Bash と同じく正規の入力として RTK へ渡し、テストは記録する
test('hook claude: PowerShell は正規の入力として RTK に渡す', { skip: !hasRtk && 'rtk が無い' }, () => {
  const raw = JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'git status' }, cwd: '/tmp', tool_use_id: 'toolu_ps' })
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: raw, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, spawnSync('rtk', ['hook', 'claude'], { input: raw, encoding: 'utf8' }).stdout)
  assert.match(r.stdout, /rtk git status/)
})

test('hook claude: PowerShell の dotnet test は記録する', () => {
  const log = join(mkdtempSync(join(tmpdir(), 'tg-')), 'l')
  const raw = JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'dotnet test Host.Tests' }, cwd: '/tmp', tool_use_id: 'toolu_ps2', session_id: 'sess_ps' })
  spawnSync('node', [bin, 'hook', 'claude'], { input: raw, encoding: 'utf8', env: { ...process.env, TESTGATE_LOG: log } })
  const row = JSON.parse(readFileSync(log, 'utf8').trim())
  assert.equal(row.tool, 'PowerShell'); assert.equal(row.runner, 'dotnet test'); assert.equal(row.id, 'toolu_ps2')
})

test('hook claude: tool_name が無い入力は従来どおり RTK に渡す', { skip: !hasRtk && 'rtk が無い' }, () => {
  const raw = JSON.stringify({ tool_input: { command: 'git status' }, cwd: '/tmp' })
  const r = spawnSync('node', [bin, 'hook', 'claude'], { input: raw, encoding: 'utf8' })
  assert.equal(r.stdout, spawnSync('rtk', ['hook', 'claude'], { input: raw, encoding: 'utf8' }).stdout)
})
