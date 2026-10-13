import { describe, expect, test } from 'vitest'
import { taxFor } from '../src/tax.js'

describe('taxFor', () => {
  test('税額を地域の税率で計算する', () => {
    expect(taxFor(1000)).toBe(100)
    expect(taxFor(1000, 'de')).toBe(190)
  })

  test('知らない地域は例外になる', () => {
    expect(() => taxFor(1000, 'xx')).toThrow(RangeError)
  })
})
