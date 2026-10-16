import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { changedFiles } from '../lib/git.mjs'
import { extractCommand } from '../lib/harness.mjs'
import { tmp } from './tmp.mjs'

test('未追跡が 1MB を超えても変更一覧が欠けない', () => {
  const dir = tmp('tg-big-')
  spawnSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'tracked.txt'), 'x')
  spawnSync('git', ['add', '-A'], { cwd: dir }); spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'i'], { cwd: dir })
  mkdirSync(join(dir, 'u'))
  const n = 12000 // 約 1.2MB 分のファイル名
  for (let i = 0; i < n; i++) writeFileSync(join(dir, 'u', `untracked-file-with-a-rather-long-name-to-fill-the-buffer-${String(i).padStart(6, '0')}.txt`), '')
  const g = changedFiles(dir, null)
  assert.equal(g.error, undefined)
  assert.equal(g.changed.length, n)
})

test('git が無い所では null、失敗は error 付きで返り、空配列にはしない', () => {
  const dir = tmp('tg-nogit-')
  assert.equal(changedFiles(dir, null), null)
})

test('Cursor の空の cwd は無い物として扱い、id は道具呼び出しごとではないので入れない', () => {
  const e = extractCommand('cursor', { command: 'npm test', cwd: '', workspace_roots: ['/w'], conversation_id: 'c1', generation_id: 'c1' })
  assert.equal(e.cwd, '/w'); assert.equal(e.id, null); assert.equal(e.session, 'c1')
  assert.equal(extractCommand('claude', { tool_input: { command: 'ls' }, cwd: '' }).cwd, undefined)
})
