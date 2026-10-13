const table = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

export function slugify(text) {
  return [...text.toLowerCase()]
    .map(ch => table[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
