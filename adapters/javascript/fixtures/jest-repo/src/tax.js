const rates = require('./rates.json')

function taxFor(amount, region = 'jp') {
  const rate = rates[region]
  if (rate === undefined) throw new RangeError(`unknown region: ${region}`)
  return Math.round(amount * rate)
}

module.exports = { taxFor }
