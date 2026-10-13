// 試験の共通の道具。ファイル名が *.test.mjs でないので、テストとしては流れない。

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { select } from '../adapter.mjs'

const fixtures = fileURLToPath(new URL('../fixtures/', import.meta.url))

// fixtures のリポジトリを一時ディレクトリへ写す。.git を置いて、そこをリポジトリのルートにする。
export function copyFixture(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `testgate-js-${name}-`))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(join(fixtures, name), dir, { recursive: true })
  mkdirSync(join(dir, '.git'))
  return dir
}

// { 'src/a.mjs': '中身' } の形から小さなリポジトリを作る。
export function makeRepo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'testgate-js-repo-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, '.git'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

export const sample = name => readFileSync(join(fixtures, 'outputs', `${name}.txt`), 'utf8')

export function run(cwd, argv, changed, extra = {}) {
  return select({ argv, cwd, env: {}, changed, base: null, full: false, ...extra })
}

// node --test の後ろに並んだテストファイル。
export const chosen = result => result.argv.filter(word => /\.test\.[cm]?js$/.test(word)).sort()
