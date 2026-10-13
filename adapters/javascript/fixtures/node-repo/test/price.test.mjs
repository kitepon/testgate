import test from 'node:test'
import assert from 'node:assert/strict'
import { totalPrice } from '../src/price.mjs'
import { cart } from './helpers/cart.mjs'

test('小計に税を足して合計を出す', () => {
  assert.equal(totalPrice(cart), 275)
})

test('空のカートは0になる', () => {
  assert.equal(totalPrice([]), 0)
})

test('通貨換算は未実装', { skip: '未実装' }, () => {})
