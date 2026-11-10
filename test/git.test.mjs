import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
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

import { testedState } from '../lib/git.mjs'
function stateRepo() {
  const dir = tmp('tg-state-')
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  writeFileSync(join(dir, 'a.txt'), 'a'); writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return dir
}
test('testedState: 同じ状態は同じ treeHash、未commitの中身が変われば変わり、戻せば元に戻る', () => {
  const dir = stateRepo()
  const clean = testedState(dir)
  assert.match(clean.testedCommit, /^[0-9a-f]{40}$/)
  assert.match(clean.treeHash, /^[0-9a-f]{64}$/)
  assert.deepEqual(testedState(dir), clean)
  writeFileSync(join(dir, 'a.txt'), 'changed')
  const dirty = testedState(dir)
  assert.equal(dirty.testedCommit, clean.testedCommit)
  assert.notEqual(dirty.treeHash, clean.treeHash)
  writeFileSync(join(dir, 'a.txt'), 'changed again')
  assert.notEqual(testedState(dir).treeHash, dirty.treeHash)
  writeFileSync(join(dir, 'a.txt'), 'a')
  assert.equal(testedState(dir).treeHash, clean.treeHash)
})
test('testedState: 未追跡ファイルの中身は指紋に入り、.gitignore された物は入らない', () => {
  const dir = stateRepo()
  const clean = testedState(dir).treeHash
  writeFileSync(join(dir, 'new.txt'), 'one')
  const one = testedState(dir).treeHash
  assert.notEqual(one, clean)
  writeFileSync(join(dir, 'new.txt'), 'two')
  assert.notEqual(testedState(dir).treeHash, one)
  rmSync(join(dir, 'new.txt'))
  mkdirSync(join(dir, 'ignored')); writeFileSync(join(dir, 'ignored', 'x'), 'x')
  assert.equal(testedState(dir).treeHash, clean)
})
test('testedState: git の外・初回commit前は null、上限を超える未追跡は treeHash だけ null', () => {
  assert.deepEqual(testedState(tmp('tg-nogit-')), { testedCommit: null, treeHash: null })
  const empty = tmp('tg-nohead-'); spawnSync('git', ['init', '-q'], { cwd: empty })
  assert.deepEqual(testedState(empty), { testedCommit: null, treeHash: null })
  const dir = stateRepo()
  for (let i = 0; i < 2001; i++) writeFileSync(join(dir, `f${i}`), '')
  const over = testedState(dir)
  assert.match(over.testedCommit, /^[0-9a-f]{40}$/)
  assert.equal(over.treeHash, null)
})
