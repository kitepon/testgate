// node --test の逆引き解決器の、細かい癖の試験。

import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { chosen, makeRepo, run } from './helpers.mjs'

const ALL = ['node', '--test', 'test/*.test.mjs']
const pkg = JSON.stringify({ type: 'module' })

test('書き方の違う import を全部たどる', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'src/reexport.mjs': "export * from './deep/value.mjs'\n",
    'src/deep/value.mjs': 'export const value = 1\n',
    'src/lazy.mjs': "export const load = () => import('./lazy-target.mjs')\n",
    'src/lazy-target.mjs': 'export default 1\n',
    'src/legacy.cjs': "const dep = require('./legacy-dep')\nmodule.exports = dep\n",
    'src/legacy-dep/index.js': 'module.exports = 1\n',
    'src/typed.ts': "import { helper } from './typed-helper.js'\nexport const typed = helper\n",
    'src/typed-helper.ts': 'export const helper = 1\n',
    'src/side.mjs': 'globalThis.side = 1\n',
    'src/multi.mjs': 'export const a = 1\nexport const b = 2\n',
    'data/table.csv': 'a,b\n',
    'test/reexport.test.mjs': "import { value } from '../src/reexport.mjs'\n",
    'test/lazy.test.mjs': "import { load } from '../src/lazy.mjs'\n",
    'test/legacy.test.mjs': "import legacy from '../src/legacy.cjs'\n",
    'test/typed.test.mjs': "import { typed } from '../src/typed.ts'\n",
    'test/side.test.mjs': "import '../src/side.mjs'\n",
    'test/multi.test.mjs': "import {\n  a,\n  b,\n} from '../src/multi.mjs'\n",
    'test/data.test.mjs': "import { join } from 'node:path'\nconst file = join(import.meta.dirname, '..', 'data', 'table.csv')\n",
    'test/alone.test.mjs': "import test from 'node:test'\n",
  })
  const cases = {
    'src/deep/value.mjs': 'test/reexport.test.mjs',
    'src/lazy-target.mjs': 'test/lazy.test.mjs',
    'src/legacy-dep/index.js': 'test/legacy.test.mjs',
    'src/typed-helper.ts': 'test/typed.test.mjs',
    'src/side.mjs': 'test/side.test.mjs',
    'src/multi.mjs': 'test/multi.test.mjs',
    'data/table.csv': 'test/data.test.mjs',
  }
  for (const [changed, expected] of Object.entries(cases)) {
    assert.deepEqual(chosen(await run(cwd, ALL, [changed])), [expected], changed)
  }
})

test('パッケージ名の import は追わず、循環していても止まる', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'node_modules/left/index.js': "module.exports = require('../../src/b.mjs')\n",
    'src/a.mjs': "import './b.mjs'\nimport left from 'left'\n",
    'src/b.mjs': "import './a.mjs'\n",
    'test/a.test.mjs': "import '../src/a.mjs'\n",
    'test/other.test.mjs': "import left from 'left'\n",
  })
  assert.deepEqual(chosen(await run(cwd, ALL, ['src/b.mjs'])), ['test/a.test.mjs'])
})

test('ディレクトリを指す new URL は、その下のどのファイルの変更にも当たる', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'src/server.mjs': "export const staticRoot = new URL('../web/', import.meta.url)\nexport const root = new URL('..', import.meta.url)\n",
    'web/app.css': 'body {}\n',
    'other/readme.txt': 'x\n',
    'test/server.test.mjs': "import '../src/server.mjs'\n",
    'test/alone.test.mjs': '\n',
  })
  assert.deepEqual(chosen(await run(cwd, ALL, ['web/app.css'])), ['test/server.test.mjs'])
  assert.deepEqual(chosen(await run(cwd, ALL, ['web/new-file.js'])), ['test/server.test.mjs'])
  // 自分を含むディレクトリ（リポジトリのルート）への参照は辺にしない。何を変えても当たってしまうから。
  assert.equal((await run(cwd, ALL, ['other/readme.txt'])).mode, 'none')
})

test('パスの形をした文字列が実在のファイルを指していれば辺にする', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'scripts/build.mjs': 'console.log(1)\n',
    'test/build.test.mjs': "import { spawnSync } from 'node:child_process'\nspawnSync('node', ['scripts/build.mjs'])\n",
    'test/alone.test.mjs': "const type = 'application/json'\n",
  })
  assert.deepEqual(chosen(await run(cwd, ALL, ['scripts/build.mjs'])), ['test/build.test.mjs'])
})

test('中身の分からない import() を持つテストは、たどれない変更があった時に足す', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'src/plugins.mjs': 'export const load = name => import(name)\n',
    'src/plugin-a.mjs': 'export default 1\n',
    'src/known.mjs': 'export default 1\n',
    'src/registry.mjs': "export class Registry {\n  require(id) {\n    return id\n  }\n  get(id) {\n    return this.require(id)\n  }\n}\n",
    'test/plugins.test.mjs': "import '../src/plugins.mjs'\n",
    'test/known.test.mjs': "import '../src/known.mjs'\n",
    'test/registry.test.mjs': "import '../src/registry.mjs'\n",
  })
  // どのテストからもたどれない plugin-a.mjs は、import(name) で読まれているかもしれない。
  const orphan = await run(cwd, ALL, ['src/plugin-a.mjs'])
  assert.deepEqual(chosen(orphan), ['test/plugins.test.mjs'])
  assert.match(orphan.reason, /動的 import/)
  // たどれる変更だけなら足さない。require という名前のメソッドは動的な読み込みと数えない。
  assert.deepEqual(chosen(await run(cwd, ALL, ['src/known.mjs'])), ['test/known.test.mjs'])
  // たどれない変更が文書なら足さない。
  assert.equal((await run(cwd, ALL, ['README.md'])).mode, 'none')
})

test('package.json の imports（#内部名）を解く', async t => {
  const cwd = makeRepo(t, {
    'package.json': JSON.stringify({ type: 'module', imports: { '#config': './src/config.mjs', '#lib/*': { default: './src/lib/*.mjs' } } }),
    'src/config.mjs': 'export default {}\n',
    'src/lib/math.mjs': 'export const add = (a, b) => a + b\n',
    'test/config.test.mjs': "import config from '#config'\n",
    'test/math.test.mjs': "import { add } from '#lib/math'\n",
    'test/alone.test.mjs': '\n',
  })
  assert.deepEqual(chosen(await run(cwd, ALL, ['src/config.mjs'])), ['test/config.test.mjs'])
  assert.deepEqual(chosen(await run(cwd, ALL, ['src/lib/math.mjs'])), ['test/math.test.mjs'])
})

test('--import などで先に読み込まれるファイルに変更が及べば full', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'test/setup.mjs': "import './setup-dep.mjs'\n",
    'test/setup-dep.mjs': 'globalThis.ready = true\n',
    '.env.test': 'A=1\n',
    'src/a.mjs': 'export default 1\n',
    'test/a.test.mjs': "import '../src/a.mjs'\n",
    'test/b.test.mjs': '\n',
  })
  const argv = ['node', '--import', './test/setup.mjs', '--env-file=.env.test', '--test', 'test/*.test.mjs']
  for (const changed of ['test/setup-dep.mjs', 'test/setup.mjs', '.env.test']) {
    const result = await run(cwd, argv, [changed])
    assert.equal(result.mode, 'full', changed)
    assert.deepEqual(result.argv, argv)
  }
  const subset = await run(cwd, argv, ['src/a.mjs'])
  assert.deepEqual(subset.argv, ['node', '--import', './test/setup.mjs', '--env-file=.env.test', '--test', 'test/a.test.mjs'])
})

test('リポジトリのルートと違う場所で打っても、changed はルートからの相対で読む', async t => {
  const root = makeRepo(t, {
    'packages/app/package.json': pkg,
    'packages/app/src/a.mjs': "import '../../shared/util.mjs'\n",
    'packages/shared/util.mjs': 'export default 1\n',
    'packages/app/test/a.test.mjs': "import '../src/a.mjs'\n",
    'packages/app/test/b.test.mjs': '\n',
  })
  const cwd = join(root, 'packages/app')
  const result = await run(cwd, ALL, ['packages/shared/util.mjs'])
  assert.deepEqual(result.argv, ['node', '--test', 'test/a.test.mjs'])
  // 未追跡のディレクトリは「dir/」の形で届くことがある。
  assert.deepEqual(chosen(await run(cwd, ALL, ['packages/shared/'])), ['test/a.test.mjs'])
})

test('glob に合うテストが無い時と、選んだ名前を並べて渡せない時は選ばない', async t => {
  const cwd = makeRepo(t, {
    'package.json': pkg,
    'src/a.mjs': 'export default 1\n',
    'test/[id].test.mjs': "import '../src/a.mjs'\n",
    'test/b.test.mjs': '\n',
  })
  const none = await run(cwd, ['node', '--test', 'spec/*.test.mjs'], ['src/a.mjs'])
  assert.equal(none.mode, 'passthrough')
  // [id] は node が glob として読んでしまうので、名前を並べずに元の argv で全部流す。
  const magic = await run(cwd, ALL, ['src/a.mjs'])
  assert.equal(magic.mode, 'full')
  assert.deepEqual(magic.argv, ALL)
})
