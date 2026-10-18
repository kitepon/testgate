// node --test の custom reporter。試験1本ごとに1行の JSON を出す（走者 plugin が読む）。
// 出す物: file, line, name（入れ子は " > " で結ぶ）, status(pass|fail|skip), duration_ms, error
// 試験ファイル自体が読み込みで落ちた時（import 失敗・構文エラー・トップレベルの例外）は、node が name=ファイルパスの test:fail を
// 1行出すだけで error は "test failed" しか持たない。その時は file=true を立て、そのファイルの stderr（例外の本文）を error に添える。
import { resolve } from 'node:path'
const stacks = new Map() // file -> name[] (nesting 順)
const stderrs = new Map() // file -> そのファイルの子プロセスが stderr に書いた物（末尾 4000 字）
const STDERR_KEEP = 4000
function full(d) {
  const st = stacks.get(d.file) || []
  st.length = d.nesting
  return [...st, d.name].join(' > ')
}
function isFileRow(d) { return d.nesting === 0 && !!d.file && resolve(d.name) === resolve(d.file) }
export default async function* (source) {
  for await (const ev of source) {
    const d = ev.data
    if (ev.type === 'test:summary' && !(d && d.file)) { yield '\u001e' + JSON.stringify({ done: true }) + '\n'; continue } // 全体の集計 = 全試験が終わった
    if (!d || !d.file) continue
    if (ev.type === 'test:stderr') {
      const key = resolve(d.entryFile || d.file)
      const s = (stderrs.get(key) || '') + String(d.message || '')
      stderrs.set(key, s.length > STDERR_KEEP ? s.slice(-STDERR_KEEP) : s)
      continue
    }
    if (ev.type === 'test:start') {
      const st = stacks.get(d.file) || []
      st.length = d.nesting
      st[d.nesting] = d.name
      stacks.set(d.file, st)
      continue
    }
    if (ev.type !== 'test:pass' && ev.type !== 'test:fail') continue
    const err = d.details?.error
    const cause = err?.cause && (err.cause.message || err.cause.stack) ? err.cause : err
    const fileRow = isFileRow(d)
    let error = ev.type === 'test:fail' ? String(cause?.stack || cause?.message || cause || '') : undefined
    if (fileRow && ev.type === 'test:fail') { const se = (stderrs.get(resolve(d.file)) || '').trim(); if (se) error = se }
    const row = {
      file: d.file, line: d.line, nesting: d.nesting, name: full(d),
      status: ev.type === 'test:fail' ? 'fail' : (d.skip || d.todo ? 'skip' : 'pass'),
      duration_ms: d.details?.duration_ms ?? 0,
      error: error === undefined ? undefined : error.slice(0, 4000),
      ...(fileRow ? { fileRow: true } : {}),
    }
    yield '\u001e' + JSON.stringify(row) + '\n' // 行頭に RS を置き、試験の stdout と混ざっても見分ける
  }
}
