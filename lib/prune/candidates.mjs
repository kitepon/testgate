// Stryker の mutation.json から刈り込み候補を出す。
// 候補: (a) 検出0 = 変異を1つも殺していない試験  (b) 冗長 = 殺した変異を全部、別の試験も殺している試験
// 各候補に「殺す変異」と「同じ変異を殺す別の試験の名前」を付ける（エレグの要望）。消すのは担当。
// 使い方: node candidates.mjs reports/mutation/mutation.json [--json]（testgate prune からは module として使う）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

/** 変異の識別子。短縮 label ではなく、file・始終の位置・演算子・完全な replacement で一意にする（月次の合算もこれで対応を取る）。 */
export function mutantKey(file, m) {
  const l = m.location || {}
  return `${file}:${l.start?.line}:${l.start?.column}-${l.end?.line}:${l.end?.column} ${m.mutatorName} → ${(m.replacement ?? '').replace(/\s+/g, ' ')}`
}
function sourceHash(v) { return v?.source ? createHash('sha1').update(v.source).digest('hex').slice(0, 8) : null }

/** 広域の変異: 試験の大半（max(10, 20%)より多く）が同時に落ちる変異。共通の起動処理の失敗で、狙いの断言とは限らない。
 *  冗長の根拠にはしない（エレグの指摘 2026-10-16: 候補 238 本のうち 124 本が、197 本に影響する1変異だけを検出していた）。 */
export function broadThreshold(testCount) { return Math.max(10, Math.ceil(testCount * 0.2)) }

/** Stryker の mutation.json（オブジェクト）から { tested, tests, kept, candidates, survived } を返す。 */
export function analyzeReport(r, { failures = [] } = {}) {
  const tests = new Map()
  for (const [tf, v] of Object.entries(r.testFiles || {})) for (const t of v.tests) tests.set(t.id, { id: t.id, name: t.name, file: tf, line: t.location?.start?.line, kills: [] })
  const mutants = []
  for (const [f, v] of Object.entries(r.files)) for (const m of v.mutants) {
    const mm = { id: m.id, ids: m.ids || [m.id], key: mutantKey(f, m), file: f, source: sourceHash(v), status: m.status, killedBy: m.killedBy || [], broad: false }
    mutants.push(mm)
    for (const id of mm.killedBy) tests.get(id)?.kills.push(mm)
  }
  const tested = mutants.filter(m => ['Killed', 'Survived', 'Timeout'].includes(m.status)).length
  const threshold = broadThreshold(tests.size)
  for (const m of mutants) m.broad = m.killedBy.length > threshold
  // 失敗の断言／例外（走者の failuresFile）: 変異ID → 試験ID → 1行目
  const fail = new Map()
  for (const f of failures) {
    const first = String(f.error || '').split('\n').find(l => l.trim()) || ''
    for (const t of [f.test, f.name]) { const k = `${f.mutant}\u0000${t}`; if (t && !fail.has(k)) fail.set(k, first) }
  }
  const failOf = (m, t) => m.ids.flatMap(id => [fail.get(`${id}\u0000${t.id}`), fail.get(`${id}\u0000${t.name}`)]).find(Boolean)
  // 残す試験を貪欲な最小被覆で決める（広域の変異は除いて数える）: 1つでも「自分しか殺さない変異」を持つ試験は必ず残す。
  // 残りは、まだ誰も殺していない変異を一番多く殺す試験から順に残す。残らなかった試験が候補（殺す変異は全部、残す試験が殺す）。
  const kept = new Set()
  const narrow = t => t.kills.filter(m => !m.broad)
  for (const t of tests.values()) if (narrow(t).some(m => m.killedBy.length === 1)) kept.add(t.id)
  const covered = new Set([...kept].flatMap(id => narrow(tests.get(id)).map(m => m.id)))
  for (;;) {
    let best = null, gain = 0
    for (const t of tests.values()) { if (kept.has(t.id)) continue; const g = narrow(t).filter(m => !covered.has(m.id)).length; if (g > gain) { gain = g; best = t } }
    if (!best) break
    kept.add(best.id); for (const m of narrow(best)) covered.add(m.id)
  }
  const detailOf = (t, ms) => ms.map(m => ({ id: m.id, mutant: m.key, broad: m.broad, affected: m.killedBy.length, failure: failOf(m, t), others: m.killedBy.filter(x => kept.has(x)).map(x => tests.get(x)?.name || x) }))
  const out = []
  for (const t of tests.values()) {
    if (kept.has(t.id)) continue
    if (t.kills.length === 0) { out.push({ test: t, reason: '検出0', detail: [] }); continue }
    if (narrow(t).length === 0) { out.push({ test: t, reason: '広域のみ', detail: detailOf(t, t.kills) }); continue }
    out.push({ test: t, reason: '冗長', detail: detailOf(t, t.kills) })
  }
  const survived = mutants.filter(m => m.status === 'Survived').map(m => `${m.id} ${m.key}`)
  const broad = mutants.filter(m => m.broad).map(m => ({ id: m.id, mutant: m.key, affected: m.killedBy.length }))
  const stat = { killed: mutants.filter(m => m.status === 'Killed' || m.status === 'Timeout').length, survived: survived.length, errors: mutants.filter(m => m.status === 'RuntimeError' || m.status === 'CompileError').length }
  const files = [...new Set(mutants.map(m => m.file))].sort()
  return { runs: r.runs || 1, tested, tests: tests.size, kept: kept.size, broadThreshold: threshold, stat, files, broad, candidates: out.map(o => ({ test: { id: o.test.id, name: o.test.name, file: o.test.file, line: o.test.line }, reason: o.reason, detail: o.detail })), survived }
}

/** 複数回の mutation.json を1つに合算する。試験は id で、変異は file:位置:mutator:置換 で束ね、killedBy は和集合、
 *  status は1回でも Killed/Timeout なら Killed。seed を変えた月次の積み上げに使う（1回の標本では検出0 が膨らむため）。 */
export function mergeReports(reports) {
  const files = {}, testFiles = {}
  for (const r of reports) {
    for (const [tf, v] of Object.entries(r.testFiles || {})) {
      const dst = testFiles[tf] ||= { tests: [] }
      for (const t of v.tests) if (!dst.tests.some(x => x.id === t.id)) dst.tests.push(t)
    }
    for (const [f, v] of Object.entries(r.files || {})) {
      const dst = files[f] ||= { language: v.language, source: v.source, mutants: [] }
      for (const m of v.mutants) {
        const key = `${sourceHash(v)}:${mutantKey(f, m)}` // 元コードが変わった回の変異は別物として扱う
        let e = dst.mutants.find(x => x.__key === key)
        if (!e) { e = { ...m, __key: key, ids: [...(m.ids || [m.id])], killedBy: [...(m.killedBy || [])] }; dst.mutants.push(e); continue }
        e.ids.push(...(m.ids || [m.id])) // 回ごとの変異IDは別なので、失敗の断言の対応用に全部持つ
        for (const id of m.killedBy || []) if (!e.killedBy.includes(id)) e.killedBy.push(id)
        if (['Killed', 'Timeout'].includes(m.status) && !['Killed', 'Timeout'].includes(e.status)) e.status = 'Killed'
      }
    }
  }
  for (const v of Object.values(files)) for (const m of v.mutants) delete m.__key
  return { schemaVersion: reports[0]?.schemaVersion, files, testFiles, runs: reports.length }
}

/** 人が読む形。候補ごとに「殺す変異」と「同じ変異を殺す残す試験」（最大3本）を付ける。 */
export function formatCandidates(a, { limit = Infinity } = {}) {
  const lines = []
  const count = r => a.candidates.filter(o => o.reason === r).length
  const zero = count('検出0'), dup = count('冗長'), wide = count('広域のみ')
  lines.push(`${a.runs > 1 ? `${a.runs} 回分を合算: ` : ''}変異 ${a.tested} 件を流した（検出 ${a.stat.killed}、生存 ${a.stat.survived}）。試験 ${a.tests} 本のうち残す ${a.kept} 本、候補 ${a.candidates.length} 本（冗長 ${dup}、広域のみ ${wide}、検出0 ${zero}）。消すかは担当が決める。`)
  lines.push(`「冗長」「残す」は、この標本（${a.files?.length ?? '?'} ファイルの変異）での検出の重なりと被覆集合の事。入力条件・分岐・断言まで代替できるかは、添えた失敗の断言を見て担当が決める。`)
  lines.push(`広域の変異（${a.broadThreshold} 本より多くの試験が同時に落ちる物、${a.broad?.length ?? 0} 件）は共通の起動処理の失敗なので冗長の根拠にしない。それしか検出しない試験は「広域のみ」。`)
  lines.push('検出0 は「今回の標本の変異を1つも殺さなかった試験」。標本に入らなかった所を守っている事があるので、冗長より弱い根拠。')
  lines.push('生存した変異は、未到達の OS 分岐や等価変異を含み得るので「試験の穴」と確定しない。')
  if (a.broad?.length) lines.push('\n広域の変異: ' + a.broad.map(b => `[${b.id}] ${b.mutant}（${b.affected} 本）`).join(' / '))
  let n = 0
  for (const o of a.candidates) {
    if (n++ >= limit) { lines.push(`\n…ほか ${a.candidates.length - limit} 本（JSON に全部ある）`); break }
    lines.push(`\n[${o.reason}] ${o.test.name}`)
    for (const d of o.detail) {
      lines.push(`  殺す変異: [${d.id}] ${d.mutant}${d.broad ? `（広域: ${d.affected} 本が落ちる）` : ''}`)
      if (d.failure) lines.push(`    失敗: ${d.failure.slice(0, 200)}`)
      lines.push(`    同じ変異を殺す残す試験: ${d.others.slice(0, 3).join(' / ')}${d.others.length > 3 ? ` ほか${d.others.length - 3}本` : ''}`)
    }
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, ...flags] = process.argv.slice(2)
  const a = analyzeReport(JSON.parse(readFileSync(file, 'utf8')))
  process.stdout.write(flags.includes('--json') ? JSON.stringify(a, null, 2) + '\n' : formatCandidates(a))
}
