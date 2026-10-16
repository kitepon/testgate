import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseNodeTestScript, inspectJsProject } from '../lib/prune/project.mjs'
import { analyzeReport, formatCandidates, mergeReports, broadThreshold, mutantKey } from '../lib/prune/candidates.mjs'
import { buildStrykerConfig, parsePruneArgs, mergeRuns } from '../lib/prune/index.mjs'
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
  assert.deepEqual(a.survived, ['3 src/x.mjs:4:1-4:5 Regex → /x/'])
  // B は変異1を独占、C は変異4を独占 → 残す。A の殺す変異 {0,2} は B と C が殺す → 冗長。D は検出0
  const byName = Object.fromEntries(a.candidates.map(c => [c.test.name, c]))
  assert.deepEqual(Object.keys(byName).sort(), ['test/a.test.mjs > A', 'test/a.test.mjs > D'])
  assert.equal(byName['test/a.test.mjs > A'].reason, '冗長')
  assert.deepEqual(byName['test/a.test.mjs > A'].detail.map(d => d.others), [['test/a.test.mjs > B'], ['test/a.test.mjs > C']])
  assert.deepEqual(byName['test/a.test.mjs > A'].detail.map(d => [d.id, d.mutant, d.broad, d.affected]), [['0', 'src/x.mjs:1:1-1:5 BlockStatement → {}', false, 2], ['2', 'src/x.mjs:3:1-3:5 EqualityOperator → !==', false, 2]])
  assert.equal(byName['test/a.test.mjs > D'].reason, '検出0')
  assert.deepEqual(a.files, ['src/x.mjs'])
  const text = formatCandidates(a)
  assert.match(text, /残す 2 本、候補 2 本（冗長 1、広域のみ 0、検出0 1）/)
  assert.match(text, /この標本（1 ファイルの変異）での検出の重なり/)
  assert.match(text, /殺す変異: \[0\] src\/x.mjs:1:1-1:5 BlockStatement → \{\}\n    同じ変異を殺す残す試験: test\/a.test.mjs > B/)
})

test('候補: 試験の大半が落ちる広域の変異は冗長の根拠にせず、それしか検出しない試験は「広域のみ」。失敗の断言を添える', () => {
  assert.equal(broadThreshold(5), 10); assert.equal(broadThreshold(856), 172)
  // 試験 12 本。変異 0 は 11 本が落ちる（広域）、変異 1 は T1 と T2、変異 2 は T2 だけが殺す
  const ids = Array.from({ length: 12 }, (_, i) => `t.test.mjs#T${i}`)
  const r = { testFiles: { 't.test.mjs': { tests: ids.map((id, i) => ({ id, name: id.replace('#', ' > '), location: { start: { line: i + 1, column: 0 } } })) } },
    files: { 'src/a.mjs': { source: 'x', mutants: [
      { id: '0', mutatorName: 'BlockStatement', replacement: '{}', status: 'Killed', killedBy: ids.slice(0, 11), location: { start: { line: 1, column: 1 }, end: { line: 9, column: 2 } } },
      { id: '1', mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Killed', killedBy: [ids[1], ids[2]], location: { start: { line: 2, column: 3 }, end: { line: 2, column: 9 } } },
      { id: '2', mutatorName: 'ConditionalExpression', replacement: 'true', status: 'Killed', killedBy: [ids[2]], location: { start: { line: 2, column: 3 }, end: { line: 2, column: 12 } } },
    ] } } }
  // 失敗は走者の試験ID（file#name）か名前（file > name）で対応を取る（Stryker の報告は試験を番号で持つ）
  const a = analyzeReport(r, { failures: [{ mutant: '0', test: ids[0], error: 'TypeError: path is undefined\n    at shq (x.mjs:3)' }, { mutant: '1', test: 'x', name: ids[1].replace('#', ' > '), error: "AssertionError: expected 'a' to equal 'b'" }] })
  assert.deepEqual(a.broad, [{ id: '0', mutant: 'src/a.mjs:1:1-9:2 BlockStatement → {}', affected: 11 }])
  assert.equal(a.kept, 1) // T2 だけ（変異2 を独占。変異1 も殺す）
  const by = Object.fromEntries(a.candidates.map(c => [c.test.id, c]))
  assert.equal(by[ids[0]].reason, '広域のみ'); assert.equal(by[ids[0]].detail[0].failure, 'TypeError: path is undefined')
  assert.equal(by[ids[1]].reason, '冗長'); assert.equal(by[ids[1]].detail.find(d => d.id === '1').failure, "AssertionError: expected 'a' to equal 'b'")
  assert.equal(by[ids[11]].reason, '検出0')
  assert.equal(a.candidates.filter(c => c.reason === '広域のみ').length, 9)
  // 同じ行・同じ replacement でも終端が違えば別の識別子
  assert.notEqual(mutantKey('src/a.mjs', r.files['src/a.mjs'].mutants[1]), mutantKey('src/a.mjs', r.files['src/a.mjs'].mutants[2]))
  const text = formatCandidates(a)
  assert.match(text, /広域の変異: \[0\] src\/a.mjs:1:1-9:2 BlockStatement → \{\}（11 本）/)
  assert.match(text, /\[広域のみ\] t.test.mjs > T0\n  殺す変異: \[0\] .*（広域: 11 本が落ちる）\n    失敗: TypeError: path is undefined/)
})

test('合算: 2回分の変異は位置で束ね、killedBy は和集合。検出0 だった試験が2回目で変異を独占すれば残す側へ', t => {
  const r1 = JSON.parse(readFileSync(join(here, 'fixtures', 'prune', 'report.json'), 'utf8'))
  const r2 = JSON.parse(JSON.stringify(r1))
  // 2回目: 変異0 は A だけが殺した、変異3（1回目は生存）は D が殺した、別ファイルの変異5 は D だけが殺した
  r2.files['src/x.mjs'].mutants = [
    { ...r1.files['src/x.mjs'].mutants[0], id: '0', killedBy: ['test/a.test.mjs#A'] },
    { ...r1.files['src/x.mjs'].mutants[3], id: '1', status: 'Killed', killedBy: ['test/a.test.mjs#D'] },
  ]
  r2.files['src/y.mjs'] = { mutants: [{ id: '2', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Killed', killedBy: ['test/a.test.mjs#D'], location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } } }] }
  const m = mergeReports([r1, r2])
  assert.equal(m.runs, 2)
  assert.equal(m.files['src/x.mjs'].mutants.length, 5)
  assert.deepEqual(m.files['src/x.mjs'].mutants[0].ids, ['0', '0'])
  // 元コードが変わった回の変異は束ねない
  const r3 = JSON.parse(JSON.stringify(r2)); r3.files['src/x.mjs'].source = 'changed'
  assert.equal(mergeReports([r1, r3]).files['src/x.mjs'].mutants.length, 7)
  assert.deepEqual(m.files['src/x.mjs'].mutants[0].killedBy, ['test/a.test.mjs#A', 'test/a.test.mjs#B'])
  assert.equal(m.files['src/x.mjs'].mutants[3].status, 'Killed')
  assert.equal(m.testFiles['test/a.test.mjs'].tests.length, 4)
  const a = analyzeReport(m)
  assert.equal(a.runs, 2)
  assert.equal(a.tested, 6)
  assert.deepEqual(a.stat, { killed: 6, survived: 0, errors: 0 })
  assert.deepEqual(a.candidates.map(c => c.test.name), ['test/a.test.mjs > A']) // D は変異5 を独占して残る
  assert.match(formatCandidates(a), /^2 回分を合算: 変異 6 件を流した/)
  // mergeRuns: 名前のフォルダに 2 回分の mutation.json がある時だけ合算を返す
  const dir = mkdtempSync(join(tmpdir(), 'tg-merge-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '20260101-000000')); writeFileSync(join(dir, '20260101-000000', 'mutation.json'), JSON.stringify(r1))
  assert.equal(mergeRuns(dir), null)
  mkdirSync(join(dir, '20260201-000000')); writeFileSync(join(dir, '20260201-000000', 'mutation.json'), JSON.stringify(r2))
  mkdirSync(join(dir, '20260301-000000')) // mutation.json が無い（失敗した回）は飛ばす
  const mr = mergeRuns(dir)
  assert.equal(mr.runs.length, 2)
  assert.equal(mr.analysis.tested, 6)
  assert.equal(mergeRuns(join(dir, 'none')), null)
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
  assert.doesNotMatch(r.stdout, /回分の合算/)
  // 2回目は過去の記録と合算した候補も書く
  const r2 = spawnSync(process.execPath, [resolve(here, '..', 'bin', 'testgate.mjs'), 'prune', '--cwd', join(dir, 'repo'), '--sample', '0', '--seed', 'e2e2'], { encoding: 'utf8', env, timeout: 300000 })
  assert.equal(r2.status, 0, r2.stderr)
  assert.match(r2.stdout, /--- 2 回分の合算（.*）---\n2 回分を合算: 変異 \d+ 件を流した/)
  const runDir = r2.stdout.match(/記録: (\S+)（/)[1]
  assert.ok(existsSync(join(runDir, 'candidates-merged.txt')))
  assert.equal(JSON.parse(readFileSync(join(runDir, 'candidates-merged.json'), 'utf8')).runs.length, 2)
  // 失敗の断言が記録され、候補に添えられる
  assert.ok(existsSync(join(runDir, 'failures.jsonl')))
  const c = JSON.parse(readFileSync(join(runDir, 'candidates.json'), 'utf8'))
  assert.equal(c.commit, null) // 固定リポジトリの写しは git ではない
  assert.match(c.platform, /^linux node v/)
  assert.ok(c.candidates.some(o => o.detail.some(d => d.failure)))
})
