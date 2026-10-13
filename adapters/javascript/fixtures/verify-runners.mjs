#!/usr/bin/env node
// select が返した argv を実ランナーで流して、関わるテストだけが流れることを確かめる。
// 試験（node --test）からは呼ばれない。Jest と Vitest が入った node_modules と git が要る。
//
//   node fixtures/verify-runners.mjs [ランタイムの node_modules]
//
// fixtures のリポジトリを一時ディレクトリへ写して git の履歴を作り、関所と同じやり方で
// changed を出してから select を呼ぶ。食い違いがあれば終了コード 1。

import { spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { select } from '../adapter.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const modules = resolve(process.argv[2] ?? join(here, '../../node_modules'))
const work = mkdtempSync(join(tmpdir(), 'testgate-js-verify-'))
// 人が端末で打った時の形。どのテストファイルが流れたかが出力に出る。
const env = { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1' }
let failed = false

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=testgate', '-c', 'user.email=testgate@example.invalid', ...args], { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function setUp(name) {
  const cwd = join(work, name)
  cpSync(join(here, name), cwd, { recursive: true })
  if (name !== 'node-repo') symlinkSync(modules, join(cwd, 'node_modules'), 'dir')
  writeFileSync(join(cwd, '.gitignore'), 'node_modules\n')
  git(cwd, 'init', '-q')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'base')
  return { cwd, base: git(cwd, 'rev-parse', 'HEAD') }
}

// 関所と同じ出し方: base（無ければ HEAD）との差分と、未追跡ファイル。
function changedSince(cwd, base) {
  const diff = git(cwd, 'diff', '--name-only', base ?? 'HEAD')
  const untracked = git(cwd, 'ls-files', '--others', '--exclude-standard')
  return [...new Set(`${diff}\n${untracked}`.split('\n').filter(Boolean))]
}

function ranFiles(text, argv) {
  const files = new Set()
  for (const match of text.matchAll(/^(?:PASS|FAIL)\s+(\S+)/gm)) files.add(match[1]) // Jest
  for (const match of text.matchAll(/^\s*[✓❯×]\s+(\S+\.test\.js)\b/gmu)) files.add(match[1]) // Vitest
  // node --test は流したファイルを出力に書かない。argv に並んだ物がそのまま流れる。
  if (files.size === 0) for (const word of argv) if (/\.test\.[cm]?js$/.test(word) && !word.includes('*')) files.add(word)
  return [...files].sort()
}

async function check(label, { cwd, argv, base, mode, files }) {
  const changed = changedSince(cwd, base)
  const result = await select({ argv, cwd, env, changed, base, full: false })
  let ran = []
  let status = 0
  if (result.mode !== 'none') {
    const run = spawnSync(result.argv[0], result.argv.slice(1), { cwd, env, encoding: 'utf8', timeout: 120_000 })
    const text = `${run.stdout ?? ''}${run.stderr ?? ''}`
    status = run.status
    ran = ranFiles(text, result.argv)
  }
  const ok = result.mode === mode && status === 0 && JSON.stringify(ran) === JSON.stringify(files)
  if (!ok) failed = true
  console.log(`${ok ? 'OK' : 'NG'}  ${label}`)
  console.log(`    変更: ${changed.join(', ') || '（なし）'}`)
  console.log(`    ${result.mode}: ${result.mode === 'none' ? '（流さない）' : result.argv.join(' ')}`)
  console.log(`    流れたファイル: ${ran.join(', ') || '（なし）'}${ok ? '' : `  ← 期待は ${mode} / ${files.join(', ') || '（なし）'} / 終了コード 0（実際は ${status}）`}`)
}

const TAX_AND_PRICE = ['test/price.test.js', 'test/tax.test.js']

async function native(name, argv, script) {
  const { cwd, base } = setUp(`${name}-repo`)
  await check(`${name}: 変更なし`, { cwd, argv, base, mode: 'none', files: [] })

  appendFileSync(join(cwd, 'src/tax.js'), '\n// 変更\n')
  await check(`${name}: tax を変更（未commit、base あり）`, { cwd, argv, base, mode: 'subset', files: TAX_AND_PRICE })
  await check(`${name}: tax を変更（未commit、base なし）`, { cwd, argv, base: null, mode: 'subset', files: TAX_AND_PRICE })
  await check(`${name}: tax を変更（${script.join(' ')} 経由）`, { cwd, argv: script, base, mode: 'subset', files: TAX_AND_PRICE })

  git(cwd, 'commit', '-q', '-am', 'tax')
  await check(`${name}: tax の変更を commit した後（base からの差分）`, { cwd, argv, base, mode: 'subset', files: TAX_AND_PRICE })
  await check(`${name}: commit 済みで base なし（HEAD との差分は空）`, { cwd, argv, base: null, mode: 'none', files: [] })

  const head = git(cwd, 'rev-parse', 'HEAD')
  writeFileSync(join(cwd, 'src/unused.js'), 'export const unused = 1\n')
  await check(`${name}: どのテストも読まない新しいファイル（流れる物が無くても失敗にならない）`, { cwd, argv, base: head, mode: 'subset', files: [] })
  rmSync(join(cwd, 'src/unused.js'))

  appendFileSync(join(cwd, 'docs/notes.md'), '\n追記\n')
  await check(`${name}: 文書だけ変更`, { cwd, argv, base: head, mode: 'none', files: [] })
}

try {
  await native('jest', ['npx', '--no-install', 'jest'], ['npm', 'test'])
  await native('vitest', ['npx', '--no-install', 'vitest', 'run'], ['npm', 'test'])

  const { cwd, base } = setUp('node-repo')
  const argv = ['node', '--test', 'test/*.test.mjs']
  await check('node --test: 変更なし', { cwd, argv, base, mode: 'none', files: [] })
  appendFileSync(join(cwd, 'src/tax.mjs'), '\n// 変更\n')
  await check('node --test: tax を変更', { cwd, argv, base, mode: 'subset', files: ['test/price.test.mjs', 'test/tax.test.mjs'] })
  await check('node --test: tax を変更（npm test 経由）', { cwd, argv: ['npm', 'test'], base, mode: 'subset', files: ['test/price.test.mjs', 'test/tax.test.mjs'] })
  writeFileSync(join(cwd, 'templates/hello.txt'), 'Hello, {name}.\n\n')
  git(cwd, 'checkout', '-q', '--', 'src/tax.mjs')
  await check('node --test: new URL で読むひな形を変更', { cwd, argv, base, mode: 'subset', files: ['test/greeting.test.mjs'] })
} finally {
  rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
