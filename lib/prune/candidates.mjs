// Stryker の mutation.json から刈り込み候補を出す。
// 候補: (a) 検出0 = 変異を1つも殺していない試験  (b) 冗長 = 狙いで殺した変異を全部、別の残す試験も狙いで殺している試験
//       (c) 前提のみ = 殺しが全部「前提」（例外・同因の束ね・記録無し）の試験  (d) 広域のみ = 殺しが全部広域の変異の試験
// 各候補に「殺す変異」「狙い／前提」「同じ変異を狙いで殺す残す試験の名前」「変異位置の関数名と元コード」を付ける。消すのは担当。
// 使い方: node candidates.mjs reports/mutation/mutation.json [--json]（testgate prune からは module として使う）
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// ---- 殺しの分類（2026-10-18、エレグ・トロニー・モランの初回採否が 3 repo とも「重なりは共通前提の破壊」で削除 0 本だった） ----

/** 失敗文の 1 行目（空行は飛ばす）。 */
export function firstLine(error) { return String(error ?? '').split('\n').find(l => l.trim())?.trim() || '' }

/** sandbox（…/.stryker-tmp/sandbox-xxx の下）の path を相対にする。 */
export function relativizeSandbox(p) { return String(p).replace(/\\/g, '/').replace(/^.*\/\.stryker-tmp\/sandbox-[^/]+\//, '') }

/** stack の最初の frame のファイル（`at f (file:///…/x.mjs:3:5)`／`at /…/x.ts:3:5`）。node: の内部 frame は飛ばす。無ければ ''。 */
export function firstFrameFile(error) {
  for (const raw of String(error ?? '').split('\n')) {
    const l = raw.trim()
    if (!l.startsWith('at ')) continue
    let loc = l.slice(3).trim()
    const m = /\(([^()]*)\)$/.exec(loc); if (m) loc = m[1]
    loc = loc.replace(/:\d+:\d+$/, '').replace(/:\d+$/, '').replace(/^file:\/\//, '')
    if (/^node:/.test(loc) || loc === '<anonymous>' || loc === 'native' || !loc) continue
    return relativizeSandbox(loc)
  }
  return ''
}

/** 殺し（変異 M を試験 T が殺した）の分類。
 *  狙い = 1 行目が AssertionError で、最初の frame のファイルが T の試験ファイル（試験本文の断言で落ちた）。
 *  前提 = それ以外。TypeError 等の例外、断言でも最初の frame が製品コードや helper の物（前段の呼び出しで落ちた）。
 *  不明 = failures.jsonl に記録が無い（前提と同じ扱い）。 */
export function classifyKill(error, testFile) {
  if (error == null) return '不明'
  if (!/^AssertionError\b/.test(firstLine(error))) return '前提'
  const f = firstFrameFile(error), tf = String(testFile || '').replace(/\\/g, '/')
  return f && tf && (f === tf || f.endsWith('/' + tf)) ? '狙い' : '前提'
}

/** 同因の束ね用に失敗文を正規化する: 1 行目から path・UUID・hex・引用の中身・数値を消し、最初の frame のファイルを付ける。 */
export function failureSignature(error) {
  const s = firstLine(error)
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:)?(?:[\\/][^\s'"`():]+)+/g, '<path>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '<q>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]*\d[0-9a-f]*\b/gi, '<n>')
  return `${s}\u0000${firstFrameFile(error)}`
}

// ---- 変異位置の手がかり（モランの注文 7・8） ----

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'await', 'yield', 'typeof', 'new', 'else', 'do', 'try', 'with', 'case', 'throw', 'delete', 'void', 'import', 'export', 'default'])
const ID = '[A-Za-z_$][\\w$]*'
const RE_FUNCTION = new RegExp(`\\bfunction\\s*\\*?\\s*(${ID})\\s*\\(`)
const RE_ASSIGN = new RegExp(`(?:\\b(?:const|let|var)\\s+|^\\s*(?:(?:public|private|protected|static|readonly|override)\\s+)*(?:${ID}\\.)*)(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>|function\\b)`)
const RE_METHOD = new RegExp(`(?:^|[{},;])\\s*(?:export\\s+)?(?:(?:public|private|protected|static|async|readonly|override|get|set)\\s+)*\\*?\\s*(${ID})\\s*(?:<[^>]*>)?\\s*\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)\\s*(?::\\s*.+)?\\{\\s*$`)
const RE_GO_FUNC = new RegExp(`^\\s*func\\s+(?:\\([^)]*\\)\\s*)?(${ID})\\s*(?:\\[[^\\]]*\\])?\\s*\\(`) // `func Name(`／`func (r *T) Name(`／`func Name[T any](`
const RE_RUST_FN = new RegExp(`\\bfn\\s+(${ID})\\s*(?:<(?:[^<>]|<[^<>]*>)*>)?\\s*\\(`) // `pub async fn name<T>(`
const RE_PY_DEF = new RegExp(`^\\s*(?:async\\s+)?def\\s+(${ID})\\s*\\(`)
const RE_PROPERTY = new RegExp(`(?:^|[{,;])\\s*(${ID})\\s*:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|${ID}\\s*=>)`)
const RE_PARAMS_END = /\)\s*(?::.*)?(?:=>\s*)?\{\s*$/ // 引数の終わりと本体の始まり `): Promise<X> {`／`) => {`／`} = {}) {`
const RE_HEAD_CALL = new RegExp(`(${ID})\\s*(?:<[^>]*>)?\\s*$`) // 開いた `(` の直前が名前
const RE_HEAD_ASSIGN = new RegExp(`(?:\\b(?:const|let|var)\\s+|^\\s*(?:(?:public|private|protected|static|readonly|override)\\s+)*(?:${ID}\\.)*)(${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s*)?$`) // 開いた `(` の直前が `name = `
/** その行が関数を宣言していれば名前（function name(／const name = (…) =>／name(…) {／name: (…) =>）。 */
export function declaredName(s) {
  let m
  if ((m = RE_FUNCTION.exec(s))) return m[1]
  if ((m = RE_GO_FUNC.exec(s)) || (m = RE_RUST_FN.exec(s)) || (m = RE_PY_DEF.exec(s))) return m[1] // Go・Rust・Python の宣言行（ジエン 2026-10-19: Go の候補の殺し 181 件中 119 件が関数不明だった）
  if ((m = RE_ASSIGN.exec(s))) return m[1]
  if ((m = RE_METHOD.exec(s)) && !NOT_NAMES.has(m[1])) return m[1]
  if ((m = RE_PROPERTY.exec(s)) && !NOT_NAMES.has(m[1])) return m[1]
  return null
}
/** `): T {` の行から上へ、閉じていない `(` を持つ行を探し、その `(` の直前の名前（`name(`／`name = (`）を返す。 */
function headerName(lines, i, closeAt) {
  let pending = 0
  for (let k = i; k >= 0; k--) {
    const s = k === i ? lines[k].slice(0, closeAt) : lines[k]
    for (let j = s.length - 1; j >= 0; j--) {
      if (s[j] === ')') pending++
      else if (s[j] === '(') {
        if (pending > 0) { pending--; continue }
        const head = s.slice(0, j), m = RE_HEAD_ASSIGN.exec(head) || RE_HEAD_CALL.exec(head)
        return m && !NOT_NAMES.has(m[1]) ? m[1] : (RE_FUNCTION.exec(head + '(')?.[1] || '')
      }
    }
    if (i - k > 60) break
  }
  return ''
}
/** 変異の行（1 始まり、column は 1 始まりで任意）を囲む関数の名前。変異行に宣言が有ればそれ。無ければ上へ読み、
 *  変異までに閉じていない `{` を持つ宣言行を拾う（`}` は上の `{` と対にして飛ばす）。見つからなければ ''。 */
export function enclosingFunction(lines, line, column) {
  if (!Array.isArray(lines) || !(line >= 1) || line > lines.length) return ''
  const own = declaredName(lines[line - 1])
  if (own) return own
  let pending = 0 // 上の `{` と対になるのを待つ `}` の数
  for (let i = line - 1; i >= 0; i--) {
    const s = i === line - 1 && column >= 1 ? lines[i].slice(0, column - 1) : i === line - 1 ? '' : lines[i]
    let open = false
    for (let j = s.length - 1; j >= 0; j--) { if (s[j] === '}') pending++; else if (s[j] === '{') { if (pending > 0) pending--; else open = true } }
    if (!open) continue
    const end = RE_PARAMS_END.exec(lines[i])
    const name = declaredName(lines[i]) || (end ? headerName(lines, i, end.index) : '')
    if (name) return name
  }
  return ''
}
/** 変異したファイルの元コード。候補集計時の cwd から読む（sandbox ではなく）。報告が source を持ち、cwd のファイルがそれと違う（記録の後に
 *  commit が進んだ等）か読めない時は、変異した時点の元コードである報告の source を使う。 */
function sourceLines(cwd, file, v) {
  let text = null
  if (cwd) { try { text = readFileSync(join(cwd, file), 'utf8') } catch {} }
  if (typeof v?.source === 'string' && (text == null || text !== v.source)) text = v.source
  return text == null ? null : text.split('\n')
}

/** Stryker の mutation.json（オブジェクト）から { tested, tests, kept, candidates, survived, timeouts, … } を返す。
 *  failures: 走者の failures.jsonl の行（{mutant, test, name, error}）。cwd: 元コードを読む所。sameCauseMin: 同因の束ねの閾値（本）。 */
export function analyzeReport(r, { failures = [], cwd = null, sameCauseMin = 3 } = {}) {
  const tests = new Map()
  for (const [tf, v] of Object.entries(r.testFiles || {})) for (const t of v.tests) tests.set(t.id, { id: t.id, name: t.name, file: tf, line: t.location?.start?.line, kills: [] })
  const mutants = []
  for (const [f, v] of Object.entries(r.files)) {
    const lines = sourceLines(cwd, f, v)
    for (const m of v.mutants) {
      const ln = m.location?.start?.line
      const mm = { id: m.id, ids: m.ids || [m.id], key: mutantKey(f, m), file: f, source: sourceHash(v), status: m.status, killedBy: m.killedBy || [], broad: false,
        // 合算（mergeRuns）はその回の元コードから codeLine と functionName を付けて渡す。付いていればファイルの source（最新の回）より優先する
        fn: typeof m.codeLine === 'string' ? (typeof m.functionName === 'string' ? m.functionName : '') : (typeof m.functionName === 'string' && m.functionName) || (lines ? enclosingFunction(lines, ln, m.location?.start?.column) : ''),
        code: typeof m.codeLine === 'string' ? m.codeLine : lines && lines[ln - 1] != null ? lines[ln - 1].trim() : '', kind: new Map(), same: new Map() }
      mutants.push(mm)
      for (const id of mm.killedBy) tests.get(id)?.kills.push(mm)
    }
  }
  const tested = mutants.filter(m => ['Killed', 'Survived', 'Timeout'].includes(m.status)).length
  const threshold = broadThreshold(tests.size)
  for (const m of mutants) m.broad = m.killedBy.length > threshold
  // 失敗の断言／例外（走者の failuresFile）: 変異ID → 試験ID（または名前）→ 失敗の全文
  // 他言語のアダプタ（docs/prune-adapter-contract.md）は失敗の行に kind（狙い／前提）を自分で付けてよい。付いていれば JS 向けの classifyKill より優先する
  const fail = new Map(), failKind = new Map()
  for (const f of failures) for (const t of [f.test, f.name]) { const k = `${f.mutant}\u0000${t}`; if (t && !fail.has(k)) { fail.set(k, String(f.error ?? '')); if (f.kind === '狙い' || f.kind === '前提') failKind.set(k, f.kind) } }
  const rowKey = (m, t) => { for (const id of m.ids) for (const k of [t.id, t.name]) { const key = `${id}\u0000${k}`; if (fail.has(key)) return key } return null }
  const errorOf = (m, t) => { const k = rowKey(m, t); return k == null ? null : fail.get(k) }
  const kindOf = (m, t, e) => { const k = rowKey(m, t); return (k != null && failKind.get(k)) || classifyKill(e, t.file) }
  // 殺しの分類: (a) 失敗の種類と位置 → (b) 同じ変異で sameCauseMin 本以上が同じ形で落ちた物は断言でも前提
  const kinds = { 狙い: 0, 前提: 0, 不明: 0 }
  for (const m of mutants) {
    const sigs = new Map(), sigOf = new Map()
    for (const id of m.killedBy) {
      const t = tests.get(id); if (!t) continue
      const e = errorOf(m, t)
      m.kind.set(id, kindOf(m, t, e))
      if (e != null) { const s = failureSignature(e); sigOf.set(id, s); sigs.set(s, (sigs.get(s) || 0) + 1) }
    }
    for (const id of m.killedBy) {
      if (!m.kind.has(id)) continue
      const n = sigs.get(sigOf.get(id)) || 0
      m.same.set(id, n)
      if (n >= sameCauseMin && m.kind.get(id) === '狙い') m.kind.set(id, '前提')
      kinds[m.kind.get(id)]++
    }
  }
  const aimed = (m, id) => m.kind.get(id) === '狙い'
  const aimedKillers = m => m.killedBy.filter(id => aimed(m, id))
  // 残す試験を貪欲な最小被覆で決める（狙いの殺しだけ。広域の変異は除く）: 1つでも「自分しか狙いで殺さない変異」を持つ試験は必ず残す。
  // 残りは、まだ誰も狙いで殺していない変異を一番多く殺す試験から順に残す。残らなかった試験が候補。
  const kept = new Set()
  const narrow = t => t.kills.filter(m => !m.broad && aimed(m, t.id))
  for (const t of tests.values()) if (narrow(t).some(m => aimedKillers(m).length === 1)) kept.add(t.id)
  const covered = new Set([...kept].flatMap(id => narrow(tests.get(id)).map(m => m.id)))
  for (;;) {
    let best = null, gain = 0
    for (const t of tests.values()) { if (kept.has(t.id)) continue; const g = narrow(t).filter(m => !covered.has(m.id)).length; if (g > gain) { gain = g; best = t } }
    if (!best) break
    kept.add(best.id); for (const m of narrow(best)) covered.add(m.id)
  }
  const detailOf = (t, ms) => ms.map(m => ({ id: m.id, mutant: m.key, fn: m.fn, code: m.code, broad: m.broad, affected: m.killedBy.length, kind: m.kind.get(t.id), same: m.same.get(t.id) ?? 0,
    failure: firstLine(errorOf(m, t)) || undefined, others: m.killedBy.filter(x => kept.has(x) && aimed(m, x)).map(x => tests.get(x)?.name || x) }))
  const out = []
  for (const t of tests.values()) {
    if (kept.has(t.id)) continue
    if (t.kills.length === 0) { out.push({ test: t, reason: '検出0', detail: [] }); continue }
    if (t.kills.every(m => m.broad)) { out.push({ test: t, reason: '広域のみ', detail: detailOf(t, t.kills) }); continue }
    if (narrow(t).length === 0) { out.push({ test: t, reason: '前提のみ', detail: detailOf(t, t.kills) }); continue }
    out.push({ test: t, reason: '冗長', detail: detailOf(t, t.kills) })
  }
  // 生存: 同じファイルの同じ関数で殺された（Killed/Timeout）変異が有れば「有」（未検証の可能性）、無ければ「無」（試験が届いていない可能性）。確定ではない
  const killedFns = new Set(mutants.filter(m => (m.status === 'Killed' || m.status === 'Timeout') && m.fn).map(m => `${m.file}\u0000${m.fn}`))
  const survived = mutants.filter(m => m.status === 'Survived').map(m => ({ id: m.id, mutant: m.key, fn: m.fn, code: m.code, sameFnKilled: m.fn ? (killedFns.has(`${m.file}\u0000${m.fn}`) ? '有' : '無') : '不明' }))
  const timeouts = mutants.filter(m => m.status === 'Timeout').map(m => ({ id: m.id, mutant: m.key, fn: m.fn, code: m.code }))
  const broad = mutants.filter(m => m.broad).map(m => ({ id: m.id, mutant: m.key, affected: m.killedBy.length }))
  const stat = { killed: mutants.filter(m => m.status === 'Killed').length, timeout: timeouts.length, survived: survived.length, errors: mutants.filter(m => m.status === 'RuntimeError' || m.status === 'CompileError').length }
  const files = [...new Set(mutants.map(m => m.file))].sort()
  return { runs: r.runs || 1, tested, tests: tests.size, kept: kept.size, broadThreshold: threshold, sameCauseMin, stat, killKinds: kinds, files, broad, candidates: out.map(o => ({ test: { id: o.test.id, name: o.test.name, file: o.test.file, line: o.test.line }, reason: o.reason, detail: o.detail })), survived, timeouts }
}

/** 複数回の mutation.json を1つに合算する。試験は id で、変異は file:位置:mutator:置換 で束ね、killedBy は和集合、
 *  status は1回でも Killed なら Killed、Killed が無く Timeout が有れば Timeout。seed を変えた月次の積み上げに使う（1回の標本では検出0 が膨らむため）。
 *  reports は古い回から順に渡す。試験の場所とファイルの source は後の回（新しい commit）の物にする。
 *  試験の id は回をまたいで同じ試験を指す物であること（Stryker の番号は回ごとに振り直されるので、mergeRuns が名前に置き換えてから渡す）。 */
export function mergeReports(reports) {
  const files = {}, testFiles = {}
  for (const r of reports) {
    for (const [tf, v] of Object.entries(r.testFiles || {})) {
      const dst = testFiles[tf] ||= { tests: [] }
      for (const t of v.tests) {
        const i = dst.tests.findIndex(x => x.id === t.id)
        if (i < 0) dst.tests.push(t)
        else if (t.location) dst.tests[i] = { ...dst.tests[i], location: t.location }
      }
    }
    for (const [f, v] of Object.entries(r.files || {})) {
      const dst = files[f] ||= { language: v.language, source: v.source, mutants: [] }
      if (typeof v.source === 'string') dst.source = v.source
      if (v.language) dst.language = v.language
      for (const m of v.mutants) {
        const key = `${sourceHash(v)}:${mutantKey(f, m)}` // 元コードが変わった回の変異は別物として扱う
        let e = dst.mutants.find(x => x.__key === key)
        if (!e) { e = { ...m, __key: key, ids: [...(m.ids || [m.id])], killedBy: [...(m.killedBy || [])] }; dst.mutants.push(e); continue }
        e.ids.push(...(m.ids || [m.id])) // 回ごとの変異IDは別なので、失敗の断言の対応用に全部持つ
        for (const id of m.killedBy || []) if (!e.killedBy.includes(id)) e.killedBy.push(id)
        if (m.status === 'Killed') e.status = 'Killed'
        else if (m.status === 'Timeout' && e.status !== 'Killed') e.status = 'Timeout'
      }
    }
  }
  for (const v of Object.values(files)) for (const m of v.mutants) delete m.__key
  return { schemaVersion: reports[0]?.schemaVersion, files, testFiles, runs: reports.length }
}

/** 人が読む形。候補ごとに「殺す変異」（狙い／前提の印、関数名、元コード、失敗の 1 行目）と「同じ変異を狙いで殺す残す試験」（最大3本）を付ける。 */
export function formatCandidates(a, { limit = Infinity, notes = [] } = {}) {
  const lines = []
  const count = r => a.candidates.filter(o => o.reason === r).length
  const zero = count('検出0'), dup = count('冗長'), wide = count('広域のみ'), premise = count('前提のみ')
  const nTimeout = a.stat.timeout ?? 0
  lines.push(`${a.runs > 1 ? `${a.runs} 回分を合算: ` : ''}変異 ${a.tested} 件を流した（Killed ${a.stat.killed}・Timeout ${nTimeout}、生存 ${a.stat.survived}）。試験 ${a.tests} 本のうち残す ${a.kept} 本、候補 ${a.candidates.length} 本（冗長 ${dup}、前提のみ ${premise}、広域のみ ${wide}、検出0 ${zero}）。消すかは担当が決める。`)
  lines.push(`殺し（変異を試験が落とした事）は「狙い」と「前提」に分ける。狙い = 失敗が AssertionError で、stack の最初の frame がその試験ファイル（試験本文の断言で落ちた）。前提 = TypeError 等の例外、断言でも最初の frame が製品コードや helper の物、同じ変異で ${a.sameCauseMin ?? 3} 本以上の試験が同じ形（失敗文から数値・path・引用を消した物）で落ちた物、失敗の記録が無い物（不明）。`)
  lines.push(`「冗長」「残す」は、この標本（${a.files?.length ?? '?'} ファイルの変異）での狙いの殺しの重なりと被覆集合の事。前提の殺しは重なりに数えない。殺した変異が全部前提の試験は「前提のみ」（検出0 と同じ弱さ。採否は求めない）。入力条件・分岐・断言まで代替できるかは、添えた失敗の断言を見て担当が決める。`)
  lines.push(`Timeout の変異（${nTimeout} 件）は試験が止まった事しか分からず killedBy が無いので、検出とは別に数え、被覆の計算に入れない。一覧は末尾。`)
  lines.push(`広域の変異（${a.broadThreshold} 本より多くの試験が同時に落ちる物、${a.broad?.length ?? 0} 件）は共通の起動処理の失敗なので冗長の根拠にしない。それしか検出しない試験は「広域のみ」。`)
  lines.push('検出0 は「今回の標本の変異を1つも殺さなかった試験」。標本に入らなかった所を守っている事があるので、冗長より弱い根拠。')
  lines.push('生存した変異は、未到達の OS 分岐や等価変異を含み得るので「試験の穴」と確定しない。一覧は末尾。')
  lines.push(...notes) // 呼び手の注記（初回試験で除外した試験ファイルなど）
  if (a.broad?.length) lines.push('\n広域の変異: ' + a.broad.map(b => `[${b.id}] ${b.mutant}（${b.affected} 本）`).join(' / '))
  let n = 0
  for (const o of a.candidates) {
    if (n++ >= limit) { lines.push(`\n…ほか ${a.candidates.length - limit} 本（JSON に全部ある）`); break }
    lines.push(`\n[${o.reason}] ${o.test.name}`)
    for (const d of o.detail) {
      lines.push(`  殺す変異: [${d.id}] ${d.mutant} [${d.kind ?? '不明'}]${d.kind === '前提' && d.same >= (a.sameCauseMin ?? 3) ? `（同じ形で ${d.same} 本が落ちる）` : ''}${d.broad ? `（広域: ${d.affected} 本が落ちる）` : ''}`)
      if (d.fn || d.code) lines.push(`    位置: ${d.fn ? `関数 ${d.fn}` : '関数 不明'}${d.code ? ` / ${d.code.slice(0, 160)}` : ''}`)
      if (d.failure) lines.push(`    失敗: ${d.failure.slice(0, 200)}`)
      lines.push(`    同じ変異を狙いで殺す残す試験: ${d.others.length ? d.others.slice(0, 3).join(' / ') + (d.others.length > 3 ? ` ほか${d.others.length - 3}本` : '') : '無し'}`)
    }
  }
  if (a.timeouts?.length) {
    lines.push(`\nTimeout の変異（${a.timeouts.length} 件。どの試験が止めたかは分からないので被覆に入れていない）:`)
    for (const m of a.timeouts) lines.push(`  [${m.id}] ${m.mutant}${m.fn ? `（関数 ${m.fn}）` : ''}${m.code ? ` / ${m.code.slice(0, 160)}` : ''}`)
  }
  if (a.survived?.length && typeof a.survived[0] === 'object') {
    lines.push(`\n生存した変異（${a.survived.length} 件）。「同関数の検出 有」= 同じファイルの同じ関数で殺された変異が有る（未検証の可能性）、「無」= 無い（試験が届いていない可能性）。どちらも確定ではない:`)
    for (const m of a.survived) lines.push(`  [${m.id}] ${m.mutant}${m.fn ? `（関数 ${m.fn}）` : ''} 同関数の検出 ${m.sameFnKilled}${m.code ? ` / ${m.code.slice(0, 160)}` : ''}`)
  }
  return lines.join('\n') + '\n'
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, ...flags] = process.argv.slice(2)
  const a = analyzeReport(JSON.parse(readFileSync(file, 'utf8')))
  process.stdout.write(flags.includes('--json') ? JSON.stringify(a, null, 2) + '\n' : formatCandidates(a))
}
