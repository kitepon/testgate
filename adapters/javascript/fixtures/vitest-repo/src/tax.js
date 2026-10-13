const rates = { jp: 0.1, de: 0.19 }

export function taxFor(amount, region = 'jp') {
  const rate = rates[region]
  if (rate === undefined) throw new RangeError(`unknown region: ${region}`)
  return Math.round(amount * rate)
}
