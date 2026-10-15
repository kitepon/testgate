import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseNodeTestScript, inspectJsProject } from '../lib/prune/project.mjs'
import { analyzeReport, formatCandidates } from '../lib/prune/candidates.mjs'
import { buildStrykerConfig, parsePruneArgs } from '../lib/prune/index.mjs'
import { injectFiles, listTargets } from '../lib/prune/inject-active-mutant.mjs'
import { toolsDir } from '../lib/prune/tools.mjs'

const here = import.meta.dirname
const fixtureRepo = resolve(here, '..', 'adapters', 'javascript', 'fixtures', 'node-repo')

test('test script から node --test の引数・試験ファイル・build を読む（Aiterm の形）', () => {
  const p = parseNodeTestScript('npm run build && node --import ./test/seat-env.mjs --test test/seat-env.test.mjs && node --import ./test/seat-env.mjs --test scripts/verify-release-commit.test.mjs test/*.test.mjs')
  assert.equal(p.runner, 'node --test')
  assert.equal(p.buildScript, 'build')
  assert.deepEqual(p.nodeArgs, ['--import', './test/seat-env.mjs'])
  assert.deepEqual(p.files, ['test/seat-env.test.mjs', 'scripts/verify-release-commit.test.mjs', 'test/*.test.mjs'])
})

test('reporter の指定は外し、--test の後の option は残す', () => {
  const p = parseNodeTestScript('node --test --test-reporter=spec --test-concurrency=2 test/*.test.mjs')
  assert.deepEqual(p.testArgs, ['--test-concurrency=2'])
  assert.deepEqual(p.files, ['test/*.test.mjs'])
})

test('build 無しの JS リポジトリは src/lib/bin を変異対象にし、試験と雑音を外す', () => {
  const proj = inspectJsProject(fixtureRepo)
  assert.equal(proj.error, undefined)
  assert.equal(proj.runner, 'node --test')
  assert.equal(proj.build, null)
  assert.deepEqual(proj.sources, ['src/greeting.mjs', 'src/price.mjs', 'src/slug.cjs', 'src/tax.mjs'])
  assert.ok(proj.inject.globs.length > 0)
})

test('tsconfig と build script がある時は src/**/*.ts を変異し、dist へ注入する', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { build: 'tsc', test: 'npm run build && node --import ./test/env.mjs --test test/*.test.mjs' } }))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'out' } }))
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n'); writeFileSync(join(dir, 'src', 'a.d.ts'), '')
  const proj = inspectJsProject(dir)
  assert.deepEqual(proj.build, { script: 'build', distDir: 'out' })
  assert.deepEqual(proj.sources, ['src/a.ts'])
  assert.deepEqual(proj.inject, { dir: 'out' })
})

test('ランナーが分からない・試験ファイルが無い時は error を返す', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  assert.match(inspectJsProject(dir).error, /ファイル指定無し/)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'make check' } }))
  assert.match(inspectJsProject(dir).error, /ランナーが分からない/)
})

test('候補: 自分しか殺さない変異を持つ試験は残し、残りは貪欲な被覆で決め、timeout も検出と数える', () => {
  const a = analyzeReport(JSON.parse(readFileSync(join(here, 'fixtures', 'prune', 'report.json'), 'utf8')))
  assert.equal(a.tested, 5)
  assert.equal(a.stat.killed, 4)
  assert.deepEqual(a.survived, ['src/x.mjs:4:1 Regex → /x/'])
  // B は変異1を独占、C は変異4を独占 → 残す。A の殺す変異 {0,2} は B と C が殺す → 冗長。D は検出0
  const byName = Object.fromEntries(a.candidates.map(c => [c.test.name, c]))
  assert.deepEqual(Object.keys(byName).sort(), ['test/a.test.mjs > A', 'test/a.test.mjs > D'])
  assert.equal(byName['test/a.test.mjs > A'].reason, '冗長')
  assert.deepEqual(byName['test/a.test.mjs > A'].detail.map(d => d.others), [['test/a.test.mjs > B'], ['test/a.test.mjs > C']])
  assert.equal(byName['test/a.test.mjs > D'].reason, '検出0')
  const text = formatCandidates(a)
  assert.match(text, /残す 2 本、候補 2 本（検出0 1、冗長 1）/)
  assert.match(text, /同じ変異を殺す残す試験: test\/a.test.mjs > B/)
})

test('Stryker の設定: 走者1、bail 無し、node-test 走者と注入付きの build command', () => {
  const proj = inspectJsProject(fixtureRepo)
  const cfg = buildStrykerConfig(proj, { tools: { dir: '/t', plugins: '/t/plugins', stryker: '/t/s.js' }, mutate: ['src/tax.mjs:3:1-3:9'], reportFile: '/r/m.json', timeoutMs: 1000, testTimeoutMs: 2000, concurrencyFiles: 2 })
  assert.equal(cfg.concurrency, 1)
  assert.equal(cfg.disableBail, true)
  assert.equal(cfg.coverageAnalysis, 'off')
  assert.equal(cfg.testRunner, 'node-test')
  assert.deepEqual(cfg.plugins, ['/t/plugins/node-test-runner.mjs'])
  assert.deepEqual(cfg.nodeTest.files, ['test/*.test.mjs'])
  assert.deepEqual(cfg.nodeTest.testArgs, ['--test-timeout=2000', '--test-concurrency=2'])
  assert.match(cfg.buildCommand, /^node \/t\/plugins\/build-and-inject\.mjs --glob /)
  assert.doesNotMatch(cfg.buildCommand, /--script/)
})

test('注入: .mjs は import、.cjs は require のヘッダを shebang の後に足し、二度目は足さない', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-inject-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'lib', 'deep'), { recursive: true }); mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'lib', 'a.mjs'), '#!/usr/bin/env node\nexport const a = 1\n')
  writeFileSync(join(dir, 'lib', 'deep', 'b.cjs'), 'module.exports = 2\n')
  writeFileSync(join(dir, 'test', 'a.test.mjs'), 'import test from "node:test"\n')
  const targets = listTargets(dir, { globs: ['lib/**/*.{mjs,cjs}', 'test/**'], exclude: ['test/**'] })
  assert.deepEqual(targets, ['lib/a.mjs', 'lib/deep/b.cjs'])
  assert.equal(injectFiles(dir, targets), 2)
  assert.equal(injectFiles(dir, targets), 0)
  const a = readFileSync(join(dir, 'lib', 'a.mjs'), 'utf8').split('\n')
  assert.equal(a[0], '#!/usr/bin/env node')
  assert.match(a[1], /^\/\*__tg_active_mutant__\*\/import .*new URL\("\.\.\/\.active-mutant", import\.meta\.url\)/)
  assert.match(readFileSync(join(dir, 'lib', 'deep', 'b.cjs'), 'utf8').split('\n')[0], /require\("node:fs"\).*"\.\.\/\.\.\/\.active-mutant"/)
})

test('引数: 既定は sample 200、未知の option は error', () => {
  assert.equal(parsePruneArgs([]).sample, 200)
  assert.deepEqual(parsePruneArgs(['--cwd', '/x', '--sample', '0', '--exclude', 'a', '--exclude', 'b', '--jobs', '3']).exclude, ['a', 'b'])
  assert.equal(parsePruneArgs(['--jobs', '3']).concurrencyFiles, 3)
  assert.match(parsePruneArgs(['--nope']).error, /unknown option/)
})

// 実物の一巡。道具（Stryker 一式）が導入済みの席でだけ流す（npm の導入はネットワークが要るので試験では行わない）。
const toolsReady = existsSync(join(toolsDir(), 'node_modules', '@stryker-mutator', 'core', 'package.json'))
test('一巡: 固定リポジトリで全変異を流し、残す試験と候補を出す', { skip: toolsReady ? false : '刈り込みの道具が未導入（testgate prune を一度流すと入る）' }, t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prune-e2e-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(fixtureRepo, join(dir, 'repo'), { recursive: true })
  const env = { ...process.env, XDG_STATE_HOME: join(dir, 'state') }
  const r = spawnSync(process.execPath, [resolve(here, '..', 'bin', 'testgate.mjs'), 'prune', '--cwd', join(dir, 'repo'), '--sample', '0', '--seed', 'e2e'], { encoding: 'utf8', env, timeout: 300000 })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /変異 \d+ 件を流した/)
  // skip の試験（通貨換算は未実装）は候補に出ない
  assert.doesNotMatch(r.stdout, /通貨換算は未実装/)
  // 税のテストと価格のテストはつながっているので、どちらかが冗長になる
  assert.match(r.stdout, /\[冗長\] test\/(tax|price)\.test\.mjs/)
  const log = readFileSync(join(dir, 'state', 'testgate', 'log.jsonl'), 'utf8')
  assert.match(log, /"event":"prune"/)
})
