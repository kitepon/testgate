import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, cpSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { id, detect, matches, parseTrx, parseXml, failureKind, applyMutation, sampleMutants, prune, toolsReady } from '../prune.mjs'
import { withRunTmp } from '../../../lib/prune/tmp-root.mjs'
import { analyzeReport } from '../../../lib/prune/candidates.mjs'
const fixture = fileURLToPath(new URL('../fixtures/prune/', import.meta.url))
const xml = (message, stack, cls = 'Sample.Tests.CalcTests') => `<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results><UnitTestResult testId="random-id" outcome="Failed"><Output><ErrorInfo><Message>${message}</Message><StackTrace>${stack}</StackTrace></ErrorInfo></Output></UnitTestResult></Results><TestDefinitions><UnitTest id="random-id" name="Adds"><TestMethod className="${cls}" name="Adds"/></UnitTest></TestDefinitions></TestRun>`

test('prune contract: detect only test projects, name, and glob file scopes', async () => {
  assert.equal(id, 'dotnet'); assert.equal(await detect(fixture, { env: process.env }), true)
  const dir = mkdtempSync(path.join(tmpdir(), 'tg-prune-discover-'))
  try { writeFileSync(path.join(dir, 'Only.csproj'), '<Project/>'); assert.equal(await detect(dir, { env: process.env }), false) } finally { rmSync(dir, { recursive: true, force: true }) }
  assert.equal(matches('src/a/Calc.cs', '**/*.cs'), true)
  assert.equal(matches('Calc.cs', '**/*.cs'), true)
  assert.equal(matches('src/a/Calc.cs', 'src/*.cs'), false)
  assert.equal(matches('src\\a\\Calc.cs', 'src/**/Calc.cs'), true)
})
test('TRX preserves stable fully qualified IDs and assertion error/stack, not random GUIDs', () => {
  const r = parseTrx(xml('Assert.Equal() Failure: a &lt; b &amp; c', ' at Sample.Tests.CalcTests.Adds() in C:\\repo\\tests\\CalcTests.cs:line 8'))[0]
  assert.equal(r.id, 'Sample.Tests.CalcTests.Adds')
  assert.match(r.error, /a < b & c/); assert.match(r.error, /:line 8/)
  assert.equal(failureKind(r), '狙い')
  assert.deepEqual(parseTrx(xml('Assert.Equal() Failure: a', ' at Sample.Tests.CalcTests.Adds()').replace(/random-id/g, 'another-guid'))[0].id, r.id)
})
test('assertions in helpers, setup errors, and untyped errors are prerequisites', () => {
  const base = { className: 'Sample.Tests.CalcTests', message: 'Assert.Equal() Failure: Values differ', stack: ' at Helpers.Common.Check()\n at Sample.Tests.CalcTests.Adds()' }
  assert.equal(failureKind(base), '前提')
  assert.equal(failureKind({ ...base, message: 'System.InvalidOperationException : unavailable', stack: ' at Sample.Tests.CalcTests.Adds()' }), '前提')
  assert.equal(failureKind({ ...base, message: 'Expected values to be equal', stack: ' at Sample.Tests.CalcTests.Adds()' }), '前提')
  assert.equal(failureKind({ ...base, message: 'NUnit.Framework.AssertionException: mismatch', stack: ' at Sample.Tests.CalcTests.Adds()' }), '狙い')
  assert.equal(failureKind({ ...base, message: 'Microsoft.VisualStudio.TestTools.UnitTesting.AssertFailedException: mismatch', stack: ' at Sample.Tests.CalcTests.Adds()' }), '狙い')
})
test('TRX rejects incomplete reports and external entities; CDATA error text survives', () => {
  assert.throws(() => parseTrx('<TestRun><Results>'), /Truncated/)
  assert.throws(() => parseXml('<!DOCTYPE x SYSTEM "file:///secret"><x/>'), /DTD/)
  const r = parseTrx(xml('<![CDATA[Assert.Equal() Failure: <text>]]>', ' at Sample.Tests.CalcTests.Adds()'))
  assert.equal(r[0].message, 'Assert.Equal() Failure: <text>')
})
test('mutation materialization respects Roslyn UTF16 columns, CRLF and full replacement', () => {
  const s = '// 😀\r\nvar x = a + b;\r\n'
  const m = { location: { start: { line: 2, column: 9 }, end: { line: 2, column: 14 } }, replacement: 'a - b' }
  assert.equal(applyMutation(s, m), '// 😀\r\nvar x = a - b;\r\n')
  assert.throws(() => applyMutation(s, { ...m, location: { start: { line: 2, column: 100 }, end: { line: 2, column: 101 } } }), /column/)
})
test('sampling is deterministic across input order, seed changes selection, zero means all', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ file: 'src/Calc.cs', source: 'original', mutant: { location: { start: { line: i + 1, column: 1 }, end: { line: i + 1, column: 2 } }, mutatorName: 'Arithmetic', replacement: '-' } }))
  assert.deepEqual(sampleMutants(items, 4, 'fixed'), sampleMutants([...items].reverse(), 4, 'fixed'))
  assert.notDeepEqual(sampleMutants(items, 4, 'fixed'), sampleMutants(items, 4, 'other'))
  assert.equal(sampleMutants(items, 0, 'fixed').length, 20)
})
test('tool failure cleans its temporary sandbox; keepSandbox survives under runDir', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tg-prune-lifecycle-'))
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('tg-dotnet-prune-')).sort()
  try {
    for (const keepSandbox of [false, true]) {
      const runDir = path.join(root, keepSandbox ? 'keep' : 'remove')
      const env = { ...process.env, PATH: '', Path: '', TESTGATE_PRUNE_TOOLS: path.join(root, 'tools') }
      const r = await prune({ cwd: fixture, runDir, logFile: path.join(runDir, 'prune.log'), keepSandbox, env })
      assert.equal(r.status, 1)
      assert.equal(existsSync(path.join(runDir, 'sandbox', 'repo', 'src', 'Calc.cs')), keepSandbox)
      assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('tg-dotnet-prune-')).sort(), before)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
test('fixture: ALL failing tests per mutation, target/prerequisite failures, candidate output and cleanup', { skip: !toolsReady() && 'dotnet SDK / pinned Stryker.NET not installed', timeout: 600000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tg-dotnet-accept-')), runDir = path.join(root, 'run')
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('tg-dotnet-prune-') || n.startsWith('tg-run-')).sort()
  const original = readFileSync(path.join(fixture, 'src/Calc.cs'), 'utf8')
  mkdirSync(runDir)
  try {
    const result = await withRunTmp(() => prune({ cwd: fixture, runDir, logFile: path.join(runDir, 'prune.log'), sample: 0, seed: 'fixture-all', timeoutMs: 60000, testTimeoutMs: 20000 }))
    assert.equal(result.status, 0, readFileSync(path.join(runDir, 'prune.log'), 'utf8').slice(-10000))
    const report = JSON.parse(readFileSync(path.join(runDir, 'mutation.json')))
    const failures = readFileSync(path.join(runDir, 'failures.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    const mutants = Object.values(report.files).flatMap(f => f.mutants)
    const arithmetic = mutants.find(m => m.replacement === 'a - b')
    assert.equal(arithmetic.status, 'Killed')
    assert.deepEqual(arithmetic.killedBy, ['PruneSample.Tests.CalcTests.Adds', 'PruneSample.Tests.CalcTests.AddsAgain'])
    assert.ok(failures.some(f => f.mutant === arithmetic.id && f.kind === '狙い'), JSON.stringify(failures))
    assert.ok(failures.some(f => f.kind === '前提' && /not ready/.test(f.error)), JSON.stringify(failures))
    assert.ok(failures.every(f => mutants.find(m => m.id === f.mutant).killedBy.includes(f.test)))
    const analysis = analyzeReport(report, { failures, cwd: fixture })
    assert.ok(analysis.candidates.some(t => /Unrelated/.test(t.test.id) && t.reason === '検出0'))
    assert.ok(analysis.candidates.some(t => t.reason === '冗長'))
    assert.ok(analysis.candidates.some(t => t.reason === '前提のみ'))
    assert.equal(readFileSync(path.join(fixture, 'src/Calc.cs'), 'utf8'), original)
  } finally {
    if (process.env.TESTGATE_DOTNET_PRUNE_EVIDENCE) cpSync(runDir, process.env.TESTGATE_DOTNET_PRUNE_EVIDENCE, { recursive: true })
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(readdirSync(tmpdir()).filter(n => n.startsWith('tg-dotnet-prune-') || n.startsWith('tg-run-')).sort(), before)
  }
})
