// Stryker の mutation.json から刈り込み候補を出す。
// 候補: (a) 検出0 = 変異を1つも殺していない試験  (b) 冗長 = 殺した変異を全部、別の試験も殺している試験
// 各候補に「殺す変異」と「同じ変異を殺す別の試験の名前」を付ける（エレグの要望）。消すのは担当。
// 使い方: node candidates.mjs reports/mutation/mutation.json [--json]（testgate prune からは module として使う）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Stryker の mutation.json（オブジェクト）から { tested, tests, kept, candidates, survived } を返す。 */
export function analyzeReport(r) {
const tests = new Map()
for (const [tf, v] of Object.entries(r.testFiles || {})) for (const t of v.tests) tests.set(t.id, { id: t.id, name: t.name, file: tf, line: t.location?.start?.line, kills: [] })
const mutants = []
for (const [f, v] of Object.entries(r.files)) for (const m of v.mutants) {
  const label = `${f}:${m.location.start.line}:${m.location.start.column} ${m.mutatorName}${m.replacement ? ' → ' + m.replacement.replace(/\s+/g, ' ').slice(0, 40) : ''}`
  const mm = { id: m.id, label, status: m.status, killedBy: m.killedBy || [] }
  mutants.push(mm)
  for (const id of mm.killedBy) tests.get(id)?.kills.push(mm)
}
const tested = mutants.filter(m => ['Killed', 'Survived', 'Timeout'].includes(m.status)).length
// 残す試験を貪欲な最小被覆で決める: 1つでも「自分しか殺さない変異」を持つ試験は必ず残す。
// 残りは、まだ誰も殺していない変異を一番多く殺す試験から順に残す。残らなかった試験が候補（殺す変異は全部、残す試験が殺す）。
const kept = new Set()
for (const t of tests.values()) if (t.kills.some(m => m.killedBy.length === 1)) kept.add(t.id)
const covered = new Set([...kept].flatMap(id => tests.get(id).kills.map(m => m.id)))
for (;;) {
  let best = null, gain = 0
  for (const t of tests.values()) { if (kept.has(t.id)) continue; const g = t.kills.filter(m => !covered.has(m.id)).length; if (g > gain) { gain = g; best = t } }
  if (!best) break
  kept.add(best.id); for (const m of best.kills) covered.add(m.id)
}
const out = []
for (const t of tests.values()) {
  if (kept.has(t.id)) continue
  if (t.kills.length === 0) { out.push({ test: t, reason: '検出0', detail: [] }); continue }
  out.push({ test: t, reason: '冗長', detail: t.kills.map(m => ({ mutant: m.label, others: m.killedBy.filter(x => kept.has(x)).map(x => tests.get(x)?.name || x) })) })
}
  const survived = mutants.filter(m => m.status === 'Survived').map(m => m.label)
  const stat = { killed: mutants.filter(m => m.status === 'Killed' || m.status === 'Timeout').length, survived: survived.length, errors: mutants.filter(m => m.status === 'RuntimeError' || m.status === 'CompileError').length }
  return { runs: r.runs || 1, tested, tests: tests.size, kept: kept.size, stat, candidates: out.map(o => ({ test: { id: o.test.id, name: o.test.name, file: o.test.file, line: o.test.line }, reason: o.reason, detail: o.detail })), survived }
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
        const key = `${m.location.start.line}:${m.location.start.column}:${m.location.end?.line}:${m.location.end?.column}:${m.mutatorName}:${m.replacement ?? ''}`
        let e = dst.mutants.find(x => x.__key === key)
        if (!e) { e = { ...m, __key: key, killedBy: [...(m.killedBy || [])] }; dst.mutants.push(e); continue }
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
  const zero = a.candidates.filter(o => o.reason === '検出0').length, dup = a.candidates.length - zero
  lines.push(`${a.runs > 1 ? `${a.runs} 回分を合算: ` : ''}変異 ${a.tested} 件を流した（検出 ${a.stat.killed}、生存 ${a.stat.survived}）。試験 ${a.tests} 本のうち残す ${a.kept} 本、候補 ${a.candidates.length} 本（検出0 ${zero}、冗長 ${dup}）。消すかは担当が決める。`)
  lines.push('検出0 は「今回の標本の変異を1つも殺さなかった試験」。標本に入らなかった所を守っている事があるので、冗長より弱い根拠。')
  let n = 0
  for (const o of a.candidates) {
    if (n++ >= limit) { lines.push(`\n…ほか ${a.candidates.length - limit} 本（JSON に全部ある）`); break }
    lines.push(`\n[${o.reason}] ${o.test.name}`)
    for (const d of o.detail) lines.push(`  殺す変異: ${d.mutant}\n    同じ変異を殺す残す試験: ${d.others.slice(0, 3).join(' / ')}${d.others.length > 3 ? ` ほか${d.others.length - 3}本` : ''}`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, ...flags] = process.argv.slice(2)
  const a = analyzeReport(JSON.parse(readFileSync(file, 'utf8')))
  process.stdout.write(flags.includes('--json') ? JSON.stringify(a, null, 2) + '\n' : formatCandidates(a))
}
