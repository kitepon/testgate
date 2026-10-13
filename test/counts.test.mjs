import { test } from 'node:test'
import assert from 'node:assert/strict'
import { genericCounts } from '../bin/testgate.mjs'

test('RTK が消した件数は取得不能として扱う', () => {
  assert.equal(genericCounts('[RTK:PASSTHROUGH] vitest output not recognized').countsUnavailable, true)
  assert.equal(genericCounts('PASS (0) FAIL (0)').countsUnavailable, true)
  assert.equal(genericCounts('').countsUnavailable, true)
  assert.equal(genericCounts('nothing useful here').countsUnavailable, true)
})
test('合計行があれば読む', () => {
  assert.deepEqual(genericCounts('3 passed, 1 failed in 0.2s'), { passed: 3, failed: 1 })
  assert.deepEqual(genericCounts('test result: FAILED. 5 passed; 1 failed; 0 ignored'), { passed: 5, failed: 1 })
  assert.deepEqual(genericCounts('PASS (4) FAIL (1)'), { passed: 4, failed: 1 })
})
