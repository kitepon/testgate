import { test } from 'node:test'
import assert from 'node:assert/strict'
import { splitWords, stripPrefix } from '../lib/shell-words.mjs'

test('語に分ける。glob は展開しない', () => {
  const r = splitWords('node --test test/*.test.mjs')
  assert.deepEqual(r.words, ['node', '--test', 'test/*.test.mjs'])
  assert.equal(r.compound, false)
})
test('引用符を外す', () => {
  assert.deepEqual(splitWords(`pytest -k "a and b" 'tests/x y.py'`).words, ['pytest', '-k', 'a and b', 'tests/x y.py'])
})
test('複合コマンドを見つける', () => {
  assert.equal(splitWords('cd app && npm test').compound, true)
  assert.equal(splitWords('pytest | tail').compound, true)
  assert.equal(splitWords('go test ./... 2>&1').compound, true)
  assert.equal(splitWords('echo $(ls)').compound, true)
})
test('環境変数と包みを外す', () => {
  const { argv, env } = stripPrefix(['CI=1', 'env', 'FOO=bar', 'time', 'pytest', '-q'])
  assert.deepEqual(argv, ['pytest', '-q'])
  assert.deepEqual(env, { CI: '1', FOO: 'bar' })
})
