import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmp } from './tmp.mjs'

const helper = new URL('./tmp.mjs', import.meta.url).href

// 別プロセスで tmp() を使い、終わり方ごとに一時物が消えている事を確かめる
function child(tail) {
  const src = `import { tmp } from ${JSON.stringify(helper)}\nimport { writeFileSync, mkdirSync } from 'node:fs'\nimport { join } from 'node:path'\nconst d = tmp('tg-tmptest-')\nmkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'f'), 'x')\nconsole.log(d)\n${tail}\n`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { encoding: 'utf8' })
  return { dir: r.stdout.trim().split('\n')[0], status: r.status }
}

test('tmp: 普通に終わる・process.exit・未捕捉の例外、どれでも一時物が消える', () => {
  for (const [tail, status] of [['', 0], ['process.exit(3)', 3], ['throw new Error("x")', 1]]) {
    const { dir, status: st } = child(tail)
    assert.match(dir, /tg-tmptest-/)
    assert.equal(st, status, tail)
    assert.equal(existsSync(dir), false, `残っている: ${dir} (${tail || '通常終了'})`)
  }
})

test('tmp: 返す場所は書けて、同じプロセス内では残っている', () => {
  const d = tmp('tg-tmptest-')
  mkdirSync(join(d, 'a')); writeFileSync(join(d, 'a', 'f'), '1')
  assert.ok(existsSync(join(d, 'a', 'f')))
})
