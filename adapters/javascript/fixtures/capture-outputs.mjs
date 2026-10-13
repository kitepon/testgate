#!/usr/bin/env node
// fixtures/outputs/ の実出力サンプルを取り直す。試験（node --test）からは呼ばれない。
//
//   node fixtures/capture-outputs.mjs [ランタイムの node_modules]
//
// Jest と Vitest が入った node_modules が要る（既定は ../../node_modules。アダプタ本体は依存しない）。
// fixtures の三つのリポジトリを一時ディレクトリへ写し、三つの状態で流す。
//   pass   そのまま
//   fail   税額の計算を壊す（テストが落ちる）
//   error  さらに slug のソースを構文エラーにする（テストファイルの読み込みが失敗する）
// rtk があれば rtk 短縮後の出力も取る。

import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const modules = resolve(process.argv[2] ?? join(here, '../../node_modules'))
const outputs = join(here, 'outputs')
const work = mkdtempSync(join(tmpdir(), 'testgate-js-capture-'))
const hasRtk = spawnSync('rtk', ['--version'], { encoding: 'utf8' }).status === 0

// エージェント用の短い出力へ切り替わる環境変数を外した環境。人が端末で打った時の形を取る。
const plainEnv = { PATH: process.env.PATH, HOME: process.env.HOME, FORCE_COLOR: '1' }
// Bot の席と同じ形。Jest と Vitest は AI_AGENT を見て出力を短くする。
const agentEnv = { PATH: process.env.PATH, HOME: process.env.HOME, AI_AGENT: 'claude-code', NO_COLOR: '1' }

const repos = {
  node: { dir: 'node-repo', bug: 'src/tax.mjs', broken: 'src/slug.cjs' },
  jest: { dir: 'jest-repo', bug: 'src/tax.js', broken: 'src/slug.js' },
  vitest: { dir: 'vitest-repo', bug: 'src/tax.js', broken: 'src/slug.js' },
}

const jestBin = join(modules, 'jest/bin/jest.js')
const vitestBin = join(modules, 'vitest/vitest.mjs')

const runs = [
  ['node-spec', 'node', agentEnv, ['node', '--test', 'test/*.test.mjs']],
  ['node-tap', 'node', agentEnv, ['node', '--test', '--test-reporter=tap', 'test/*.test.mjs']],
  ['node-rtk', 'node', agentEnv, ['rtk', 'test', 'node', '--test', 'test/*.test.mjs']],
  ['jest-agent', 'jest', agentEnv, ['node', jestBin]],
  ['jest-plain', 'jest', plainEnv, ['node', jestBin]],
  ['jest-rtk', 'jest', agentEnv, ['rtk', 'jest']],
  ['vitest-agent', 'vitest', agentEnv, ['node', vitestBin, 'run']],
  ['vitest-plain', 'vitest', plainEnv, ['node', vitestBin, 'run']],
  ['vitest-rtk', 'vitest', agentEnv, ['rtk', 'vitest', 'run']],
]

function capture(state) {
  for (const [name, repo, env, argv] of runs) {
    if (argv[0] === 'rtk' && !hasRtk) continue
    const cwd = join(work, repos[repo].dir)
    const result = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 120_000 })
    // 一時ディレクトリとランタイムの置き場は席ごとに違うので、決まった名前へ置き換える。
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .replaceAll(work, '/work')
      .replaceAll(modules, '/runtimes/node_modules')
    writeFileSync(join(outputs, `${name}-${state}.txt`), text)
    console.log(`${name}-${state}: 終了コード ${result.status}`)
  }
}

try {
  mkdirSync(outputs, { recursive: true })
  for (const { dir } of Object.values(repos)) {
    cpSync(join(here, dir), join(work, dir), { recursive: true })
    if (dir !== 'node-repo') symlinkSync(modules, join(work, dir, 'node_modules'), 'dir')
  }
  capture('pass')
  for (const { dir, bug } of Object.values(repos)) {
    const file = join(work, dir, bug)
    writeFileSync(file, readFileSync(file, 'utf8').replace('Math.round(amount * rate)', 'Math.round(amount * rate) + 1'))
  }
  capture('fail')
  for (const { dir, broken } of Object.values(repos)) {
    const file = join(work, dir, broken)
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n}} 壊れた行\n`)
  }
  capture('error')
} finally {
  rmSync(work, { recursive: true, force: true })
}
