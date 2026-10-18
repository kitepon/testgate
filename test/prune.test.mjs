import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { parseNodeTestScript, inspectJsProject } from '../lib/prune/project.mjs'
import { analyzeReport, formatCandidates, mergeReports, broadThreshold, mutantKey } from '../lib/prune/candidates.mjs'
import { buildStrykerConfig, parsePruneArgs, mergeRuns, preflight, preflightLayout, runPrune, readDryRunFailures, dryRunFailedFiles } from '../lib/prune/index.mjs'
import { injectFiles, listTargets } from '../lib/prune/inject-active-mutant.mjs'
import { toolsDir, ensurePruneTools } from '../lib/prune/tools.mjs'
import { tmp } from './tmp.mjs'

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

test('test script の npm run の入れ子を展開し、tsx --test は node --test + --import tsx として読む', () => {
  const p = parseNodeTestScript('npm run test:unit && npm run test:contracts', { 'test:unit': 'vitest run', 'test:contracts': 'node --test tests/*.test.mjs' })
  assert.equal(p.runner, 'node --test') // vitest の段は runner を上書きしない（node --test の段を拾う）
  assert.deepEqual(p.files, ['tests/*.test.mjs'])
  const t = parseNodeTestScript('tsx --test src/a.test.ts src/b.test.ts')
  assert.equal(t.runner, 'node --test'); assert.deepEqual(t.nodeArgs, ['--import', 'tsx']); assert.deepEqual(t.files, ['src/a.test.ts', 'src/b.test.ts'])
  assert.deepEqual(parseNodeTestScript('npx tsx --test x.test.ts').nodeArgs, ['--import', 'tsx'])
  const loop = parseNodeTestScript('npm run a', { a: 'npm run a' }) // 自己参照は3段で止まる
  assert.equal(loop.runner, null)
})

test('package.json が無い・test script が無いリポジトリも --runner と --tests で流せる', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'tools', 'tests'), { recursive: true }); writeFileSync(join(dir, 'tools', 'x.mjs'), 'export const x = 1\n'); writeFileSync(join(dir, 'tools', 'tests', 'x.test.mjs'), '')
  assert.match(inspectJsProject(dir).error, /package.json が無い/)
  const proj = inspectJsProject(dir, { runner: 'node --test', tests: ['tools/tests/*.test.mjs'], mutate: ['tools/*.mjs'] })
  assert.equal(proj.error, undefined); assert.equal(proj.runner, 'node --test'); assert.deepEqual(proj.files, ['tools/tests/*.test.mjs']); assert.deepEqual(proj.sources, [join('tools', 'x.mjs')])
  assert.equal(parsePruneArgs(['--runner', 'node-test']).runner, 'node-test')
  assert.match(parsePruneArgs(['--runner', 'mocha']).error, /--runner は/)
})

test('build 無しの JS リポジトリは src/lib/bin を変異対象にし、試験と雑音を外す', () => {
  const proj = inspectJsProject(fixtureRepo)
  assert.equal(proj.error, undefined)
  assert.equal(proj.runner, 'node --test')
  assert.equal(proj.build, null)
  assert.deepEqual(proj.sources, ['greeting.mjs', 'price.mjs', 'slug.cjs', 'tax.mjs'].map(name => join('src', name)))
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
  assert.deepEqual(proj.sources, [join('src', 'a.ts')])
  assert.deepEqual(proj.inject, { dir: 'out' })
})

test('試験が src の .ts を直接読む（--experimental-strip-types）時は build せず、src の .ts を変異して注入する（yui の形）', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'y', scripts: { build: 'vite build', test: "node --test --experimental-strip-types 'scripts/**/*.test.mjs' 'src/**/*.test.ts'" } }))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { outDir: 'dist' } }))
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true }); writeFileSync(join(dir, 'src', 'lib', 'a.ts'), 'export const a = 1\n'); writeFileSync(join(dir, 'src', 'lib', 'a.test.ts'), ''); writeFileSync(join(dir, 'src', 'lib', 'a.d.ts'), '')
  const proj = inspectJsProject(dir)
  assert.equal(proj.error, undefined)
  assert.equal(proj.build, null)
  assert.deepEqual(proj.testArgs, ['--experimental-strip-types']) // --test の後ろの旗は testArgs（node はどちらでも受ける）
  assert.deepEqual(proj.sources, [join('src', 'lib', 'a.ts')])
  assert.deepEqual(proj.inject.globs, ['src/**/*.ts'])
})

test('--mutate を指定した時は注入の glob も同じ集合にする（build で dist へ注入する形はそのまま）', () => {
  const dir = tmp('tg-prune-mutate-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'm', scripts: { test: 'node --test test/*.test.mjs' } }))
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1\n')
  mkdirSync(join(dir, 'scripts')); writeFileSync(join(dir, 'scripts', 'b.mjs'), 'export const b = 2\n'); writeFileSync(join(dir, 'scripts', 'skip.mjs'), 'export const s = 3\n')
  mkdirSync(join(dir, 'test')); writeFileSync(join(dir, 'test', 'a.test.mjs'), '')
  const base = inspectJsProject(dir)
  assert.deepEqual(base.inject.globs, ['src/**/*.{js,mjs,cjs}']) // 既定は src/lib/bin/app
  const proj = inspectJsProject(dir, { mutate: ['scripts/*.mjs', '!scripts/skip.mjs'] })
  assert.deepEqual(proj.sources, [join('scripts', 'b.mjs')])
  assert.deepEqual(proj.inject, { globs: ['scripts/*.mjs'], exclude: ['scripts/skip.mjs'] }) // 既定の雑音（scripts/**）で注入が外れない
  assert.deepEqual(listTargets(dir, proj.inject), [join('scripts', 'b.mjs')])
  // tsconfig + build の形は dist への注入のまま
  const td = tmp('tg-prune-mutate-ts-')
  writeFileSync(join(td, 'package.json'), JSON.stringify({ name: 't', scripts: { build: 'tsc', test: 'npm run build && node --test test/*.test.mjs' } }))
  writeFileSync(join(td, 'tsconfig.json'), JSON.stringify({ compilerOptions: { rootDir: 'src', outDir: 'dist' } }))
  mkdirSync(join(td, 'app')); writeFileSync(join(td, 'app', 'x.ts'), 'export const x = 1\n')
  mkdirSync(join(td, 'test')); writeFileSync(join(td, 'test', 'x.test.mjs'), '')
  const tp = inspectJsProject(td, { mutate: ['app/**/*.ts'] })
  assert.deepEqual(tp.sources, [join('app', 'x.ts')])
  assert.deepEqual(tp.inject, { dir: 'dist' })
})

test('ランナーが分からない・試験ファイルが無い時は error を返す', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prune-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  assert.match(inspectJsProject(dir).error, /ファイル指定無し/)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'make check' } }))
  assert.match(inspectJsProject(dir).error, /ランナーが分からない/)
})

/** 試験ファイル本文の断言で落ちた失敗（狙い）の形。 */
const aimedError = (file, line = 5) => `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at TestContext.<anonymous> (file:///r/.stryker-tmp/sandbox-abc/${file}:${line}:3)\n    at Test.run (node:internal/test_runner/test:1402:25)`
/** 報告の全 killedBy に狙いの失敗記録を付ける。 */
const aimedFailures = r => Object.values(r.files).flatMap(v => v.mutants.flatMap(m => (m.killedBy || []).map(t => ({ mutant: m.id, test: t, error: aimedError(t.split('#')[0]) }))))

test('候補: 自分しか狙いで殺さない変異を持つ試験は残し、残りは貪欲な被覆で決め、Timeout は Killed と分けて数える', () => {
  const r = JSON.parse(readFileSync(join(here, 'fixtures', 'prune', 'report.json'), 'utf8'))
  // 失敗の記録が無ければ殺しは全部「不明」= 前提扱いで、残す試験も冗長も無い
  const u = analyzeReport(r)
  assert.equal(u.kept, 0)
  assert.deepEqual(u.candidates.map(c => c.reason), ['前提のみ', '前提のみ', '前提のみ', '検出0'])
  assert.deepEqual(u.killKinds, { 狙い: 0, 前提: 0, 不明: 6 })
  assert.equal(u.candidates[0].detail[0].kind, '不明')
  const a = analyzeReport(r, { failures: aimedFailures(r) })
  assert.equal(a.tested, 5)
  assert.deepEqual(a.stat, { killed: 3, timeout: 1, survived: 1, errors: 0 })
  assert.deepEqual(a.timeouts.map(m => m.id), ['4'])
  assert.deepEqual(a.survived.map(m => `${m.id} ${m.mutant}`), ['3 src/x.mjs:4:1-4:5 Regex → /x/'])
  // B は変異1を独占、C は変異4を独占 → 残す。A の殺す変異 {0,2} は B と C が殺す → 冗長。D は検出0
  const byName = Object.fromEntries(a.candidates.map(c => [c.test.name, c]))
  assert.deepEqual(Object.keys(byName).sort(), ['test/a.test.mjs > A', 'test/a.test.mjs > D'])
  assert.equal(byName['test/a.test.mjs > A'].reason, '冗長')
  assert.deepEqual(byName['test/a.test.mjs > A'].detail.map(d => d.others), [['test/a.test.mjs > B'], ['test/a.test.mjs > C']])
  assert.deepEqual(byName['test/a.test.mjs > A'].detail.map(d => [d.id, d.mutant, d.broad, d.affected, d.kind]), [['0', 'src/x.mjs:1:1-1:5 BlockStatement → {}', false, 2, '狙い'], ['2', 'src/x.mjs:3:1-3:5 EqualityOperator → !==', false, 2, '狙い']])
  assert.equal(byName['test/a.test.mjs > D'].reason, '検出0')
  assert.deepEqual(a.files, ['src/x.mjs'])
  const text = formatCandidates(a)
  assert.match(text, /^変異 5 件を流した（Killed 3・Timeout 1、生存 1）。試験 4 本のうち残す 2 本、候補 2 本（冗長 1、前提のみ 0、広域のみ 0、検出0 1）/)
  assert.match(text, /この標本（1 ファイルの変異）での狙いの殺しの重なり/)
  assert.match(text, /Timeout の変異（1 件）は.*被覆の計算に入れない/)
  assert.match(text, /殺す変異: \[0\] src\/x.mjs:1:1-1:5 BlockStatement → \{\} \[狙い\]\n    失敗: AssertionError \[ERR_ASSERTION\]: Expected values to be strictly equal:\n    同じ変異を狙いで殺す残す試験: test\/a.test.mjs > B/)
  assert.match(text, /\nTimeout の変異（1 件。どの試験が止めたかは分からないので被覆に入れていない）:\n  \[4\] src\/x.mjs/)
  assert.match(text, /\n生存した変異（1 件）。.*\n  \[3\] src\/x.mjs:4:1-4:5 Regex → \/x\/ 同関数の検出 不明/)
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
  const a = analyzeReport(r, { failures: [{ mutant: '0', test: ids[0], error: 'TypeError: path is undefined\n    at shq (x.mjs:3)' }, { mutant: '1', test: 'x', name: ids[1].replace('#', ' > '), error: "AssertionError: expected 'a' to equal 'b'\n    at TestContext.<anonymous> (file:///r/.stryker-tmp/sandbox-q/t.test.mjs:2:3)" },
    { mutant: '1', test: ids[2], error: aimedError('t.test.mjs', 3) }, { mutant: '2', test: ids[2], error: aimedError('t.test.mjs', 4) }] })
  assert.deepEqual(a.broad, [{ id: '0', mutant: 'src/a.mjs:1:1-9:2 BlockStatement → {}', affected: 11 }])
  assert.equal(a.kept, 1) // T2 だけ（変異2 を独占。変異1 も殺す）
  const by = Object.fromEntries(a.candidates.map(c => [c.test.id, c]))
  assert.equal(by[ids[0]].reason, '広域のみ'); assert.equal(by[ids[0]].detail[0].failure, 'TypeError: path is undefined'); assert.equal(by[ids[0]].detail[0].kind, '前提')
  assert.equal(by[ids[1]].reason, '冗長'); assert.equal(by[ids[1]].detail.find(d => d.id === '1').failure, "AssertionError: expected 'a' to equal 'b'"); assert.equal(by[ids[1]].detail.find(d => d.id === '1').kind, '狙い')
  assert.equal(by[ids[11]].reason, '検出0')
  assert.equal(a.candidates.filter(c => c.reason === '広域のみ').length, 9)
  // 同じ行・同じ replacement でも終端が違えば別の識別子
  assert.notEqual(mutantKey('src/a.mjs', r.files['src/a.mjs'].mutants[1]), mutantKey('src/a.mjs', r.files['src/a.mjs'].mutants[2]))
  const text = formatCandidates(a)
  assert.match(text, /広域の変異: \[0\] src\/a.mjs:1:1-9:2 BlockStatement → \{\}（11 本）/)
  assert.match(text, /\[広域のみ\] t.test.mjs > T0\n  殺す変異: \[0\] .* \[前提\]（広域: 11 本が落ちる）\n    位置: 関数 不明 \/ x\n    失敗: TypeError: path is undefined/)
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
  const a = analyzeReport(m, { failures: aimedFailures(m) })
  assert.equal(a.runs, 2)
  assert.equal(a.tested, 6)
  assert.deepEqual(a.stat, { killed: 5, timeout: 1, survived: 0, errors: 0 })
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
  assert.deepEqual(cfg.plugins, [join('/t/plugins', 'node-test-runner.mjs')])
  assert.deepEqual(cfg.nodeTest.files, ['test/*.test.mjs'])
  assert.deepEqual(cfg.nodeTest.testArgs, ['--test-timeout=2000', '--test-concurrency=2'])
  const prefix = `node ${join('/t/plugins', 'build-and-inject.mjs')} --glob `
  assert.equal(cfg.buildCommand.slice(0, prefix.length), prefix)
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
  assert.deepEqual(targets, [join('lib', 'a.mjs'), join('lib', 'deep', 'b.cjs')])
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
  assert.equal(parsePruneArgs(['--no-preflight']).noPreflight, true)
})

// 実物の一巡。道具（Stryker 一式）が導入済みの席でだけ流す（npm の導入はネットワークが要るので試験では行わない）。
const toolsReady = existsSync(join(toolsDir(), 'node_modules', '@stryker-mutator', 'core', 'package.json'))
test('下見: .git の無い写しで落ちる試験ファイルを見つける（走者の plugin をそのまま使う）', { skip: toolsReady ? false : '刈り込みの道具が未導入' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-preflight-src-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'pf', scripts: { test: 'node --test test/*.test.mjs' } }))
  mkdirSync(join(dir, '.git')); writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1\n')
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'test', 'ok.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('ok', () => assert.equal(a, 1))\n")
  writeFileSync(join(dir, 'test', 'git.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { existsSync } from 'node:fs'\ntest('.git を読む', () => assert.ok(existsSync('.git')))\ntest('これは通る', () => {})\n")
  const proj = inspectJsProject(dir)
  const tools = ensurePruneTools({ env: process.env, log: () => {} }) // 導入済みなので plugin の写しを更新するだけ
  const r = await preflight(dir, proj, { tools, log: () => {} })
  assert.deepEqual(r.failed, ['test/git.test.mjs'])
  assert.equal(r.tests, 3)
  assert.match(r.failedTests[0].error, /AssertionError/)
  assert.equal(process.cwd(), resolve('.')) // cwd を戻す
})

/** 試験ファイル自体が読み込みで落ちる小さなリポジトリ（test/bad.test.mjs は無い package を import、test/good.test.mjs は通る）。 */
function repoWithBrokenTestFile() {
  const dir = tmp('tg-prune-filefail-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ff', scripts: { test: 'node --test test/*.test.mjs' } }))
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1\n')
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'test', 'good.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { a } from '../src/a.mjs'\ntest('ok', () => assert.equal(a, 1))\n")
  writeFileSync(join(dir, 'test', 'bad.test.mjs'), "import 'tg-no-such-package'\nimport test from 'node:test'\ntest('never', () => {})\n")
  return dir
}

test('reporter: 読み込みで落ちた試験ファイルは、ファイル名付きの fail 行に stderr の例外を添えて出す', () => {
  const dir = repoWithBrokenTestFile()
  const reporter = resolve(here, '..', 'lib', 'prune', 'node-test-jsonl-reporter.mjs')
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT // 親が node --test の子だと、この変数で子扱いになって reporter に event が来ない（走者と同じ）
  const preload = pathToFileURL(resolve(here, '..', 'lib', 'prune', 'active-mutant-preload.mjs')).href
  const r = spawnSync(process.execPath, ['--import', preload, '--test', `--test-reporter=${pathToFileURL(reporter).href}`, '--test-reporter-destination=stdout', 'test/good.test.mjs', 'test/bad.test.mjs'], { cwd: dir, encoding: 'utf8', env })
  assert.equal(r.status, 1)
  const rows = r.stdout.split('\n').filter(l => l.includes('\u001e')).map(l => JSON.parse(l.slice(l.indexOf('\u001e') + 1)))
  const fileRow = rows.find(x => x.fileRow)
  assert.ok(fileRow, `ファイル行が無い: ${r.stdout}`)
  assert.equal(fileRow.status, 'fail')
  assert.equal(resolve(dir, fileRow.name), fileRow.file)
  assert.match(fileRow.error, /ERR_MODULE_NOT_FOUND|tg-no-such-package/) // "test failed" ではなく、本当の例外
  const ok = rows.find(x => x.name === 'ok')
  assert.equal(ok.status, 'pass'); assert.equal(ok.fileRow, undefined)
})

test('下見: 読み込みで落ちる試験ファイルは、その 1 本の失敗として報告され、除外に足される', { skip: toolsReady ? false : '刈り込みの道具が未導入' }, async () => {
  const dir = repoWithBrokenTestFile()
  const proj = inspectJsProject(dir)
  const tools = ensurePruneTools({ env: process.env, log: () => {} })
  const r = await preflight(dir, proj, { tools, log: () => {} })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.failed, ['test/bad.test.mjs'])
  assert.equal(r.tests, 2) // good の 1 本 + bad のファイル 1 本。(process) の行は出ない
  assert.deepEqual(r.failedTests.map(f => f.name), ['test/bad.test.mjs > (file)'])
  assert.match(r.failedTests[0].error, /ERR_MODULE_NOT_FOUND|tg-no-such-package|Cannot find package/)
  assert.equal(process.cwd(), resolve('.'))
})

/** npm workspaces の形: 根に node_modules（tg-dep を hoist）、packages/server が試験を持ち tg-dep を import する。 */
function workspaceRepo() {
  const root = tmp('tg-prune-ws-')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true, workspaces: ['packages/*'] }))
  mkdirSync(join(root, 'node_modules', 'tg-dep'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'tg-dep', 'package.json'), JSON.stringify({ name: 'tg-dep', type: 'module', main: 'index.mjs' }))
  writeFileSync(join(root, 'node_modules', 'tg-dep', 'index.mjs'), 'export const dep = 42\n')
  const server = join(root, 'packages', 'server')
  mkdirSync(join(server, 'src'), { recursive: true }); mkdirSync(join(server, 'test'))
  writeFileSync(join(server, 'package.json'), JSON.stringify({ name: 'server', scripts: { test: 'node --test test/*.test.mjs' } }))
  writeFileSync(join(server, 'src', 'a.mjs'), 'export const a = 1\n')
  writeFileSync(join(server, 'test', 'a.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { dep } from 'tg-dep'\nimport { a } from '../src/a.mjs'\ntest('依存が解決できる', () => assert.equal(a + dep, 43))\n")
  return { root, server }
}

test('下見の写し: cwd から上へ辿って node_modules の有る階層を、写しの同じ相対位置に link する', () => {
  const { root, server } = workspaceRepo()
  const out = join(root, 'copy')
  const l = preflightLayout(server, out)
  assert.equal(l.copyRoot, join(out, 'packages', 'server')) // 根（node_modules の有る一番上）からの深さを保つ
  assert.deepEqual(l.links.filter(([from]) => from.startsWith(root)), [[join(root, 'node_modules'), join(out, 'node_modules')]])
  // package 自身にも node_modules があれば、それも同じ相対位置へ
  mkdirSync(join(server, 'node_modules'))
  const l2 = preflightLayout(server, out)
  assert.deepEqual(l2.links.filter(([from]) => from.startsWith(root)), [[join(server, 'node_modules'), join(out, 'packages', 'server', 'node_modules')], [join(root, 'node_modules'), join(out, 'node_modules')]])
})

test('下見: workspaces の package を cwd にしても、根に hoist した依存が解決できて試験が通る', { skip: toolsReady ? false : '刈り込みの道具が未導入' }, async () => {
  const { server } = workspaceRepo()
  const proj = inspectJsProject(server)
  const tools = ensurePruneTools({ env: process.env, log: () => {} })
  const r = await preflight(server, proj, { tools, log: () => {} })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.failed, [], JSON.stringify(r.failedTests))
  assert.equal(r.tests, 1)
  assert.equal(process.cwd(), resolve('.'))
})

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

// 初回試験（dry run）で落ちた試験ファイルの除外と流し直し（v0.3.11）。下見は計装の無い写しなので、ソースを文字列で読む試験はここで初めて落ちる
test('初回試験の失敗: 走者の dry-run-failures.json を読み、ファイルの無い失敗（(process)）は除外に数えない', () => {
  const dir = tmp('tg-prune-dryfail-')
  const f = join(dir, 'dry-run-failures.json')
  assert.deepEqual(readDryRunFailures(f), [])
  writeFileSync(f, 'not json'); assert.deepEqual(readDryRunFailures(f), [])
  writeFileSync(f, JSON.stringify([
    { id: 'test/b.test.mjs#x', name: 'test/b.test.mjs > x', fileName: 'test/b.test.mjs', error: 'AssertionError' },
    { id: 'test/a.test.mjs#(file)', name: 'test/a.test.mjs > (file)', fileName: 'test/a.test.mjs', error: 'SyntaxError' },
    { id: 'test/b.test.mjs#y', name: 'test/b.test.mjs > y', fileName: 'test/b.test.mjs', error: 'AssertionError' },
    { id: '(process)', name: 'node --test exit 1', fileName: null, error: '' },
  ]))
  assert.deepEqual(dryRunFailedFiles(readDryRunFailures(f)), ['test/a.test.mjs', 'test/b.test.mjs'])
  assert.deepEqual(dryRunFailedFiles([{ id: '(process)', fileName: null }]), [])
  // 設定に dryRunFailuresFile を渡すと走者の nodeTest に入る
  const proj = inspectJsProject(fixtureRepo)
  const cfg = buildStrykerConfig(proj, { tools: { dir: '/t', plugins: '/t/plugins', stryker: '/t/s.js' }, mutate: ['src/tax.mjs'], reportFile: '/r/m.json', dryRunFailuresFile: '/r/d.json', timeoutMs: 1000, testTimeoutMs: 2000 })
  assert.equal(cfg.nodeTest.dryRunFailuresFile, '/r/d.json')
  assert.equal(buildStrykerConfig(proj, { tools: { dir: '/t', plugins: '/t/plugins', stryker: '/t/s.js' }, mutate: [], reportFile: '/r/m.json', timeoutMs: 1, testTimeoutMs: 1 }).nodeTest.dryRunFailuresFile, undefined)
  // 候補の本文に注記を足せる
  const text = formatCandidates({ tested: 0, stat: { killed: 0, survived: 0, timeout: 0 }, tests: 0, kept: 0, candidates: [], files: [], broadThreshold: 1, broad: [] }, { notes: ['注記 N1'] })
  assert.match(text, /\n注記 N1\n/)
})

/** 製品ソースを文字列で読み「計装の印が無い」と断言する試験を持つ小さなリポジトリ。下見（計装無し）では通り、Stryker の初回試験でだけ落ちる。 */
function repoWithSourceTextTest() {
  const dir = tmp('tg-prune-srctext-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'st', scripts: { test: 'node --test test/*.test.mjs' } }))
  mkdirSync(join(dir, 'src')); writeFileSync(join(dir, 'src', 'a.mjs'), "export function add(a, b) { return a + b }\nexport function big(n) { return n > 10 ? 'big' : 'small' }\n")
  mkdirSync(join(dir, 'test'))
  writeFileSync(join(dir, 'test', 'a.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add, big } from '../src/a.mjs'\ntest('add', () => assert.equal(add(1, 2), 3))\ntest('big', () => { assert.equal(big(11), 'big'); assert.equal(big(10), 'small') })\n")
  writeFileSync(join(dir, 'test', 'src-text.test.mjs'), "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { readFileSync } from 'node:fs'\ntest('ソースに計装の印が無い', () => assert.doesNotMatch(readFileSync(new URL('../src/a.mjs', import.meta.url), 'utf8'), /__tg_active_mutant__|stryNS_/))\n")
  return dir
}

test('走者: dry run の失敗を dryRunFailuresFile に書く（計装の印を断言する試験は、計装の無い写しでは通る）', { skip: toolsReady ? false : '刈り込みの道具が未導入' }, async () => {
  const dir = repoWithSourceTextTest()
  const tools = ensurePruneTools({ env: process.env, log: () => {} })
  const { NodeTestRunner, DryRunStatus } = await import(pathToFileURL(join(tools.plugins, 'node-test-runner.mjs')).href)
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  const out = join(dir, 'dry-run-failures.json')
  const prev = process.cwd()
  process.chdir(dir)
  try {
    let runner = new NodeTestRunner({ concurrency: 1, nodeTest: { files: ['test/*.test.mjs'], dryRunFailuresFile: out } }, quiet)
    let r = await runner.dryRun({}); await runner.dispose()
    assert.equal(r.status, DryRunStatus.Complete); assert.equal(r.tests.length, 3)
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), []) // 計装が無ければ落ちない → []
    // 計装の印を src に入れると、その試験だけ落ちてファイル名付きで書かれる
    writeFileSync(join(dir, 'src', 'a.mjs'), '/*__tg_active_mutant__*/\n' + readFileSync(join(dir, 'src', 'a.mjs'), 'utf8'))
    runner = new NodeTestRunner({ concurrency: 1, nodeTest: { files: ['test/*.test.mjs'], dryRunFailuresFile: out } }, quiet)
    r = await runner.dryRun({}); await runner.dispose()
    const failed = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(failed.map(f => [f.id, f.fileName]), [['test/src-text.test.mjs#ソースに計装の印が無い', 'test/src-text.test.mjs']])
    assert.match(failed[0].error, /AssertionError/)
    assert.deepEqual(dryRunFailedFiles(failed), ['test/src-text.test.mjs'])
  } finally { process.chdir(prev) }
})

test('実物: 下見では通り初回試験でだけ落ちる試験ファイルを除外して一度だけ流し直し、exit 0 で dryRunExcluded に残す', { skip: toolsReady ? false : '刈り込みの道具が未導入' }, async () => {
  const dir = repoWithSourceTextTest()
  const state = tmp('tg-prune-srctext-state-')
  const logs = [], outs = []
  const code = await runPrune({ cwd: dir, sample: 2, seed: 'srctext', env: { ...process.env, XDG_STATE_HOME: state }, log: m => logs.push(m), stdout: s => outs.push(s) })
  const log = logs.join('\n')
  assert.equal(code, 0, log)
  assert.doesNotMatch(log, /下見で落ちた試験ファイルを除外する/) // 下見では通る
  assert.match(log, /初回試験で落ちた試験ファイルを除外して流し直す（計装でだけ落ちる。ソースを文字列で読む等。候補にも出ない）: test\/src-text\.test\.mjs/)
  assert.match(log, /test\/src-text\.test\.mjs > ソースに計装の印が無い: AssertionError/)
  assert.equal(log.match(/One or more tests failed in the initial test run/g).length, 1) // 2 回目は通る（流し直しは一度だけ）
  assert.match(log, /Initial test run succeeded/)
  const runDir = join(state, 'testgate', 'prune', 'st')
  const rec = join(runDir, readdirSync(runDir)[0])
  const c = JSON.parse(readFileSync(join(rec, 'candidates.json'), 'utf8'))
  assert.deepEqual(c.preflightExcluded, [])
  assert.deepEqual(c.dryRunExcluded, ['test/src-text.test.mjs'])
  assert.deepEqual(c.excluded, ['test/src-text.test.mjs'])
  assert.equal(c.tests, 2) // a.test.mjs の 2 本だけ。除外した試験は候補にも出ない
  assert.match(readFileSync(join(rec, 'candidates.txt'), 'utf8'), /\n初回試験で落ちた試験ファイル 1 本を除外して流し直した（計装でだけ落ちる物。ソースを文字列で読む等。候補にも出ない）: test\/src-text\.test\.mjs\n/)
  assert.match(outs.join(''), /初回試験で落ちた試験ファイル 1 本を除外して流し直した/)
  assert.deepEqual(JSON.parse(readFileSync(join(rec, 'dry-run-failures.json'), 'utf8')), []) // 2 回目の初回試験は落ちていない
  assert.deepEqual(JSON.parse(readFileSync(join(rec, 'project.json'), 'utf8')).dryRunExcluded, ['test/src-text.test.mjs'])
  assert.match(readFileSync(join(rec, 'stryker.log'), 'utf8'), /^--- testgate prune: 初回試験で落ちた試験ファイルを除外して流し直す: test\/src-text\.test\.mjs ---$/m)
  assert.ok(!existsSync(join(dir, '.stryker-tmp')), '失敗した回の sandbox を残さない') // 1 回目の sandbox は消し、2 回目は Stryker 自身が消す
})
