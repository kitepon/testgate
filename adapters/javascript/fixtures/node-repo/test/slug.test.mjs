import test from 'node:test'
import assert from 'node:assert/strict'
import slug from '../src/slug.cjs'

test('記号と空白をハイフンにまとめる', () => {
  assert.equal(slug.slugify('Hello,  World!'), 'hello-world')
})

test('ウムラウトを置き換える', () => {
  assert.equal(slug.slugify('Größe'), 'groesse')
})
