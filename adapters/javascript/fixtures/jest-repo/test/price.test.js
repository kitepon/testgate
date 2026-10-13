const { totalPrice } = require('../src/price')

const cart = [
  { price: 100, count: 2 },
  { price: 50, count: 1 },
]

describe('totalPrice', () => {
  test('小計に税を足して合計を出す', () => {
    expect(totalPrice(cart)).toBe(275)
  })

  test('空のカートは0になる', () => {
    expect(totalPrice([])).toBe(0)
  })

  test.skip('通貨換算は未実装', () => {})
})
