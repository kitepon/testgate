const table = require('./slug-table')

function slugify(text) {
  return [...text.toLowerCase()]
    .map(ch => table[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

module.exports = { slugify }
