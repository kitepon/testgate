import test from 'node:test'
import assert from 'node:assert/strict'

test('ひな形に名前を差し込む', async () => {
  const { greet } = await import('../src/greeting.mjs')
  assert.equal(greet('7号'), 'Hello, 7号.')
})
