import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { detect, id, parseOutput, runners, select, stripCounts } from '../adapter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRepo = join(here, '..', 'fixtures', 'repo')
const sample = (name) => readFileSync(join(here, '..', 'fixtures', 'samples', name), 'utf8')
const ctx = { cwd: fixtureRepo, env: {} }

// testmon 入りの python を探す。見つからなければ実行を伴う試験は skip する。
function findPython() {
  const exe = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']
  const candidates = [
    process.env.TESTGATE_PYTHON,
    join(here, '..', '..', '..', '.venv', ...exe),
    'python3',
    'python',
  ].filter(Boolean)
  for (const py of candidates) {
    try {
      const help = execFileSync(py, ['-m', 'pytest', '--help'], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] })
      if (help.includes('--testmon')) return py
    } catch {
      // 次の候補へ
    }
  }
  return null
}
const python = findPython()
const needPython = { skip: python ? false : 'pytest-testmon 入りの python が無い（TESTGATE_PYTHON で指定できる）' }

const noProbe = async () => {
  throw new Error('probe は呼ばれないはず')
}
const withTestmon = async () => ({ ok: true, text: '  --testmon   Select tests affected by changes' })
const withoutTestmon = async () => ({ ok: true, text: 'usage: pytest [options]' })

// --- 形 -------------------------------------------------------------------

test('id と runners', () => {
  assert.equal(id, 'pytest')
  assert.ok(runners.includes('pytest'))
})

// --- detect ----------------------------------------------------------------

test('detect: pytest の各呼び方を true にする', () => {
  for (const argv of [
    ['pytest'],
    ['pytest', 'tests/'],
    ['py.test'],
    ['python', '-m', 'pytest'],
    ['python3', '-m', 'pytest', '-q'],
    ['python3.13', '-m', 'pytest'],
    ['/usr/bin/python3', '-m', 'pytest'],
    ['.venv/bin/pytest'],
    ['.venv/bin/python', '-m', 'pytest'],
    ['C:\\proj\\.venv\\Scripts\\pytest.exe'],
    ['py', '-3', '-m', 'pytest'],
    ['uv', 'run', 'pytest'],
    ['uv', 'run', '--with', 'rich', 'pytest', '-q'],
    ['uv', 'run', 'python', '-m', 'pytest'],
    ['poetry', 'run', 'pytest'],
    ['poetry', 'run', 'python', '-m', 'pytest', 'tests'],
    ['PYTHONPATH=src', 'pytest'],
  ]) {
    assert.equal(detect(argv, ctx), true, argv.join(' '))
  }
})

test('detect: ランナーでないコマンドと、テストを走らせない呼び方は false', () => {
  for (const argv of [
    ['ls'],
    ['ls', '-la'],
    ['python', 'script.py'],
    ['python', '-m', 'unittest'],
    ['python', '-m', 'pip', 'install', 'pytest'],
    ['pip', 'install', 'pytest'],
    ['uv', 'run', 'ruff', 'check'],
    ['uv', 'sync'],
    ['poetry', 'install'],
    ['npm', 'test'],
    [],
    ['pytest', '--version'],
    ['pytest', '-V'],
    ['pytest', '--help'],
    ['pytest', '-h'],
    ['python', '-m', 'pytest', '--collect-only'],
    ['pytest', '--co', '-q'],
    ['uv', 'run', 'pytest', '--fixtures'],
  ]) {
    assert.equal(detect(argv, ctx), false, argv.join(' '))
  }
})

// --- select（外部コマンドを呼ばない分岐） -----------------------------------

test('select: full:true は元の argv をそのまま返す', async () => {
  const argv = ['uv', 'run', 'pytest', 'tests/', '-q']
  const r = await select({ argv, cwd: fixtureRepo, env: {}, changed: ['pkg/calc.py'], base: null, full: true, probe: noProbe })
  assert.deepEqual(r.argv, argv)
  assert.equal(r.mode, 'full')
})

test('select: 変更なしは none（前回の失敗が残っていても同じ）', async () => {
  const r = await select({ argv: ['pytest'], cwd: fixtureRepo, env: {}, changed: [], base: 'abc', full: false, probe: noProbe })
  assert.equal(r.mode, 'none')
})

test('select: 文書だけの変更は none', async () => {
  const r = await select({ argv: ['pytest'], cwd: fixtureRepo, env: {}, changed: ['README.md', 'docs/guide.rst'], base: null, full: false, probe: noProbe })
  assert.equal(r.mode, 'none')
})

test('select: 人が範囲を絞っていれば passthrough', async () => {
  for (const argv of [
    ['pytest', 'tests/test_calc.py'],
    ['pytest', 'tests/test_calc.py::test_add'],
    ['pytest', '-k', 'add'],
    ['pytest', '-kadd'],
    ['pytest', '-m', 'slow'],
    ['pytest', '--lf'],
    ['pytest', '--testmon'],
    ['pytest', '--no-testmon'],
    ['pytest', '-p', 'no:testmon'],
    ['pytest', '-p', 'no:cacheprovider'],
    ['uv', 'run', 'pytest', 'tests/missing_file.py'],
  ]) {
    const r = await select({ argv, cwd: fixtureRepo, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe: noProbe })
    assert.equal(r.mode, 'passthrough', argv.join(' '))
    assert.deepEqual(r.argv, argv)
  }
})

test('select: 値を取るオプションの値を、テストの名指しと取り違えない', async () => {
  const r = await select({
    argv: ['pytest', '--tb', 'short', '-o', 'addopts=', '--maxfail', '3', '-n', 'auto'],
    cwd: fixtureRepo, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe: withTestmon,
  })
  assert.notEqual(r.mode, 'passthrough', r.reason)
})

test('select: testmon が無ければ passthrough と導入方法', async () => {
  const cases = [
    [['pytest'], 'pip install pytest-testmon'],
    [['uv', 'run', 'pytest'], 'uv add --dev pytest-testmon'],
    [['poetry', 'run', 'pytest'], 'poetry add --group dev pytest-testmon'],
  ]
  for (const [argv, hint] of cases) {
    const r = await select({ argv, cwd: fixtureRepo, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe: withoutTestmon })
    assert.equal(r.mode, 'passthrough')
    assert.deepEqual(r.argv, argv)
    assert.ok(r.reason.includes(hint), r.reason)
  }
})

test('select: --help が失敗・超過したら passthrough', async () => {
  const probe = async () => ({ ok: false, why: '5秒以内に返らなかった' })
  const r = await select({ argv: ['pytest'], cwd: fixtureRepo, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe })
  assert.equal(r.mode, 'passthrough')
  assert.ok(r.reason.includes('5秒'))
})

test('select: probe には pytest 本体までのコマンド + --help を渡す', async () => {
  let seen
  const probe = async (cmd) => {
    seen = cmd
    return { ok: true, text: '--testmon' }
  }
  await select({ argv: ['uv', 'run', 'python', '-m', 'pytest', 'tests/'], cwd: fixtureRepo, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe })
  assert.deepEqual(seen, ['uv', 'run', 'python', '-m', 'pytest', '--help'])
})

test('select: 実在しないデータファイルなら初回。argv に --testmon を足し mode は full', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-py-'))
  try {
    const r = await select({ argv: ['pytest', '-q'], cwd: dir, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe: withTestmon })
    assert.equal(r.mode, 'full')
    assert.deepEqual(r.argv, ['pytest', '--testmon', '-q'])
    assert.ok(r.reason.includes('初回'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('select: データがあれば subset。フラグは pytest 本体の直後に入る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-py-'))
  try {
    writeFileSync(join(dir, '.testmondata'), 'x')
    // 実在しない `tests`（末尾の / も無い）はファイルの名指しとして触らない
    const r = await select({ argv: ['uv', 'run', 'pytest', 'tests', '-q'], cwd: dir, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe: withTestmon })
    assert.equal(r.mode, 'passthrough')
    cpSync(join(fixtureRepo, 'tests'), join(dir, 'tests'), { recursive: true })
    const r2 = await select({ argv: ['uv', 'run', 'pytest', 'tests/', '-q'], cwd: dir, env: {}, changed: ['pkg/calc.py'], base: null, full: false, probe: withTestmon })
    assert.equal(r2.mode, 'subset')
    assert.deepEqual(r2.argv, ['uv', 'run', 'pytest', '--testmon', 'tests/', '-q'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('select: TESTMON_DATAFILE（env でも argv の前置でも）を見る', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-py-'))
  try {
    writeFileSync(join(dir, 'custom.db'), 'x')
    const viaEnv = await select({ argv: ['pytest'], cwd: dir, env: { TESTMON_DATAFILE: 'custom.db' }, changed: ['a.py'], base: null, full: false, probe: withTestmon })
    assert.equal(viaEnv.mode, 'subset')
    const viaPrefix = await select({ argv: ['TESTMON_DATAFILE=custom.db', 'pytest'], cwd: dir, env: {}, changed: ['a.py'], base: null, full: false, probe: withTestmon })
    assert.equal(viaPrefix.mode, 'subset')
    assert.deepEqual(viaPrefix.argv, ['TESTMON_DATAFILE=custom.db', 'pytest', '--testmon'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('select: 全体に効くファイルの変更は full（--testmon-noselect で選択を止める）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-py-'))
  try {
    writeFileSync(join(dir, '.testmondata'), 'x')
    for (const f of ['conftest.py', 'tests/conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'uv.lock', 'poetry.lock', 'requirements-dev.txt']) {
      const r = await select({ argv: ['pytest'], cwd: dir, env: {}, changed: ['pkg/calc.py', f], base: null, full: false, probe: withTestmon })
      assert.equal(r.mode, 'full', f)
      assert.deepEqual(r.argv, ['pytest', '--testmon-noselect'], f)
      assert.ok(r.reason.includes(f), f)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- 実際の pytest を動かす -------------------------------------------------

function run(argv, cwd) {
  try {
    return { code: 0, out: execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  } catch (e) {
    return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

test('実行: 初回は全部、1ファイル変更は関わる分だけ、変更なしは none', needPython, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-py-'))
  try {
    cpSync(fixtureRepo, dir, { recursive: true })
    const argvIn = [python, '-m', 'pytest']
    const pick = (changed) => select({ argv: argvIn, cwd: dir, env: process.env, changed, base: null, full: false })

    // 初回: 依存の表が無いので全部流れる
    const first = await pick(['pkg/calc.py'])
    assert.equal(first.mode, 'full')
    assert.deepEqual(first.argv, [python, '-m', 'pytest', '--testmon'])
    const r1 = run(first.argv, dir)
    assert.equal(r1.code, 0, r1.out)
    assert.ok(existsSync(join(dir, '.testmondata')))

    // 1ファイル変更: 関わる分だけ。-v を足してどのテストが流れたかを見る
    writeFileSync(join(dir, 'pkg', 'calc.py'), `${readFileSync(join(dir, 'pkg', 'calc.py'), 'utf8')}\nSCALE = 1\n`)
    const second = await pick(['pkg/calc.py'])
    assert.equal(second.mode, 'subset', second.reason)
    const r2 = run([...second.argv, '-v'], dir)
    assert.equal(r2.code, 0, r2.out)
    assert.match(r2.out, /tests\/test_calc\.py::/)
    assert.match(r2.out, /tests\/test_report\.py::/)
    assert.doesNotMatch(r2.out, /test_solo\.py::/)

    // 変更なし
    const third = await pick([])
    assert.equal(third.mode, 'none')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('実測: testmon 2.2 は .py 以外のデータファイルの変更を追跡しない', needPython, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-py-'))
  try {
    cpSync(fixtureRepo, dir, { recursive: true })
    assert.equal(run([python, '-m', 'pytest', '--testmon', '-q'], dir).code, 0)
    writeFileSync(join(dir, 'pkg', 'settings.json'), '{"rate": 4}\n')
    const r = run([python, '-m', 'pytest', '--testmon', '-q'], dir)
    // 変更したデータを読むテストは落ちるはずだが、流れない（README「未解決」の根拠）
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /no tests ran/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- parseOutput ------------------------------------------------------------

test('parseOutput: 生の成功', () => {
  const r = parseOutput(sample('raw-pass.txt'))
  assert.equal(r.passed, 4)
  assert.equal(r.failed, 0)
  assert.equal(r.skipped, 0)
  assert.equal(r.durationMs, 10)
  assert.equal(r.failures, undefined)
})

test('parseOutput: 生の失敗（-q の形も）', () => {
  for (const name of ['raw-fail.txt', 'raw-fail-q.txt']) {
    const r = parseOutput(sample(name))
    assert.equal(r.passed, 3, name)
    assert.equal(r.failed, 1, name)
    assert.deepEqual(r.failures, ['tests/test_calc.py::test_mul'], name)
  }
})

test('parseOutput: rtk 短縮後の成功と失敗', () => {
  const ok = parseOutput(sample('rtk-pass.txt'))
  assert.equal(ok.passed, 4)
  assert.equal(ok.failed, 0)
  const ng = parseOutput(sample('rtk-fail.txt'))
  assert.equal(ng.passed, 3)
  assert.equal(ng.failed, 1)
  assert.deepEqual(ng.failures, ['tests/test_calc.py::test_mul'])
})

test('parseOutput: 収集エラーは failed に数え、場所を failures に出す', () => {
  const r = parseOutput(sample('raw-collect-error.txt'))
  assert.equal(r.passed, 0)
  assert.equal(r.failed, 1)
  assert.equal(r.errors, 1)
  assert.deepEqual(r.failures, ['tests/test_broken.py'])
})

test('parseOutput: 0件・選ばれなかったもの・testmon の形', () => {
  assert.deepEqual(parseOutput(sample('raw-testmon-none.txt')), { passed: 0, errors: 0, failed: 0, skipped: 0, durationMs: 0 })
  assert.equal(parseOutput(sample('raw-no-tests.txt')).passed, 0)
  assert.equal(parseOutput(sample('raw-testmon-subset.txt')).passed, 3)
  assert.equal(parseOutput(sample('raw-testmon-first.txt')).passed, 4)
})

test('parseOutput: skipped・warnings・時間の括弧・色コード', () => {
  const r = parseOutput('\x1b[31m=== 2 failed, 5 passed, 1 skipped, 3 warnings, 1 error in 61.50s (0:01:01) ===\x1b[0m\n')
  assert.deepEqual({ p: r.passed, f: r.failed, e: r.errors, s: r.skipped, d: r.durationMs }, { p: 5, f: 3, e: 1, s: 1, d: 61500 })
})

test('parseOutput: 数が取れなければ undefined', () => {
  const r = parseOutput('なにか別の出力\n')
  assert.equal(r.passed, undefined)
  assert.equal(r.failed, undefined)
})

test('parseOutput: failures は 50 件まで', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `FAILED tests/t.py::test_${i} - boom`)
  const r = parseOutput([...lines, '80 failed in 1.00s'].join('\n'))
  assert.equal(r.failures.length, 50)
})

// --- stripCounts ------------------------------------------------------------

test('stripCounts: 合計行が消え、失敗の詳細は残る', () => {
  for (const name of ['raw-fail.txt', 'raw-fail-q.txt', 'rtk-fail.txt']) {
    const out = stripCounts(sample(name))
    assert.doesNotMatch(out, /\d+ passed/, name)
    assert.doesNotMatch(out, /\d+ failed/, name)
    assert.doesNotMatch(out, /\[\s*\d+%\]/, name)
    assert.match(out, /assert (mul\(2, 3\) == 6|5 == 6)/, name)
    assert.match(out, /test_mul/, name)
  }
  const raw = stripCounts(sample('raw-fail.txt'))
  assert.match(raw, /FAILED tests\/test_calc\.py::test_mul - assert 5 == 6/)
  assert.match(raw, /AssertionError/)
})

test('stripCounts: 成功・0件の出力から件数が消える', () => {
  for (const name of ['raw-pass.txt', 'rtk-pass.txt', 'raw-testmon-subset.txt', 'raw-testmon-none.txt', 'raw-testmon-first.txt', 'raw-no-tests.txt']) {
    const out = stripCounts(sample(name))
    assert.doesNotMatch(out, /\b\d+ (passed|failed|deselected|skipped|errors?)\b/, name)
    assert.doesNotMatch(out, /\bcollected \d+ items?\b/, name)
    assert.doesNotMatch(out, /no tests ran in/, name)
  }
})

test('stripCounts: 収集エラーの例外は残る', () => {
  const out = stripCounts(sample('raw-collect-error.txt'))
  assert.match(out, /ModuleNotFoundError: No module named 'nosuchmod'/)
  assert.doesNotMatch(out, /1 error in/)
})

test('stripCounts: 進捗の点と PASSED 行は落ち、F は残る', () => {
  const out = stripCounts('tests/a.py ..F.  [ 50%]\ntests/b.py ...  [100%]\ntests/a.py::test_x PASSED  [ 10%]\n')
  assert.equal(out, 'tests/a.py F\n')
})
