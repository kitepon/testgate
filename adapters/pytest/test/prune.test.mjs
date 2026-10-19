import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_PER_POSITION, buildReport, classifyKind, defaultMutateFiles, detect, findProjectPython, formatError, id, isTestFile, judgeMutant, name, prune, runners, toolsReady } from '../prune.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, '..', 'fixtures', 'prune')

// 道具（cosmic-ray の venv）と pytest 入りの python が揃っている時だけ、実物を流す試験をする。無ければ skip（道具無しで通る部分は skip しない）。
const env = { ...process.env }
if (!env.TESTGATE_PYTHON) {
  const venv = join(here, '..', '..', '..', '.venv', 'bin', 'python')
  if (existsSync(venv)) env.TESTGATE_PYTHON = venv
}
const python = findProjectPython(fixture, env)
const ready = toolsReady(env) && !python.error
const needTools = { skip: ready ? false : '道具（cosmic-ray）か pytest 入りの python が無い（初回は testgate prune が導入する。TESTGATE_PYTHON で python を指定できる）' }

const tmp = (prefix = 'tg-prune-test-') => mkdtempSync(join(tmpdir(), prefix))
const jsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
const leftovers = () => readdirSync(tmpdir()).filter(n => n.startsWith('tg-pytest-prune-')).sort()

async function runPrune(cwd, opts = {}) {
  const runDir = tmp('tg-prune-run-')
  const r = await prune({ cwd, runDir, logFile: join(runDir, 'prune.log'), sample: 0, seed: 'seed', env, log: () => {}, ...opts })
  return { r, runDir, mutation: existsSync(join(runDir, 'mutation.json')) ? JSON.parse(readFileSync(join(runDir, 'mutation.json'), 'utf8')) : null, failures: existsSync(join(runDir, 'failures.jsonl')) ? jsonl(join(runDir, 'failures.jsonl')) : [] }
}
const mutantsOf = (m) => Object.values(m.files).flatMap(f => f.mutants)

// --- 形 ---------------------------------------------------------------------

test('id と runners', () => {
  assert.equal(id, 'pytest')
  assert.deepEqual(runners, ['pytest'])
})

// --- kind の判定（道具無し） ----------------------------------------------------

const files = new Set(['tests/test_calc.py'])
const at = (path, line = 1) => ({ path, line })

test('classifyKind: 試験本文の AssertionError は狙い', () => {
  assert.equal(classifyKind({ when: 'call', types: ['AssertionError', 'Exception', 'BaseException'], frames: [at('tests/test_calc.py', 7)] }, files), '狙い')
})
test('classifyKind: 発生位置が製品コードなら前提（断言でも）', () => {
  assert.equal(classifyKind({ when: 'call', types: ['AssertionError', 'Exception'], frames: [at('pkg/calc.py', 3), at('tests/test_calc.py', 7)] }, files), '前提')
})
test('classifyKind: helper の断言は前提', () => {
  assert.equal(classifyKind({ when: 'call', types: ['AssertionError'], frames: [at('tests/helpers.py', 5), at('tests/test_report.py', 10)] }, files), '前提')
})
test('classifyKind: TypeError など断言以外は前提', () => {
  assert.equal(classifyKind({ when: 'call', types: ['TypeError', 'Exception'], frames: [at('tests/test_calc.py', 15)] }, files), '前提')
})
test('classifyKind: setup・teardown の失敗は前提（fixture）', () => {
  for (const when of ['setup', 'teardown']) assert.equal(classifyKind({ when, types: ['AssertionError'], frames: [at('tests/test_calc.py', 3)] }, files), '前提')
})
test('classifyKind: 収集の失敗・import 失敗・試験の上限超過は前提', () => {
  assert.equal(classifyKind({ collect: true, types: ['CollectError'], frames: [] }, files), '前提')
  assert.equal(classifyKind({ when: 'call', types: ['ModuleNotFoundError', 'ImportError'], frames: [at('pkg/x.py', 1)] }, files), '前提')
  assert.equal(classifyKind({ when: 'call', types: ['TestgateTestTimeout', 'Exception'], frames: [at('tests/test_calc.py', 3)] }, files), '前提')
})
test('classifyKind: pytest.raises の失敗（Failed）で位置が試験ファイルなら狙い', () => {
  assert.equal(classifyKind({ when: 'call', types: ['Failed', 'OutcomeException', 'BaseException'], frames: [at('tests/test_calc.py', 30)] }, files), '狙い')
})
test('classifyKind: 位置が無い・記録が無いなら前提', () => {
  assert.equal(classifyKind({ when: 'call', types: ['AssertionError'], frames: [] }, files), '前提')
  assert.equal(classifyKind(undefined), '前提')
})
test('isTestFile: 収集された試験ファイルか名前の規約', () => {
  assert.ok(isTestFile('tests/test_calc.py'))
  assert.ok(isTestFile('pkg/calc_test.py'))
  assert.ok(isTestFile('conftest.py'))
  assert.ok(!isTestFile('tests/helpers.py'))
  assert.ok(isTestFile('tests/helpers.py', new Set(['tests/helpers.py'])))
  assert.ok(!isTestFile('pkg/contest.py'))
})

test('formatError: 1 行目は「型: 本文」、続けて発生位置から外へ at path:line', () => {
  const e = formatError({ message: 'AssertionError: assert 2 == 3', frames: [at('tests/test_calc.py', 7), at('tests/run.py', 1)] })
  assert.equal(e, 'AssertionError: assert 2 == 3\n   at tests/test_calc.py:7\n   at tests/run.py:1')
  assert.ok(formatError({ message: 'x'.repeat(9000), frames: [] }).length <= 4000)
})

// --- 変異の判定と報告の組み立て（道具無し） ----------------------------------------

const tests = [
  { id: 'tests/test_calc.py::test_add', file: 'tests/test_calc.py', line: 6 },
  { id: 'tests/test_calc.py::test_mul', file: 'tests/test_calc.py', line: 18 },
]
const ids = new Set(tests.map(t => t.id))
const fail = (id, extra = {}) => ({ t: 'r', id, when: 'call', outcome: 'failed', types: ['AssertionError'], message: 'AssertionError: assert 1 == 2', frames: [at('tests/test_calc.py', 7)], ...extra })

test('judgeMutant: 落ちた試験を全部 killedBy に入れる（重複は 1 つ）', () => {
  const j = judgeMutant({ status: 'done', ended: true, ran: 2, exit: 1, records: [fail(tests[0].id), fail(tests[1].id), fail(tests[0].id, { when: 'teardown' })] }, ids)
  assert.deepEqual(j, { status: 'Killed', killedBy: [tests[0].id, tests[1].id] })
})
test('judgeMutant: 全部通れば Survived、timeout は Timeout（killedBy 空）', () => {
  assert.deepEqual(judgeMutant({ status: 'done', ended: true, ran: 2, exit: 0, records: [] }, ids), { status: 'Survived', killedBy: [] })
  assert.deepEqual(judgeMutant({ status: 'timeout', records: [fail(tests[0].id)] }, ids), { status: 'Timeout', killedBy: [] })
})
test('judgeMutant: 試験が走らない・異常終了は RuntimeError（候補の集計から外れる）', () => {
  assert.equal(judgeMutant({ status: 'done', ended: true, ran: 0, exit: 5, records: [] }, ids).status, 'RuntimeError')
  assert.equal(judgeMutant({ status: 'done', ended: false, ran: 1, exit: null, records: [] }, ids).status, 'RuntimeError')
  assert.equal(judgeMutant({ status: 'error', error: 'x' }, ids).status, 'RuntimeError')
})
test('judgeMutant: 収集・import の失敗だけで試験が走らない変異は CompileError（手柄が付かない）', () => {
  assert.deepEqual(judgeMutant({ status: 'done', ended: true, ran: 0, exit: 2, records: [{ t: 'c', id: 'tests/test_calc.py', message: 'ImportError', types: ['CollectError'], frames: [] }] }, ids), { status: 'CompileError', killedBy: [] })
  // 収集の失敗と、落ちた試験が両方有れば Killed（落ちた試験が手柄）
  assert.deepEqual(judgeMutant({ status: 'done', ended: true, ran: 1, exit: 1, records: [{ t: 'c', id: 'tests/test_x.py', message: 'x', types: ['CollectError'], frames: [] }, fail(tests[0].id)] }, ids), { status: 'Killed', killedBy: [tests[0].id] })
})

test('buildReport: mutation.json と failures.jsonl の形', () => {
  const enumeration = { sources: { 'pkg/calc.py': 'def add(a, b):\n    return a + b\n' } }
  const results = [
    { index: 1, file: 'pkg/calc.py', operator: 'core/X', start: [2, 11], end: [2, 12], fn: 'add', replacement: '-', status: 'done', ended: true, ran: 2, exit: 0, records: [] },
    { index: 0, file: 'pkg/calc.py', operator: 'core/Y', start: [2, 11], end: [2, 12], fn: 'add', replacement: '*', status: 'done', ended: true, ran: 2, exit: 1,
      records: [fail(tests[0].id), { t: 'r', id: tests[1].id, when: 'call', outcome: 'failed', types: ['TypeError'], message: 'TypeError: bad', frames: [at('pkg/calc.py', 2), at('tests/test_calc.py', 19)] }] },
  ]
  const { mutation, failures } = buildReport({ enumeration, results, tests })
  assert.equal(mutation.schemaVersion, '1')
  const f = mutation.files['pkg/calc.py']
  assert.equal(f.language, 'python')
  assert.equal(f.source, enumeration.sources['pkg/calc.py'])
  assert.deepEqual(f.mutants.map(m => [m.id, m.status]), [['0', 'Killed'], ['1', 'Survived']])
  assert.deepEqual(f.mutants[0].killedBy, tests.map(t => t.id))
  assert.deepEqual(f.mutants[0].location, { start: { line: 2, column: 12 }, end: { line: 2, column: 13 } })
  assert.equal(f.mutants[0].replacement, '*')
  assert.equal(f.mutants[0].functionName, 'add')
  assert.equal(f.mutants[1].functionName, 'add')
  assert.deepEqual(Object.keys(mutation.testFiles), ['tests/test_calc.py'])
  assert.deepEqual(mutation.testFiles['tests/test_calc.py'].tests[0], { id: tests[0].id, name: tests[0].id, location: { start: { line: 6 } } })
  assert.deepEqual(failures.map(x => [x.mutant, x.test, x.kind]), [['0', tests[0].id, '狙い'], ['0', tests[1].id, '前提']])
  assert.ok(failures[0].error.startsWith('AssertionError'))
})

test('buildReport: 関数の外の変異は functionName が <module>', () => {
  const { mutation } = buildReport({ enumeration: { sources: { 'pkg/c.py': 'X = 1\n' } }, tests, results: [{ index: 0, file: 'pkg/c.py', operator: 'core/N', start: [1, 4], end: [1, 5], fn: null, replacement: '2', status: 'done', ended: true, ran: 1, exit: 0, records: [] }] })
  assert.equal(mutation.files['pkg/c.py'].mutants[0].functionName, '<module>')
})

test('defaultMutateFiles: 製品コードだけ（試験・仮想環境・build・conftest・setup を外す）', () => {
  const d = tmp()
  try {
    for (const p of ['pkg/a.py', 'pkg/sub/b.py', 'src/c.py', 'tests/test_a.py', 'test/test_b.py', 'pkg/test_x.py', 'pkg/x_test.py', '.venv/lib/z.py', 'build/lib/y.py', 'node_modules/n/m.py', 'conftest.py', 'setup.py', 'docs/conf.py', 'pkg.egg-info/s.py', 'pkg/notes.txt']) {
      mkdirSync(dirname(join(d, p)), { recursive: true }); writeFileSync(join(d, p), '')
    }
    assert.deepEqual(defaultMutateFiles(d), ['pkg/a.py', 'pkg/sub/b.py', 'src/c.py'])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('detect と name', async () => {
  const d = tmp()
  try {
    assert.equal(await detect(d, { env: {} }), false)
    writeFileSync(join(d, 'pytest.ini'), '[pytest]\n')
    assert.equal(await detect(d, { env: {} }), true)
    rmSync(join(d, 'pytest.ini'))
    writeFileSync(join(d, 'pyproject.toml'), '[project]\nname = "my-pkg"\nversion = "1"\n[tool.pytest.ini_options]\n')
    assert.equal(await detect(d, { env: {} }), true)
    assert.equal(await name(d, { env: {} }), 'my-pkg')
    rmSync(join(d, 'pyproject.toml'))
    writeFileSync(join(d, 'pyproject.toml'), '[tool.poetry]\nname = "poetic"\n')
    assert.equal(await name(d, { env: {} }), 'poetic')
    rmSync(join(d, 'pyproject.toml'))
    mkdirSync(join(d, 'tests')); writeFileSync(join(d, 'tests', 'test_a.py'), '')
    assert.equal(await detect(d, { env: {} }), true)
    assert.equal(await name(d, { env: {} }), d.split('/').pop())
  } finally { rmSync(d, { recursive: true, force: true }) }
  assert.equal(await detect(fixture, { env: {} }), true)
})

test('python が見つからない時は道具に触らず、理由と mutation.json 無しで返る', async () => {
  const d = tmp()
  const runDir = tmp('tg-prune-run-')
  const before = leftovers()
  try {
    const r = await prune({ cwd: fixture, runDir, logFile: join(runDir, 'prune.log'), env: { ...env, TESTGATE_PYTHON: '/nonexistent/python', PATH: '/nonexistent', TESTGATE_PRUNE_TOOLS: d }, log: () => {} })
    assert.equal(r.status, 1)
    assert.ok(!existsSync(join(runDir, 'mutation.json')))
    assert.deepEqual(leftovers(), before)
  } finally { rmSync(d, { recursive: true, force: true }); rmSync(runDir, { recursive: true, force: true }) }
})

// --- 実物（fixtures の小さな package を cosmic-ray と pytest で流す） --------------------

test('実物: killedBy は変異ごとに落ちた試験を全部、kind は狙いと前提の両方', needTools, async () => {
  const before = leftovers()
  const { r, runDir, mutation, failures } = await runPrune(fixture)
  try {
    assert.equal(r.status, 0)
    assert.equal(r.runner, 'pytest')
    assert.ok(r.sampled.sampled <= r.sampled.total && r.sampled.sampled >= 8) // 位置ごとに最大 MAX_PER_POSITION 件へ絞る
    const ms = mutantsOf(mutation)
    assert.equal(ms.length, r.sampled.sampled)
    assert.deepEqual(Object.keys(mutation.files).sort(), ['pkg/calc.py', 'pkg/report.py'])
    for (const [f, v] of Object.entries(mutation.files)) assert.equal(v.source, readFileSync(join(fixture, f), 'utf8'))
    // 試験の id は pytest の nodeid
    const all = Object.values(mutation.testFiles).flatMap(v => v.tests.map(t => t.id))
    assert.equal(all.length, 8)
    assert.ok(all.every(t => /^tests\/test_\w+\.py::test_\w+$/.test(t)))
    // 同じ位置の置換先は最大 MAX_PER_POSITION 件（位置を先に選ぶ）
    const perPos = {}
    for (const [f, v] of Object.entries(mutation.files)) for (const m of v.mutants) { const k = `${f}:${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}`; perPos[k] = (perPos[k] || 0) + 1 }
    assert.ok(Object.values(perPos).every(n => n <= MAX_PER_POSITION), JSON.stringify(perPos))
    assert.equal(r.sampled.positions, Object.keys(perPos).length)
    assert.equal(JSON.parse(readFileSync(join(runDir, 'project.json'), 'utf8')).sampled.maxPerPosition, MAX_PER_POSITION)
    // `a + b` の変異（pkg/calc.py:2）は、add を使う試験で落ちる。落ちた試験は全部 killedBy に入り、failures.jsonl の行と一致する
    const add = ms.filter(m => m.location.start.line === 2 && m.status === 'Killed')
    assert.ok(add.length >= 1)
    assert.ok(add.every(m => m.functionName === 'add' && m.killedBy.length >= 1))
    const wide = add.reduce((a, b) => (b.killedBy.length > a.killedBy.length ? b : a))
    assert.ok(wide.killedBy.length >= 4, `最初の失敗で止めず全部記録する: ${wide.killedBy}`)
    assert.ok(wide.killedBy.every(t => /^tests\/test_\w+\.py::test_\w+$/.test(t)))
    assert.ok(wide.replacement.length > 0 && wide.replacement !== '+')
    assert.deepEqual(wide.location.start, { line: 2, column: 14 })
    // failures.jsonl: 変異ごと・試験ごとに 1 行、kind が両方出る
    const sFail = failures.filter(f => f.mutant === wide.id)
    assert.deepEqual(sFail.map(f => f.test).sort(), [...wide.killedBy].sort())
    for (const m of ms.filter(m => m.status === 'Killed')) assert.deepEqual(failures.filter(f => f.mutant === m.id).map(f => f.test).sort(), [...m.killedBy].sort())
    assert.ok(failures.some(f => f.kind === '狙い' && f.error.startsWith('AssertionError: assert ')))
    const strs = failures.find(f => f.test === 'tests/test_calc.py::test_add_strings' && f.kind === '前提') // 製品コード（pkg/calc.py）の TypeError
    if (strs) { assert.match(strs.error, /^TypeError/); assert.match(strs.error, /at pkg\/calc\.py:2/) }
    const helper = failures.find(f => f.test === 'tests/test_report.py::test_total_helper')
    assert.equal(helper.kind, '前提') // helper の断言
    assert.ok(new Set(failures.map(f => f.kind)).size === 2)
    assert.ok(failures.filter(f => f.test === 'tests/test_report.py::test_total').every(f => f.kind === '狙い'))
    // 生存も出る（clamp の境界）
    assert.ok(ms.some(m => m.status === 'Survived'))
    // pytest.raises の失敗（DID NOT RAISE）も狙い
    const raises = failures.filter(f => f.test === 'tests/test_calc.py::test_clamp_rejects_none')
    if (raises.length) assert.ok(raises.every(f => f.kind === '狙い'))
    assert.ok(existsSync(join(runDir, 'project.json')))
    // 一時物を残さない
    assert.deepEqual(leftovers(), before)
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('実物: 同じ seed・同じ内容なら同じ標本、sample 件を流す', needTools, async () => {
  const a = await runPrune(fixture, { sample: 12, seed: 's1' })
  const b = await runPrune(fixture, { sample: 12, seed: 's1' })
  const c = await runPrune(fixture, { sample: 12, seed: 's2' })
  try {
    const key = (x) => mutantsOf(x.mutation).map(m => `${m.mutatorName}@${m.location.start.line}:${m.location.start.column}`).sort()
    assert.equal(a.r.sampled.sampled, 12)
    assert.equal(a.r.sampled.total, 41)
    assert.equal(mutantsOf(a.mutation).length, 12)
    assert.ok(a.r.sampled.positions >= 4 && a.r.sampled.positions <= 12) // 1 位置から最大 3 件
    assert.deepEqual(key(a), key(b))
    assert.notDeepEqual(key(a), key(c))
  } finally { for (const x of [a, b, c]) rmSync(x.runDir, { recursive: true, force: true }) }
})

test('実物: addopts の -x があっても落ちた試験を全部記録する。基準で落ちる試験・上限超過の試験は除外する', needTools, async () => {
  const d = tmp()
  try {
    cpSync(fixture, d, { recursive: true })
    writeFileSync(join(d, 'pytest.ini'), '[pytest]\npythonpath = .\naddopts = -x\n')
    writeFileSync(join(d, 'tests', 'test_flaky.py'), 'import time\n\n\ndef test_always_fails():\n    assert False\n\n\ndef test_hangs():\n    time.sleep(30)\n')
    const { r, runDir, mutation, failures } = await runPrune(d, { sample: 0, testTimeoutMs: 1000, mutate: ['pkg/calc.py'] })
    try {
      assert.equal(r.status, 0)
      assert.deepEqual([...r.dryRunExcluded].sort(), ['tests/test_flaky.py::test_always_fails', 'tests/test_flaky.py::test_hangs'])
      assert.ok(r.notes.some(n => n.includes('基準の試験で落ちた物を除外')))
      const ids = Object.values(mutation.testFiles).flatMap(v => v.tests.map(t => t.id))
      assert.ok(!ids.some(i => i.includes('test_flaky')))
      const most = Math.max(...mutantsOf(mutation).map(m => m.killedBy.length))
      assert.ok(most >= 4, `-x でも全部記録する: 最大 ${most}`)
      assert.ok(failures.every(f => !f.test.includes('test_flaky')))
    } finally { rmSync(runDir, { recursive: true, force: true }) }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('実物: --exclude の試験は流さず、候補にも出ない', needTools, async () => {
  const { r, runDir, mutation } = await runPrune(fixture, { exclude: ['tests/test_report.py*'], mutate: ['pkg/calc.py'] })
  try {
    assert.equal(r.status, 0)
    assert.deepEqual([...r.excluded].sort(), ['tests/test_report.py::test_total', 'tests/test_report.py::test_total_helper'])
    assert.ok(!Object.keys(mutation.testFiles).includes('tests/test_report.py'))
  } finally { rmSync(runDir, { recursive: true, force: true }) }
})

test('実物: 無限ループになる変異は Timeout（killedBy 空）', needTools, async () => {
  const d = tmp()
  try {
    mkdirSync(join(d, 'pkg'), { recursive: true }); mkdirSync(join(d, 'tests'), { recursive: true })
    writeFileSync(join(d, 'pytest.ini'), '[pytest]\npythonpath = .\n')
    writeFileSync(join(d, 'pkg', '__init__.py'), '')
    writeFileSync(join(d, 'pkg', 'loop.py'), 'def count(n):\n    i = 0\n    while i < n:\n        i += 1\n    return i\n')
    writeFileSync(join(d, 'tests', 'test_loop.py'), 'from pkg.loop import count\n\n\ndef test_count():\n    assert count(3) == 3\n')
    const { r, runDir, mutation } = await runPrune(d, { timeoutMs: 3000, testTimeoutMs: 600000 })
    try {
      assert.equal(r.status, 0)
      const t = mutantsOf(mutation).filter(m => m.status === 'Timeout')
      assert.ok(t.length >= 1, '無限ループの変異が Timeout になる')
      assert.ok(t.every(m => m.killedBy.length === 0))
    } finally { rmSync(runDir, { recursive: true, force: true }) }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('実物: import で落ちて試験が走らない変異は CompileError（killedBy 空、failures 無し）', needTools, async () => {
  const d = tmp()
  try {
    mkdirSync(join(d, 'pkg'), { recursive: true }); mkdirSync(join(d, 'tests'), { recursive: true })
    writeFileSync(join(d, 'pytest.ini'), '[pytest]\npythonpath = .\n')
    writeFileSync(join(d, 'pkg', '__init__.py'), '')
    writeFileSync(join(d, 'pkg', 'm.py'), 'ITEM = [1, 2][1]\n')
    writeFileSync(join(d, 'tests', 'test_m.py'), 'from pkg.m import ITEM\n\n\ndef test_item():\n    assert ITEM == 2\n')
    const { r, runDir, mutation, failures } = await runPrune(d)
    try {
      assert.equal(r.status, 0)
      const ms = mutantsOf(mutation)
      const ce = ms.filter(m => m.status === 'CompileError')
      assert.ok(ce.length >= 1, JSON.stringify(ms.map(m => [m.replacement, m.status])))
      assert.ok(ce.every(m => m.killedBy.length === 0 && m.functionName === '<module>'))
      assert.ok(failures.every(f => !ce.some(m => m.id === f.mutant)))
    } finally { rmSync(runDir, { recursive: true, force: true }) }
  } finally { rmSync(d, { recursive: true, force: true }) }
})
