// JS プロジェクトの読み取り: package.json の test script から node --test の引数と試験ファイル、build の要否、変異対象を決める。
import { existsSync, readFileSync, globSync } from 'node:fs'
import { join } from 'node:path'
import { splitWords, stripPrefix } from '../shell-words.mjs'

const TEST_DIR_GLOBS = ['test/**', 'tests/**', '__tests__/**', 'spec/**', 'fixtures/**', '**/fixtures/**', '**/*.test.*', '**/*.spec.*', '**/*.fixture.*']
const NOISE_GLOBS = ['node_modules/**', '**/node_modules/**', 'dist/**', 'build/**', 'out/**', 'coverage/**', '.stryker-tmp/**', 'reports/**', 'scripts/**', 'vendor/**', 'prototype/**', 'docs/**', '**/*.d.ts', '**/*.config.*', '**/*.min.js']

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) } catch { return null } }

/** test script を && で分け、node --test の段だけを拾う。`npm run X` は scripts の X へ展開する（入れ子は3段まで）。`tsx --test` は node --test に `--import tsx` を付けた物として読む。 */
export function parseNodeTestScript(script, scripts = {}, depth = 0) {
  const segments = String(script || '').split(/\s*(?:&&|;)\s*/).filter(Boolean)
  const out = { nodeArgs: [], files: [], testArgs: [], buildScript: null, runner: null }
  const merge = sub => { out.nodeArgs.push(...sub.nodeArgs); out.files.push(...sub.files); out.testArgs.push(...sub.testArgs); out.buildScript ||= sub.buildScript; if (sub.runner === 'node --test' || !out.runner) out.runner = sub.runner }
  for (const seg of segments) {
    const sw = splitWords(seg)
    if (sw.error) continue
    const { argv } = stripPrefix(sw.words)
    if (!argv.length) continue
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(argv[0]) && argv[1] === 'run' && argv[2] === 'build') { out.buildScript = 'build'; continue }
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(argv[0]) && argv[1] === 'run' && argv[2] && scripts[argv[2]] && depth < 3) { merge(parseNodeTestScript(scripts[argv[2]], scripts, depth + 1)); continue }
    const isTsx = (argv[0] === 'tsx') || ((argv[0] === 'npx' || argv[0] === 'pnpx') && argv[1] === 'tsx')
    if ((/^node[0-9.]*$/.test(argv[0]) || isTsx) && argv.includes('--test')) {
      out.runner = 'node --test'
      const i = argv.indexOf('--test')
      if (isTsx) out.nodeArgs.push('--import', 'tsx')
      for (const a of argv.slice(isTsx && argv[0] !== 'tsx' ? 2 : 1, i)) out.nodeArgs.push(a)
      for (const a of argv.slice(i + 1)) {
        if (a.startsWith('--test-reporter') || a.startsWith('--test-reporter-destination')) continue // こちらの reporter に替える
        if (a.startsWith('-')) out.testArgs.push(a); else out.files.push(a)
      }
      continue
    }
    if (argv[0] === 'jest' || argv[0] === 'vitest' || ((argv[0] === 'npx' || argv[0] === 'pnpx') && (argv[1] === 'jest' || argv[1] === 'vitest'))) {
      out.runner ||= argv[0] === 'npx' || argv[0] === 'pnpx' ? argv[1] : argv[0] // node --test の段があればそちらを優先（試験1本単位で取れる）
    }
  }
  // --import a --import b のような対を保ったまま、重複を消す
  const seen = new Set(); const nodeArgs = []
  for (let i = 0; i < out.nodeArgs.length; i++) {
    const a = out.nodeArgs[i]; const pair = (a === '--import' || a === '--require' || a === '-r' || a === '--loader') ? `${a} ${out.nodeArgs[++i]}` : a
    if (!seen.has(pair)) { seen.add(pair); nodeArgs.push(...pair.split(' ')) }
  }
  out.nodeArgs = nodeArgs
  out.files = [...new Set(out.files)]
  return out
}

/**
 * 返り値: { runner, nodeArgs, files, testArgs, exclude, build: { script, distDir } | null, mutate: [...], inject: { dir } | { globs, exclude } }
 * 判断できない時は { error } を返す。
 */
export function inspectJsProject(cwd, { mutate: mutateOverride, tests: testsOverride, exclude = [], runner: runnerOverride } = {}) {
  let pkg = readJson(join(cwd, 'package.json'))
  if (!pkg && !runnerOverride) return { error: 'package.json が無い（--runner と --tests で指定すれば流せる）' }
  pkg ||= {}
  const parsed = parseNodeTestScript(pkg.scripts?.test, pkg.scripts || {})
  const runner = runnerOverride || parsed.runner || (pkg.devDependencies?.jest || pkg.dependencies?.jest ? 'jest' : pkg.devDependencies?.vitest ? 'vitest' : null)
  if (!runner) return { error: `test script からランナーが分からない: ${JSON.stringify(pkg.scripts?.test ?? null)}（--runner node-test|jest|vitest と --tests で指定すれば流せる）` }
  const files = testsOverride?.length ? testsOverride : parsed.files
  if (runner === 'node --test' && !files.length) return { error: 'node --test の試験ファイルが test script に無い（ファイル指定無しの node --test は流さない。--tests で指定できる）' }
  const tsconfig = readJson(join(cwd, 'tsconfig.json'))
  const hasBuild = !!pkg.scripts?.build
  let build = null, mutate, inject
  const stripTypes = [...parsed.nodeArgs, ...parsed.testArgs].some(a => a === '--experimental-strip-types' || a === '--experimental-transform-types') || files.some(f => /\.ts$/.test(f)) // 旗は --test の前でも後でも効く
  if (stripTypes && (tsconfig || files.some(f => /\.ts$/.test(f)))) {
    // 試験が src の .ts を直接読む（Node の strip-types）。build は要らず、変異も注入も src の .ts に直接する（yui の形）
    const rootDir = (tsconfig?.compilerOptions?.rootDir || 'src').replace(/^\.\//, '').replace(/\/$/, '')
    const globs = [`${rootDir}/**/*.ts`]
    mutate = [...globs, `!${rootDir}/**/*.d.ts`, `!${rootDir}/**/*.test.ts`, `!${rootDir}/**/*.spec.ts`, ...TEST_DIR_GLOBS.map(g => '!' + g), ...NOISE_GLOBS.map(g => '!' + g)]
    inject = { globs, exclude: [...TEST_DIR_GLOBS, ...NOISE_GLOBS] }
  } else if (tsconfig && hasBuild) {
    const rootDir = (tsconfig.compilerOptions?.rootDir || 'src').replace(/^\.\//, '').replace(/\/$/, '')
    const distDir = (tsconfig.compilerOptions?.outDir || 'dist').replace(/^\.\//, '').replace(/\/$/, '')
    build = { script: parsed.buildScript || 'build', distDir }
    mutate = [`${rootDir}/**/*.ts`, `!${rootDir}/**/*.d.ts`, `!${rootDir}/**/*.test.ts`, `!${rootDir}/**/*.spec.ts`]
    inject = { dir: distDir }
  } else {
    const srcLike = ['src', 'lib', 'bin', 'app'].filter(d => existsSync(join(cwd, d)))
    const globs = srcLike.length ? srcLike.map(d => `${d}/**/*.{js,mjs,cjs}`) : ['**/*.{js,mjs,cjs}']
    mutate = [...globs, ...TEST_DIR_GLOBS.map(g => '!' + g), ...NOISE_GLOBS.map(g => '!' + g)]
    inject = { globs, exclude: [...TEST_DIR_GLOBS, ...NOISE_GLOBS] }
  }
  if (mutateOverride?.length) mutate = mutateOverride
  const positive = mutate.filter(g => !g.startsWith('!'))
  const negative = new Set(mutate.filter(g => g.startsWith('!')).flatMap(g => globSync(g.slice(1), { cwd })))
  const sources = [...new Set(positive.flatMap(g => globSync(g, { cwd })))].filter(f => !negative.has(f)).sort()
  if (!sources.length) return { error: `変異する対象が無い: ${mutate.join(' ')}` }
  return { runner, nodeArgs: parsed.nodeArgs, files, testArgs: parsed.testArgs, exclude, build, mutate, sources, inject, name: pkg.name || null }
}
