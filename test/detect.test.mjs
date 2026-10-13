import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectRunner } from '../lib/detect.mjs'

const yes = {
  'pytest': 'pytest', 'python -m pytest tests': 'pytest', 'python3.12 -m pytest': 'pytest', 'uv run pytest': 'pytest',
  'npx jest': 'jest', 'npx vitest run': 'vitest', 'node --test test/*.test.mjs': 'node --test', 'npm test': 'npm test', 'npm run test': 'npm test', 'pnpm t': 'npm test',
  'cargo test': 'cargo test', 'go test ./...': 'go test', 'swift test': 'swift test', 'xcodebuild test -scheme X': 'xcodebuild test', './gradlew test': 'gradle test', './gradlew :app:testDebugUnitTest': null,
  'dotnet test': 'dotnet test', 'ctest': 'ctest', 'rtk pytest': 'pytest', 'rtk test cargo test': 'rtk test',
}
const no = ['ls -la', 'pytest --version', 'npx jest --listTests', 'xcodebuild build -scheme X', 'swift build', './gradlew build', 'npm run lint', 'node server.mjs', 'go build ./...', 'cargo build', 'git status']

for (const [cmd, runner] of Object.entries(yes)) {
  test(`判定: ${cmd}`, () => { assert.equal(detectRunner(cmd.split(' '))?.runner ?? null, runner) })
}
for (const cmd of no) {
  test(`非判定: ${cmd}`, () => { assert.equal(detectRunner(cmd.split(' ')), null) })
}
