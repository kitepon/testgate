import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, utimesSync, rmSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmp } from './tmp.mjs'
import { withRunTmp } from '../lib/prune/tmp-root.mjs'

const KEYS = ['TMPDIR', 'TMP', 'TEMP']

test('withRunTmp: SIGKILL で殺された子の一時物も、根ごと消える', async () => {
  const base = tmp('tg-roottest-')
  let root, dir
  await withRunTmp(async r => {
    root = r
    const src = `const fs=require('fs'),os=require('os'),path=require('path');const d=fs.mkdtempSync(path.join(os.tmpdir(),'tg-x-'));fs.writeFileSync(path.join(d,'f'),'x');console.log(d);setInterval(()=>{},1000)`
    const c = spawn(process.execPath, ['-e', src], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'inherit'] })
    dir = await new Promise((res, rej) => { c.stdout.once('data', b => res(String(b).trim())); c.once('error', rej) })
    assert.ok(dir.startsWith(root + sep), `根の下ではない: ${dir} / ${root}`)
    assert.ok(existsSync(join(dir, 'f')))
    const exited = new Promise(res => c.once('exit', res))
    c.kill('SIGKILL'); await exited
    assert.ok(existsSync(dir), 'SIGKILL では子は消せない（これが穴）')
  }, { tmpdir: base })
  assert.equal(existsSync(root), false)
  assert.equal(existsSync(dir), false)
})

test('withRunTmp: 例外でも根が消え、env が元に戻る', async () => {
  const base = tmp('tg-roottest-')
  const before = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  let root
  await assert.rejects(withRunTmp(async r => {
    root = r
    for (const k of KEYS) assert.equal(process.env[k], r)
    throw new Error('boom')
  }, { tmpdir: base }), /boom/)
  assert.equal(existsSync(root), false)
  for (const k of KEYS) assert.equal(process.env[k], before[k], k)
})

test('withRunTmp: env が元から無い物は無いまま戻る', async () => {
  const base = tmp('tg-roottest-')
  const saved = process.env.TEMP
  delete process.env.TEMP
  try {
    await withRunTmp(async () => {}, { tmpdir: base })
    assert.equal('TEMP' in process.env, false)
  } finally { if (saved !== undefined) process.env.TEMP = saved }
})

test('withRunTmp: 古い tg-run-* は掃き、新しい物と他の名前は残す', async () => {
  const base = tmp('tg-roottest-')
  const old = mkdtempSync(join(base, 'tg-run-')), fresh = mkdtempSync(join(base, 'tg-run-')), other = mkdtempSync(join(base, 'tg-other-'))
  mkdirSync(join(old, 'sub')); writeFileSync(join(old, 'sub', 'f'), '1')
  const t = new Date(Date.now() - 2 * 24 * 3600 * 1000)
  utimesSync(old, t, t); utimesSync(other, t, t)
  await withRunTmp(async () => {}, { tmpdir: base })
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true)
  assert.equal(existsSync(other), true)
})

test('withRunTmp: fn の戻り値を返す', async () => {
  const base = tmp('tg-roottest-')
  assert.equal(await withRunTmp(async () => 42, { tmpdir: base }), 42)
})
