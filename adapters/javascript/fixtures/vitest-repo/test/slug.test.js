import { expect, test } from 'vitest'
import { slugify } from '../src/slug.js'

test('記号と空白をハイフンにまとめる', () => {
  expect(slugify('Hello,  World!')).toBe('hello-world')
})

test('ウムラウトを置き換える', () => {
  expect(slugify('Größe')).toBe('groesse')
})
