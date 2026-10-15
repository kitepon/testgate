// 変異の標本抽出。Stryker の instrumenter を直接呼んで変異を全部列挙し、seed 付きの乱択で N 件選び、
// その位置だけを Stryker の mutate（file:行:桁-行:桁）として出す。Ignorer と違って入れ子の影響が無く、件数が正確。
// 使い方: node sample-mutants.mjs --cwd DIR --glob 'src/**/*.ts' [--glob ...] --sample N [--seed S] [--exclude 'src/**/*.d.ts']
// 出力: JSON { total, sampled, mutate: [...] }
import { globSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { Instrumenter } from '@stryker-mutator/instrumenter'

const args = process.argv.slice(2)
const opt = { cwd: process.cwd(), globs: [], excludes: [], sample: 200, seed: 'testgate' }
for (let i = 0; i < args.length; i++) {
  const a = args[i], v = args[i + 1]
  if (a === '--cwd') opt.cwd = resolve(v), i++
  else if (a === '--glob') opt.globs.push(v), i++
  else if (a === '--exclude') opt.excludes.push(v), i++
  else if (a === '--sample') opt.sample = Number(v), i++
  else if (a === '--seed') opt.seed = v, i++
}
const excluded = new Set(opt.excludes.flatMap(g => globSync(g, { cwd: opt.cwd })))
const names = [...new Set(opt.globs.flatMap(g => globSync(g, { cwd: opt.cwd })))].filter(n => !excluded.has(n)).sort()
const files = names.map(n => ({ name: resolve(opt.cwd, n), mutate: true, content: readFileSync(resolve(opt.cwd, n), 'utf8') }))
const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {}, fatal() {}, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false }
const { mutants } = await new Instrumenter(quiet).instrument(files, { ignorers: [], excludedMutations: [], plugins: null })

// seed から決まる乱数（mulberry32）。同じ seed なら同じ標本。
let s = createHash('sha256').update(opt.seed).digest().readUInt32BE(0)
const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const idx = mutants.map((_, i) => i)
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
// API の location は 0 始まりの行。mutate の範囲指定は 1 始まりの行なので +1 する。桁はそのまま。
const rangeOf = m => `${relative(opt.cwd, m.fileName).split('\\').join('/')}:${m.location.start.line + 1}:${m.location.start.column}-${m.location.end.line + 1}:${m.location.end.column}`
const inRange = (r, m) => (r.start.line < m.location.start.line || (r.start.line === m.location.start.line && r.start.column <= m.location.start.column))
  && (r.end.line > m.location.end.line || (r.end.line === m.location.end.line && r.end.column >= m.location.end.column))
// 選んだ位置の内側にある変異も Stryker は流す（例: 条件式の中の比較演算子）ので、件数が N に近づくまで位置の数を調整する。
const byFile = new Map(); for (const m of mutants) { const a = byFile.get(m.fileName) || []; a.push(m); byFile.set(m.fileName, a) }
function countCovered(chosen) {
  const n = new Set()
  for (const c of chosen) for (const m of byFile.get(c.fileName)) if (inRange(c.location, m)) n.add(m)
  return n.size
}
let k = Math.min(opt.sample, idx.length), chosen, covered
for (let round = 0; round < 4; round++) {
  chosen = idx.slice(0, k).map(i => mutants[i])
  covered = countCovered(chosen)
  if (k >= idx.length || Math.abs(covered - opt.sample) <= Math.max(1, opt.sample * 0.1)) break
  k = Math.max(1, Math.min(idx.length, Math.round(k * opt.sample / covered)))
}
chosen.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.location.start.line - b.location.start.line)
const mutate = [...new Set(chosen.map(rangeOf))]
console.log(JSON.stringify({ total: mutants.length, files: files.length, positions: chosen.length, sampled: covered, seed: opt.seed, mutate }, null, 2))
