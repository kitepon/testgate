import test from 'node:test'
import assert from 'node:assert/strict'
import { taxFor } from '../src/tax.mjs'

test('税額を地域の税率で計算する', () => {
  assert.equal(taxFor(1000), 100)
  assert.equal(taxFor(1000, 'de'), 190)
})

test('知らない地域は例外になる', () => {
  assert.throws(() => taxFor(1000, 'xx'), RangeError)
})
