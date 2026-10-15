// 製品コードの各 .js/.mjs/.cjs の先頭へ「環境変数が無ければ、リポジトリ直下の .active-mutant から効かせる変異番号を読む」ヘッダを足す。
// 試験が子プロセスへ自前の env を渡しても、同じ sandbox の中で動く製品コードには変異が届くようにする（Stryker の切替は env が未設定の間は毎回 env を見直す）。
// 使い方: node inject-active-mutant.mjs <root> --dir dist | --glob 'lib/**/*.mjs' [--glob ...] [--exclude 'test/**' ...]
import { readFileSync, writeFileSync, globSync } from 'node:fs'
import { relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const MARK = '/*__tg_active_mutant__*/'
export function injectFiles(root, files) {
  let n = 0
  for (const rel of files) {
    const file = resolve(root, rel)
    let src = readFileSync(file, 'utf8')
    if (src.includes(MARK)) continue
    const up = relative(dirname(file), root).split('\\').join('/') || '.'
    const target = `${up}/.active-mutant`
    const header = file.endsWith('.cjs')
      ? `${MARK}if (!process.env.__STRYKER_ACTIVE_MUTANT__) { try { process.env.__STRYKER_ACTIVE_MUTANT__ = require("node:fs").readFileSync(require("node:path").join(__dirname, ${JSON.stringify(target)}), "utf8").trim(); } catch {} }\n`
      : `${MARK}import { readFileSync as __tgRead } from "node:fs"; if (!process.env.__STRYKER_ACTIVE_MUTANT__) { try { process.env.__STRYKER_ACTIVE_MUTANT__ = __tgRead(new URL(${JSON.stringify(target)}, import.meta.url), "utf8").trim(); } catch {} }\n`
    if (src.startsWith('#!')) { const i = src.indexOf('\n') + 1; src = src.slice(0, i) + header + src.slice(i) } else src = header + src
    writeFileSync(file, src); n++
  }
  return n
}
export function listTargets(root, { dir, globs = [], exclude = [] }) {
  const pos = dir ? [`${dir.replace(/\/$/, '')}/**/*.{js,mjs,cjs}`] : globs
  const ex = new Set(exclude.flatMap(g => globSync(g, { cwd: root })))
  return [...new Set(pos.flatMap(g => globSync(g, { cwd: root })))].filter(f => !ex.has(f) && !f.includes('node_modules/')).sort()
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...rest] = process.argv.slice(2)
  const opt = { globs: [], exclude: [] }
  for (let i = 0; i < rest.length; i++) { if (rest[i] === '--dir') opt.dir = rest[++i]; else if (rest[i] === '--glob') opt.globs.push(rest[++i]); else if (rest[i] === '--exclude') opt.exclude.push(rest[++i]) }
  if (!opt.dir && !opt.globs.length) opt.dir = 'dist'
  const n = injectFiles(resolve(root), listTargets(resolve(root), opt))
  console.log(`injected ${n} files under ${root}`)
}
