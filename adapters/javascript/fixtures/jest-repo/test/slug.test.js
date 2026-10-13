const { slugify } = require('../src/slug')

test('記号と空白をハイフンにまとめる', () => {
  expect(slugify('Hello,  World!')).toBe('hello-world')
})

test('ウムラウトを置き換える', () => {
  expect(slugify('Größe')).toBe('groesse')
})
