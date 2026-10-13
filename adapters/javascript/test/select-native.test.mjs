// Jest と Vitest。選ぶのはランナー自身なので、ここでは足すオプションと mode を確かめる。
// 実際に関わるテストだけが流れることは fixtures/verify-runners.mjs が実ランナーで確かめる。

import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { copyFixture, run } from './helpers.mjs'

const BASE = '3f2c1ab'

test('Jest: 1ファイル変更は subset で --changedSince を足す。base が無ければ --onlyChanged', async t => {
  const cwd = copyFixture(t, 'jest-repo')
  const since = await run(cwd, ['npx', 'jest'], ['src/tax.js'], { base: BASE })
  assert.equal(since.mode, 'subset')
  assert.deepEqual(since.argv, ['npx', 'jest', `--changedSince=${BASE}`])
  assert.match(since.reason, /^jest: /)

  const head = await run(cwd, ['npx', 'jest', '--ci'], ['src/tax.js'])
  assert.deepEqual(head.argv, ['npx', 'jest', '--ci', '--onlyChanged'])
})

test('Vitest: 1ファイル変更は subset で --changed を足す。base が無ければ値なしの --changed', async t => {
  const cwd = copyFixture(t, 'vitest-repo')
  const since = await run(cwd, ['npx', 'vitest', 'run'], ['src/tax.js'], { base: BASE })
  assert.equal(since.mode, 'subset')
  assert.deepEqual(since.argv, ['npx', 'vitest', 'run', `--changed=${BASE}`])
  assert.match(since.reason, /^vitest: /)

  const head = await run(cwd, ['npx', 'vitest', 'run', '--reporter', 'dot'], ['src/tax.js'])
  assert.deepEqual(head.argv, ['npx', 'vitest', 'run', '--reporter', 'dot', '--changed'])
})

test('変更なしは none、full: true は元の argv、文書だけの変更は none', async t => {
  for (const [fixture, argv] of [['jest-repo', ['npx', 'jest']], ['vitest-repo', ['npx', 'vitest', 'run']]]) {
    const cwd = copyFixture(t, fixture)
    assert.equal((await run(cwd, argv, [], { base: BASE })).mode, 'none', fixture)
    const full = await run(cwd, argv, ['src/tax.js'], { base: BASE, full: true })
    assert.equal(full.mode, 'full', fixture)
    assert.deepEqual(full.argv, argv, fixture)
    assert.equal((await run(cwd, argv, ['docs/notes.md', 'README.md'], { base: BASE })).mode, 'none', fixture)
  }
})

test('全体に効くファイルと coverage は、選択のオプションを足さずに full', async t => {
  const jest = copyFixture(t, 'jest-repo')
  const vitest = copyFixture(t, 'vitest-repo')
  const cases = [
    [jest, ['npx', 'jest'], ['package.json']],
    [jest, ['npx', 'jest'], ['src/tax.js', 'jest.config.js']],
    [jest, ['npx', 'jest'], ['babel.config.cjs']],
    [jest, ['npx', 'jest', '--coverage'], ['src/tax.js']],
    [vitest, ['npx', 'vitest', 'run'], ['pnpm-lock.yaml']],
    [vitest, ['npx', 'vitest', 'run'], ['vitest.config.ts']],
    [vitest, ['npx', 'vitest', 'run', '--coverage.enabled'], ['src/tax.js']],
  ]
  for (const [cwd, argv, changed] of cases) {
    const result = await run(cwd, argv, changed, { base: BASE })
    assert.equal(result.mode, 'full', `${argv.join(' ')} [${changed}]`)
    assert.deepEqual(result.argv, argv)
  }
  // --no-coverage は coverage ではない。
  assert.equal((await run(jest, ['npx', 'jest', '--no-coverage'], ['src/tax.js'], { base: BASE })).mode, 'subset')
})

test('人が範囲を絞っている時と監視モードは passthrough', async t => {
  const jest = copyFixture(t, 'jest-repo')
  const vitest = copyFixture(t, 'vitest-repo')
  const cases = [
    [jest, 'npx jest test/tax.test.js'],
    [jest, 'npx jest tax'],
    [jest, 'npx jest -t 税額'],
    [jest, 'npx jest --testNamePattern=税額'],
    [jest, 'npx jest --test-path-pattern tax'],
    [jest, 'npx jest --onlyChanged'],
    [jest, 'npx jest --changedSince main'],
    [jest, 'npx jest --findRelatedTests src/tax.js'],
    [jest, 'npx jest --selectProjects unit'],
    [jest, 'npx jest --watch'],
    [jest, 'npx jest --ci -- test/tax.test.js'],
    [vitest, 'npx vitest run test/tax.test.js'],
    [vitest, 'npx vitest run tax'],
    [vitest, 'npx vitest tax'],
    [vitest, 'npx vitest run -t 税額'],
    [vitest, 'npx vitest run --test-name-pattern=税額'],
    [vitest, 'npx vitest run --changed'],
    [vitest, 'npx vitest run --project unit'],
    [vitest, 'npx vitest related src/tax.js --run'],
    [vitest, 'npx vitest watch'],
    [vitest, 'npx vitest --ui'],
  ]
  for (const [cwd, command] of cases) {
    const argv = command.split(' ')
    const result = await run(cwd, argv, ['src/slug.js'], { base: BASE })
    assert.equal(result.mode, 'passthrough', command)
    assert.deepEqual(result.argv, argv, command)
  }
})

test('値を取るオプションの値を、テストの名指しと取り違えない', async t => {
  const jest = copyFixture(t, 'jest-repo')
  const vitest = copyFixture(t, 'vitest-repo')
  const cases = [
    [jest, 'npx jest --config jest.config.js -w 2 --reporters default summary --bail', `--changedSince=${BASE}`],
    [jest, 'NODE_OPTIONS=--experimental-vm-modules npx jest --maxWorkers 50%', `--changedSince=${BASE}`],
    [jest, 'node --experimental-vm-modules node_modules/jest/bin/jest.js --ci', `--changedSince=${BASE}`],
    [vitest, 'npx vitest run --root . --reporter dot --pool forks', `--changed=${BASE}`],
    [vitest, 'npx vitest --run --coverage.enabled=false --sequence.seed 3', `--changed=${BASE}`],
  ]
  for (const [cwd, command, added] of cases) {
    const result = await run(cwd, command.split(' '), ['src/tax.js'], { base: BASE })
    assert.equal(result.mode, 'subset', command)
    assert.ok(result.argv.includes(added), command)
    assert.deepEqual(result.argv.slice(0, command.split(' ').length), command.split(' '), command)
  }
})

test('パッケージスクリプト経由は、パッケージマネージャーごとの渡し方でオプションを足す', async t => {
  const jest = copyFixture(t, 'jest-repo')
  const vitest = copyFixture(t, 'vitest-repo')
  const flag = `--changedSince=${BASE}`
  assert.deepEqual((await run(jest, ['npm', 'test'], ['src/tax.js'], { base: BASE })).argv, ['npm', 'test', '--', flag])
  assert.deepEqual((await run(jest, ['npm', 'test', '--', '--ci'], ['src/tax.js'], { base: BASE })).argv, ['npm', 'test', '--', '--ci', flag])
  assert.deepEqual((await run(jest, ['yarn', 'test'], ['src/tax.js'], { base: BASE })).argv, ['yarn', 'test', flag])
  assert.deepEqual((await run(jest, ['pnpm', 'run', 'test'], ['src/tax.js'], { base: BASE })).argv, ['pnpm', 'run', 'test', flag])
  assert.deepEqual((await run(vitest, ['npm', 'run', 'test'], ['src/tax.js'])).argv, ['npm', 'run', 'test', '--', '--changed'])
  // script へ渡した引数が名指しなら触らない。
  assert.equal((await run(jest, ['npm', 'test', '--', 'test/tax.test.js'], ['src/tax.js'], { base: BASE })).mode, 'passthrough')
})

test('git リポジトリの外では選べないので passthrough', async t => {
  const cwd = copyFixture(t, 'jest-repo')
  rmSync(join(cwd, '.git'), { recursive: true })
  // 一時ディレクトリの上に .git がある環境では確かめられない。
  if ((await run(cwd, ['npx', 'jest'], ['src/tax.js'])).mode === 'subset') return t.skip('一時ディレクトリが git リポジトリの中にある')
  const result = await run(cwd, ['npx', 'jest'], ['src/tax.js'])
  assert.equal(result.mode, 'passthrough')
  assert.match(result.reason, /git/)
})

test('受け持ちでないコマンドが来ても壊れず passthrough', async t => {
  const cwd = copyFixture(t, 'jest-repo')
  for (const argv of [['ls'], ['npx', 'jest', '--version'], []]) {
    const result = await run(cwd, argv, ['src/tax.js'])
    assert.equal(result.mode, 'passthrough')
    assert.deepEqual(result.argv, argv)
  }
})
