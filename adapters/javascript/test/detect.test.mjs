import test from 'node:test'
import assert from 'node:assert/strict'
import { detect, id, runners } from '../adapter.mjs'
import { copyFixture, makeRepo } from './helpers.mjs'

const words = command => command.split(' ')

test('アダプタ名は小文字英字で、三つのランナーを名乗る', () => {
  assert.match(id, /^[a-z]+$/)
  assert.deepEqual(runners, ['jest', 'vitest', 'node --test'])
})

test('ランナーを直接呼ぶ形を拾う', () => {
  const cwd = process.cwd()
  for (const command of [
    'node --test',
    'node --test test/*.test.mjs',
    'node --experimental-test-coverage --test --test-reporter spec test/',
    'NODE_ENV=test node --test',
    'jest',
    'npx jest --ci',
    'npx --no-install jest@29 src',
    './node_modules/.bin/jest',
    'node --experimental-vm-modules node_modules/jest/bin/jest.js',
    'pnpm exec jest',
    'yarn jest',
    'yarn run jest --ci',
    'pnpm vitest run',
    'vitest',
    'npx vitest run',
    'pnpm dlx vitest run',
    'bunx vitest run',
    'node node_modules/vitest/vitest.mjs run',
    'rtk jest',
    'rtk vitest run',
    'rtk test node --test test/*.test.mjs',
    'cross-env CI=1 npx vitest run',
  ]) {
    assert.equal(detect(words(command), { cwd, env: {} }), true, command)
  }
})

test('ランナーでないコマンドと、テストを走らせない呼び方は拾わない', () => {
  const cwd = process.cwd()
  for (const command of [
    'ls',
    'git status',
    'node',
    'node --version',
    'node server.mjs --test',
    'node --test --help',
    'node -e 1',
    'npx jest --version',
    'npx jest --help',
    'npx jest --listTests',
    'npx jest --showConfig',
    'npx jest --clearCache',
    'npx vitest --version',
    'npx vitest list',
    'npx vitest bench',
    'npx vitest init browser',
    'npx eslint .',
    'npx -c jest',
    'bun test',
    'rtk git status',
  ]) {
    assert.equal(detect(words(command), { cwd, env: {} }), false, command)
  }
  assert.equal(detect([], { cwd, env: {} }), false)
  assert.equal(detect(undefined, { cwd, env: {} }), false)
})

test('パッケージスクリプト経由は、script が受け持ちのランナーを呼ぶ時だけ拾う', t => {
  const node = copyFixture(t, 'node-repo')
  const jest = copyFixture(t, 'jest-repo')
  const vitest = copyFixture(t, 'vitest-repo')
  for (const cwd of [node, jest, vitest]) {
    for (const command of ['npm test', 'npm t', 'npm run test', 'npm --silent test', 'pnpm test', 'pnpm run test', 'yarn test', 'yarn run test', 'bun run test', 'node --run test']) {
      assert.equal(detect(words(command), { cwd, env: {} }), true, `${command} in ${cwd}`)
    }
    assert.equal(detect(words('npm run build'), { cwd, env: {} }), false)
    assert.equal(detect(words('npm --prefix elsewhere test'), { cwd, env: {} }), false)
    assert.equal(detect(words('pnpm -r test'), { cwd, env: {} }), false)
    assert.equal(detect(words('npm install'), { cwd, env: {} }), false)
  }

  const other = makeRepo(t, {
    'package.json': JSON.stringify({ scripts: { test: 'mocha', lint: 'eslint .', 'test:unit': 'jest --ci', check: 'npm run lint && jest' } }),
  })
  assert.equal(detect(words('npm test'), { cwd: other, env: {} }), false, '別のランナー（mocha）は受け持ちではない')
  assert.equal(detect(words('npm run lint'), { cwd: other, env: {} }), false)
  assert.equal(detect(words('npm run test:unit'), { cwd: other, env: {} }), true, 'test 以外の名前の script も中身で判断する')
  assert.equal(detect(words('npm run check'), { cwd: other, env: {} }), true, '複合でもランナーの名前が見えればテストの実行として拾う')
})
