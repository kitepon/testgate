import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { detect } from '../adapter.mjs'
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

test('script 本文のファイル名は入口の定義で、候補として扱う（利用者の名指しは今までどおり触らない）', async t => {
  const files = {
    'scripts/env.mjs': '\n',
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 1\n',
    'scripts/release.test.mjs': "import '../src/b.mjs'\n",
    'pi5/__tests__/a.test.js': "require('../../src/a.mjs')\n",
    'pi5/__tests__/c.test.js': '\n',
  }
  const scripts = body => JSON.stringify({ type: 'module', scripts: body })
  const dev = 'node --test --import ./scripts/env.mjs scripts/release.test.mjs "pi5/__tests__/*.test.js"'
  const repo = makeRepo(t, { ...files, 'package.json': scripts({ 'test:dev': dev, 'test:gone': 'node --test scripts/missing.test.mjs pi5/__tests__/*.test.js' }) })

  const b = await run(repo, ['npm', 'run', 'test:dev'], ['src/b.mjs'])
  assert.equal(b.mode, 'subset')
  assert.deepEqual(b.argv, ['node', '--test', '--import', './scripts/env.mjs', 'scripts/release.test.mjs'])
  const a = await run(repo, ['npm', 'run', 'test:dev'], ['src/a.mjs'])
  assert.deepEqual(a.argv, ['node', '--test', '--import', './scripts/env.mjs', 'pi5/__tests__/a.test.js'])
  assert.equal((await run(repo, ['npm', 'run', 'test:dev'], ['scripts/env.mjs'])).mode, 'full', '前読みファイルの変更は full')
  assert.equal((await run(repo, ['npm', 'run', 'test:dev'], ['docs/notes.md'])).mode, 'none')

  // 利用者が argv で名指しした時、script が見つからないファイルを書いている時は今までどおり触らない。
  assert.equal((await run(repo, ['node', '--test', 'scripts/release.test.mjs'], ['src/b.mjs'])).mode, 'passthrough')
  assert.equal((await run(repo, ['npm', 'run', 'test:dev', '--', 'scripts/release.test.mjs'], ['src/b.mjs'])).mode, 'passthrough')
  const gone = await run(repo, ['npm', 'run', 'test:gone'], ['src/b.mjs'])
  assert.equal(gone.mode, 'passthrough')
  assert.match(gone.reason, /scripts\/missing\.test\.mjs/)
})

test('package.json で宣言されたラッパは透過で、node <ラッパ> --test の残りを node として読む', async t => {
  const wrapper = "import '../test/env.mjs'\n"
  const files = {
    'scripts/wrap.mjs': wrapper,
    'test/env.mjs': '\n',
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 1\n',
    'test/a.test.mjs': "import '../src/a.mjs'\n",
    'test/b.test.mjs': "import '../src/b.mjs'\n",
  }
  const manifest = testgate => JSON.stringify({ type: 'module', testgate, scripts: { 'test:dev': 'node scripts/wrap.mjs --test test/*.test.mjs' } })
  const declared = { wrappers: { 'scripts/wrap.mjs': {} } }
  const repo = makeRepo(t, { ...files, 'package.json': manifest(declared) })
  const direct = ['node', 'scripts/wrap.mjs', '--test', 'test/*.test.mjs']

  const subset = await run(repo, direct, ['src/a.mjs'])
  assert.equal(subset.mode, 'subset')
  assert.deepEqual(subset.argv, ['node', 'scripts/wrap.mjs', '--test', 'test/a.test.mjs'])
  assert.deepEqual((await run(repo, ['npm', 'run', 'test:dev'], ['src/b.mjs'])).argv, ['node', 'scripts/wrap.mjs', '--test', 'test/b.test.mjs'])
  assert.equal((await run(repo, direct, ['docs/notes.md'])).mode, 'none')

  // ラッパ本体と、ラッパが読むファイルの変更は全部に効く。
  for (const changed of ['scripts/wrap.mjs', 'test/env.mjs']) assert.equal((await run(repo, direct, [changed])).mode, 'full', changed)

  // import に現れない前読みファイルは preload で宣言する。
  const hidden = makeRepo(t, { ...files, 'scripts/wrap.mjs': '\n', 'package.json': manifest({ wrappers: { 'scripts/wrap.mjs': { preload: ['test/env.mjs'] } } }) })
  assert.equal((await run(hidden, direct, ['test/env.mjs'])).mode, 'full')
  assert.equal((await run(hidden, direct, ['src/a.mjs'])).mode, 'subset')

  // 宣言が無い、別のラッパ、利用者の名指し、ラッパの前のオプション、--test でない呼び方は今までどおり触らない。
  for (const [cwd, argv] of [
    [makeRepo(t, { ...files, 'package.json': manifest(undefined) }), direct],
    [makeRepo(t, { ...files, 'package.json': manifest({ wrappers: { 'scripts/other.mjs': {} } }) }), direct],
    [repo, ['node', 'scripts/wrap.mjs', '--test', 'test/a.test.mjs']],
    [repo, ['node', '--import', './test/env.mjs', 'scripts/wrap.mjs', '--test', 'test/*.test.mjs']],
  ]) {
    const result = await run(cwd, argv, ['src/a.mjs'])
    assert.equal(result.mode, 'passthrough', argv.join(' '))
    assert.deepEqual(result.argv, argv)
  }
  assert.equal(detect(['node', 'scripts/wrap.mjs', 'build'], { cwd: repo }), false)
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
