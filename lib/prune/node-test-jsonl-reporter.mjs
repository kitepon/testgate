// node --test の custom reporter。試験1本ごとに1行の JSON を出す（走者 plugin が読む）。
// 出す物: file, line, name（入れ子は " > " で結ぶ）, status(pass|fail|skip), duration_ms, error
const stacks = new Map() // file -> name[] (nesting 順)
function full(d) {
  const st = stacks.get(d.file) || []
  st.length = d.nesting
  return [...st, d.name].join(' > ')
}
export default async function* (source) {
  for await (const ev of source) {
    const d = ev.data
    if (ev.type === 'test:summary' && !(d && d.file)) { yield '\u001e' + JSON.stringify({ done: true }) + '\n'; continue } // 全体の集計 = 全試験が終わった
    if (!d || !d.file) continue
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
    const row = {
      file: d.file, line: d.line, nesting: d.nesting, name: full(d),
      status: ev.type === 'test:fail' ? 'fail' : (d.skip || d.todo ? 'skip' : 'pass'),
      duration_ms: d.details?.duration_ms ?? 0,
      error: ev.type === 'test:fail' ? String(cause?.stack || cause?.message || cause || '').slice(0, 4000) : undefined,
    }
    yield '\u001e' + JSON.stringify(row) + '\n' // 行頭に RS を置き、試験の stdout と混ざっても見分ける
  }
}
