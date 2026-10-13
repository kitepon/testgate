import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { chosen, copyFixture, makeRepo, run } from './helpers.mjs'

const ALL = ['node', '--test', 'test/*.test.mjs']

test('1ファイル変更は subset で、関わるテストを含み、独立したテストを含まない', async t => {
  const cwd = copyFixture(t, 'node-repo')
  const result = await run(cwd, ALL, ['src/tax.mjs'])
  assert.equal(result.mode, 'subset')
  // price.mjs は tax.mjs を import しているので、price のテストも関わる。
  assert.deepEqual(result.argv, ['node', '--test', 'test/price.test.mjs', 'test/tax.test.mjs'])
  assert.ok(!result.argv.includes('test/slug.test.mjs'), '独立した slug のテストは含まない')
  assert.match(result.reason, /^node --test: /)
})

test('import 以外の参照もたどる（JSON、CommonJS の拡張子省略、new URL で読むファイル、ヘルパー）', async t => {
  const cwd = copyFixture(t, 'node-repo')
  const cases = {
    'src/rates.json': ['test/price.test.mjs', 'test/tax.test.mjs'],
    'src/slug-table.json': ['test/slug.test.mjs'],
    'templates/hello.txt': ['test/greeting.test.mjs'],
    'test/helpers/cart.mjs': ['test/price.test.mjs'],
    'test/slug.test.mjs': ['test/slug.test.mjs'],
  }
  for (const [changed, expected] of Object.entries(cases)) {
    const result = await run(cwd, ALL, [changed])
    assert.equal(result.mode, 'subset', changed)
    assert.deepEqual(chosen(result), expected, changed)
  }
})

test('変更なしは none、full: true は元の argv、変更が関わらなければ none', async t => {
  const cwd = copyFixture(t, 'node-repo')
  assert.equal((await run(cwd, ALL, [])).mode, 'none')

  const full = await run(cwd, ALL, ['src/tax.mjs'], { full: true })
  assert.equal(full.mode, 'full')
  assert.deepEqual(full.argv, ALL)

  // 名指しの実行でも、変更が無ければ none。
  assert.equal((await run(cwd, ['node', '--test', 'test/tax.test.mjs'], [])).mode, 'none')
  assert.equal((await run(cwd, ALL, ['docs/notes.md'])).mode, 'none')
})

test('全体に効くファイルと、全部のテストに関わる変更は full で元の argv', async t => {
  const cwd = copyFixture(t, 'node-repo')
  for (const changed of [['package.json'], ['package-lock.json'], ['node_modules/'], ['src/tax.mjs', 'src/slug.cjs', 'templates/hello.txt']]) {
    const result = await run(cwd, ALL, changed)
    assert.equal(result.mode, 'full', changed.join(','))
    assert.deepEqual(result.argv, ALL)
  }
})

test('人が範囲を絞っている時と監視モードは passthrough', async t => {
  const cwd = copyFixture(t, 'node-repo')
  for (const argv of [
    ['node', '--test', 'test/tax.test.mjs'],
    ['node', '--test', 'test/tax.test.mjs', 'test/*.test.mjs'],
    ['node', '--test', '--test-name-pattern', '税', 'test/*.test.mjs'],
    ['node', '--test', '--test-only', 'test/*.test.mjs'],
    ['node', '--test', '--watch', 'test/*.test.mjs'],
  ]) {
    const result = await run(cwd, argv, ['src/slug.cjs'])
    assert.equal(result.mode, 'passthrough', argv.join(' '))
    assert.deepEqual(result.argv, argv)
  }
})

test('引数なしとディレクトリ指定は node の名前規則で候補を出し、オプションは残す', async t => {
  const cwd = copyFixture(t, 'node-repo')
  // CommonJS のテスト（legacy.test.cjs）は glob には入らず、既定の探索には入る。
  const bare = await run(cwd, ['node', '--test'], ['src/slug.cjs'])
  assert.deepEqual(bare.argv, ['node', '--test', 'test/legacy.test.cjs', 'test/slug.test.mjs'])

  const dir = await run(cwd, ['node', '--test-reporter', 'dot', '--test', 'test/'], ['src/slug.cjs'])
  assert.equal(dir.mode, 'subset')
  assert.deepEqual(dir.argv, ['node', '--test-reporter', 'dot', '--test', 'test/legacy.test.cjs', 'test/slug.test.mjs'])

  const braces = await run(cwd, ['env', 'TZ=UTC', 'node', '--test', 'test/**/*.test.{mjs,cjs}'], ['src/tax.mjs'])
  assert.deepEqual(braces.argv, ['env', 'TZ=UTC', 'node', '--test', 'test/price.test.mjs', 'test/tax.test.mjs'])
})

test('npm test は、同じ動きになる時だけ直接の呼び出しへ書き換える', async t => {
  const cwd = copyFixture(t, 'node-repo')
  const result = await run(cwd, ['npm', 'test'], ['src/price.mjs'])
  assert.equal(result.mode, 'subset')
  assert.deepEqual(result.argv, ['node', '--test', 'test/price.test.mjs'])
  assert.match(result.reason, /書き換えた/)

  // 追加の引数、package.json と違う場所からの実行は触らない。
  assert.equal((await run(cwd, ['npm', 'test', '--', '--test-reporter=dot'], ['src/price.mjs'])).mode, 'passthrough')
  assert.equal((await run(join(cwd, 'src'), ['npm', 'test'], ['src/price.mjs'])).mode, 'passthrough')

  const scripts = body => JSON.stringify({ type: 'module', scripts: body })
  const files = { 'src/a.mjs': 'export const a = 1\n', 'test/a.test.mjs': "import '../src/a.mjs'\n", 'test/b.test.mjs': '\n' }
  for (const [label, body] of Object.entries({
    'pretest がある': { pretest: 'node build.mjs', test: 'node --test test/*.test.mjs' },
    'posttest がある': { test: 'node --test test/*.test.mjs', posttest: 'node clean.mjs' },
    '複合コマンド': { test: 'node build.mjs && node --test test/*.test.mjs' },
    '環境変数を設定している': { test: 'NODE_ENV=test node --test test/*.test.mjs' },
  })) {
    const repo = makeRepo(t, { ...files, 'package.json': scripts(body) })
    const blocked = await run(repo, ['npm', 'test'], ['src/a.mjs'])
    assert.equal(blocked.mode, 'passthrough', label)
    assert.deepEqual(blocked.argv, ['npm', 'test'], label)
  }

  // node --run は pre/post を走らせないので、書いてあっても選ぶ。
  const repo = makeRepo(t, { ...files, 'package.json': scripts({ pretest: 'node build.mjs', test: 'node --test test/*.test.mjs' }) })
  assert.deepEqual((await run(repo, ['node', '--run', 'test'], ['src/a.mjs'])).argv, ['node', '--test', 'test/a.test.mjs'])
})

test('消えたファイルは、消える前の経路を参照していたテストを選ぶ', async t => {
  const cwd = copyFixture(t, 'node-repo')
  rmSync(join(cwd, 'src/tax.mjs'))
  assert.deepEqual(chosen(await run(cwd, ALL, ['src/tax.mjs'])), ['test/price.test.mjs', 'test/tax.test.mjs'])
  // 拡張子を省いて require していた物（./slug-table → slug-table.json）。
  rmSync(join(cwd, 'src/slug-table.json'))
  assert.deepEqual(chosen(await run(cwd, ALL, ['src/slug-table.json'])), ['test/slug.test.mjs'])
  // 誰も参照していなかったファイルが消えても、流す物は無い。
  assert.equal((await run(cwd, ALL, ['src/never-existed.mjs'])).mode, 'none')
})
