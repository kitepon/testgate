const test = require('node:test')
const assert = require('node:assert/strict')
const { slugify } = require('../src/slug.cjs')

test('CommonJSのテストからも使える', () => {
  assert.equal(slugify('A  B'), 'a-b')
})
