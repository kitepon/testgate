import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../bin/testgate.mjs', import.meta.url))
const adapters = fileURLToPath(new URL('./fixtures/mock-adapter', import.meta.url))

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-repo-'))
  writeFileSync(join(dir, 'mocktest.mjs'), `const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only')+1] : null\nconsole.log('running', only ?? 'all')\nconsole.log(only ? '1 ok, 0 ng' : '3 ok, 0 ng')\n`)
  writeFileSync(join(dir, 'a.txt'), 'a'); writeFileSync(join(dir, 'b.txt'), 'b')
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' })
  g('init', '-q'); g('add', '-A'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
  return dir
}
function run(dir, env, ...cmd) {
  return spawnSync('node', [bin, 'run', '--cwd', dir, '--', ...cmd], { encoding: 'utf8', env: { ...process.env, TESTGATE_ADAPTERS: adapters, TESTGATE_LOG: join(dir, 'log.jsonl'), XDG_STATE_HOME: join(dir, 'state'), ...env } })
}
const rows = dir => readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)

test('変更なし・基準なし → 一度全部流して基準を作り、次は流さない', () => {
  const dir = repo()
  // 記録と状態はリポジトリの外に置く（中に置くと未追跡ファイルとして「変更」に数えられる）
  const out = mkdtempSync(join(tmpdir(), 'tg-out-'))
  const env = { TESTGATE_LOG: join(out, 'log.jsonl'), XDG_STATE_HOME: join(out, 'state') }
  const rows = () => readFileSync(join(out, 'log.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const r = run(dir, env, 'node', 'mocktest.mjs')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /running all/)
  assert.match(r.stdout, /基準を作る/)
  assert.equal(Object.keys(JSON.parse(readFileSync(join(out, 'state.json'), 'utf8')).lastFullPass).length, 1)
  const r2 = run(dir, env, 'node', 'mocktest.mjs')
  assert.match(r2.stdout, /流さない/)
  assert.equal(rows().at(-1).event, 'none')
})
test('基準作りの全部流しには時間上限を掛けない', () => {
  const dir = repo()
  writeFileSync(join(dir, 'mocktest.mjs'), `setTimeout(() => console.log('3 ok, 0 ng'), 1500)`)
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'slow'], { cwd: dir })
  const r = run(dir, { TESTGATE_FULL_LIMIT_SEC: '1' }, 'node', 'mocktest.mjs')
  assert.equal(r.status, 0)
  assert.doesNotMatch(r.stdout, /秒を超えた/)
})
test('a.txt を変更 → subset で実行、合計行は落ち、件数は記録に残る', () => {
  const dir = repo()
  writeFileSync(join(dir, 'a.txt'), 'changed')
  const r = run(dir, {}, 'node', 'mocktest.mjs')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /running a/)
  assert.doesNotMatch(r.stdout, /\d+ ok, \d+ ng/)
  assert.match(r.stdout, /変更に関わる分だけ流した/)
  const last = rows(dir).at(-1)
  assert.equal(last.mode, 'subset'); assert.equal(last.passed, 1); assert.equal(last.failed, 0)
})
test('TESTGATE_FULL=1 → 全部流し、通れば最後の全部通過を記録し、次は base との差分になる', () => {
  const dir = repo()
  writeFileSync(join(dir, 'b.txt'), 'changed')
  const r = run(dir, { TESTGATE_FULL: '1' }, 'node', 'mocktest.mjs')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /running all/)
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.equal(Object.keys(state.lastFullPass).length, 1)
  // commit して base を進めると、未変更なら none
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'x'], { cwd: dir })
  const r2 = run(dir, {}, 'node', 'mocktest.mjs')
  assert.match(r2.stdout, /running all|流さない/) // base は前の HEAD なので b.txt は変更扱い → full
  assert.equal(rows(dir).at(-1).base !== null || rows(dir).at(-1).event === 'none', true)
})
test('全部流しの時間上限', () => {
  const dir = repo()
  writeFileSync(join(dir, 'mocktest.mjs'), `setTimeout(() => console.log('3 ok, 0 ng'), 5000)`)
  const r = run(dir, { TESTGATE_FULL: '1', TESTGATE_FULL_LIMIT_SEC: '1' }, 'node', 'mocktest.mjs')
  assert.equal(r.status, 124)
  assert.match(r.stdout, /秒を超えたので止めた/)
})
test('テストコマンドでなければ実行せず終わる', () => {
  const dir = repo()
  const r = run(dir, {}, 'node', '-e', 'console.log(1)')
  assert.match(r.stdout, /テストコマンドではない/)
})
test('基準なし・未追跡の資料だけ → none ではなく一度全部流して基準を作る。基準が出来たら次は流さない', () => {
  const dir = repo()
  const out = mkdtempSync(join(tmpdir(), 'tg-out-'))
  const env = { TESTGATE_LOG: join(out, 'log.jsonl'), XDG_STATE_HOME: join(out, 'state') }
  writeFileSync(join(dir, 'notes.md'), 'untracked')
  const r = run(dir, env, 'node', 'mocktest.mjs')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /running all/)
  assert.match(r.stdout, /変更に関わるテストも無いので一度全部流して基準を作る/)
  assert.equal(Object.keys(JSON.parse(readFileSync(join(out, 'state.json'), 'utf8')).lastFullPass).length, 1)
  const r2 = run(dir, env, 'node', 'mocktest.mjs')
  assert.match(r2.stdout, /流さない/)
})
test('基準作りの全部流しが失敗 → 基準は作らず、次も全部流す', () => {
  const dir = repo()
  const out = mkdtempSync(join(tmpdir(), 'tg-out-'))
  const env = { TESTGATE_LOG: join(out, 'log.jsonl'), XDG_STATE_HOME: join(out, 'state') }
  writeFileSync(join(dir, 'mocktest.mjs'), `console.log('2 ok, 1 ng'); process.exit(1)`)
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'red'], { cwd: dir })
  const r = run(dir, env, 'node', 'mocktest.mjs')
  assert.equal(r.status, 1)
  assert.match(r.stdout, /基準は作らない/)
  assert.equal(existsSync(join(out, 'state.json')), false)
  const r2 = run(dir, env, 'node', 'mocktest.mjs')
  assert.equal(r2.status, 1)
  assert.match(r2.stdout, /基準を作る/)
})
