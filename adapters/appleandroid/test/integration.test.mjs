// 実ランナーで確かめる試験。既定では飛ばす（JDK・Gradle の取得に網が要り、swift の道具も要る）。
//   TESTGATE_REAL_RUNNERS=1 JAVA_HOME=... node --test test/integration.test.mjs
// swift は PATH に swift があれば走らせる。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { select, parseOutput } from '../adapter.mjs'
import { tempRepo } from './helpers.mjs'

const on = process.env.TESTGATE_REAL_RUNNERS === '1'
const have = (cmd, args = ['--version']) => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0

test('gradle: 選んだ argv を実際に流すと、選んだモジュールのテストだけが走る', { skip: !on || !process.env.JAVA_HOME }, async () => {
  const r = tempRepo('gradle-multi')
  try {
    const changed = ['util/src/main/java/demo/util/Strings.java']
    const s = await select({ argv: ['./gradlew', 'test', '--console=plain'], cwd: r.dir, env: process.env, changed, base: null, full: false })
    assert.equal(s.mode, 'subset')
    const p = spawnSync(path_join(r.dir, 'gradlew'), s.argv.slice(1), {
      cwd: r.dir, encoding: 'utf8', env: { ...process.env, GRADLE_OPTS: '-Dorg.gradle.daemon=false' }
    })
    const text = p.stdout + p.stderr
    assert.equal(p.status, 0, text)
    assert.match(text, /> Task :util:test/)
    assert.doesNotMatch(text, /> Task :core:test/)
    assert.doesNotMatch(text, /> Task :app:test/)
    // select が足した -I の init script で、成功した件数も出る
    const o = parseOutput(text)
    assert.deepEqual([o.passed, o.failed, o.skipped], [1, 0, 0])
  } finally { r.cleanup() }
})

test('swift: swift test の実出力を読める', { skip: !on || !have('swift') }, () => {
  const r = tempRepo('swift-multi')
  try {
    const p = spawnSync('swift', ['test'], { cwd: r.dir, encoding: 'utf8' })
    assert.equal(p.status, 0, p.stdout + p.stderr)
    const o = parseOutput(p.stdout + p.stderr)
    assert.deepEqual([o.passed, o.failed, o.skipped], [5, 0, 0])
  } finally { r.cleanup() }
})

function path_join(a, b) { return a.replace(/\/$/, '') + '/' + b }
