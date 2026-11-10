import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectRunner } from '../lib/detect.mjs'

const yes = {
  'pytest': 'pytest', 'python -m pytest tests': 'pytest', 'python3.12 -m pytest': 'pytest', 'uv run pytest': 'pytest',
  'python -m unittest': 'unittest', 'python3.12 -m unittest discover -s tests': 'unittest', 'python3 -m unittest tests.test_a': 'unittest',
  'npx jest': 'jest', 'npx vitest run': 'vitest', 'node --test test/*.test.mjs': 'node --test', 'npm test': 'npm test', 'npm run test': 'npm test', 'pnpm t': 'npm test',
  'cargo test': 'cargo test', 'go test ./...': 'go test', 'swift test': 'swift test', 'xcodebuild test -scheme X': 'xcodebuild test', './gradlew test': 'gradle test', './gradlew :app:testDebugUnitTest': null,
  'dotnet test': 'dotnet test', 'ctest': 'ctest', 'rtk pytest': 'pytest', 'rtk test cargo test': 'rtk test',
}
const no = ['python -W error -m unittest', 'python -m unittest --help', 'python script.py', 'ls -la', 'pytest --version', 'npx jest --listTests', 'xcodebuild build -scheme X', 'swift build', './gradlew build', 'npm run lint', 'node server.mjs', 'go build ./...', 'cargo build', 'git status']

for (const [cmd, runner] of Object.entries(yes)) {
  test(`判定: ${cmd}`, () => { assert.equal(detectRunner(cmd.split(' '))?.runner ?? null, runner) })
}
for (const cmd of no) {
  test(`非判定: ${cmd}`, () => { assert.equal(detectRunner(cmd.split(' ')), null) })
}

test('npm run の test:* script も段階0で試験として拾う', () => {
  assert.deepEqual(detectRunner(['npm', 'run', 'test:pi5']), { runner: 'npm test', lang: 'javascript' })
  assert.deepEqual(detectRunner(['pnpm', 'run', 'test-unit']), { runner: 'npm test', lang: 'javascript' })
  assert.deepEqual(detectRunner(['npm', 'run-script', 'test']), { runner: 'npm test', lang: 'javascript' })
  assert.equal(detectRunner(['npm', 'run', 'testimonials']), null)
  assert.equal(detectRunner(['npm', 'run', 'build']), null)
})

// 段階0の記録: 引用符・here-doc の中の語は、別のコマンドとして数えない（2c）。複合の本物のテストは数える。
import { analyze } from '../lib/analyze.mjs'
test('analyze: 引用符の中・here-doc の本文・rg の検索語は runner なし', () => {
  for (const cmd of [
    "ps -eo pid,args | rg 'cargo test|gdb'",
    "cat > note.md <<'EOF'\ncargo test; go test ./...\nEOF",
    "ssh macbook 'cd x && cargo test' ; echo done",
    "rg -n 'pytest|npm test' docs && ls",
    'echo "run npm test | tee out" && pwd',
  ]) assert.equal(analyze(cmd).runner, null, cmd)
})
test('analyze: 複合の中の本物のテストは数える（括弧・リダイレクト・.・環境変数の前置きも）', () => {
  const cases = {
    'cd /repo && cargo test': 'cargo test',
    '(npm run lint && npm test) 2>&1 | tail -5': 'npm test',
    '. ./env.sh; uv run pytest -q tests/a.py 2>&1 | head': 'pytest',
    'FOO=1 node --test test/a.test.mjs && echo ok': 'node --test',
    "cat > f <<'EOF'\nx\nEOF\ngo test ./...": 'go test',
  }
  for (const [cmd, runner] of Object.entries(cases)) assert.equal(analyze(cmd).runner, runner, cmd)
  assert.equal(analyze('npm test').runner, 'npm test')
})
