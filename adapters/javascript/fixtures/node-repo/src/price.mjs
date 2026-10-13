import { taxFor } from './tax.mjs'

export function totalPrice(items, region) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.count, 0)
  return subtotal + taxFor(subtotal, region)
}
