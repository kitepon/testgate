// testgate 刈り込みアダプタ: Rust（cargo test）と Go（go test）。契約 docs/prune-adapter-contract.md（v0.1）。外部依存なし。
// 変異は自前の字句ベース（演算子・真偽値・否定・整数リテラル）で作り、`go test -json` / `cargo test --no-fail-fast` を変異ごとに流して、
// 落ちた試験を全部 mutation.json の killedBy へ、失敗文と kind（狙い／前提）を failures.jsonl へ書く。
// go-mutesting・cargo-mutants は使わない: 導入が要らない（go と cargo だけで動く）、Windows（fox）でそのまま動く、
// 変異の位置・置換後の全文・標本の seed を自分で持てる、試験ごとの結果を取りこぼさない。
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import path from 'node:path'

export const id = 'rustgo'
export const runners = ['cargo test', 'go test']

const MAX_ERROR = 4000
const posix = p => p.split(path.sep).join('/')

// ============================================================ 字句解析 ============================================================

const GO_KEYWORDS = new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'.split(' '))
const RUST_KEYWORDS = new Set('as async break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct trait type unsafe use where while yield'.split(' '))
const GO_OPS3 = ['<<=', '>>=', '&^=', '...']
const GO_OPS2 = ['&&', '||', '<-', '++', '--', '==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '&^']
const RUST_OPS3 = ['<<=', '>>=', '...', '..=']
const RUST_OPS2 = ['&&', '||', '==', '!=', '<=', '>=', '->', '=>', '::', '..', '+=', '-=', '*=', '/=', '%=', '^=', '&=', '|=', '<<', '>>']

const isIdStart = c => /[A-Za-z_\u0080-\uffff]/.test(c)
const isIdPart = c => /[A-Za-z0-9_\u0080-\uffff]/.test(c)
const isDigit = c => c >= '0' && c <= '9'

function lineIndex(src) {
  const starts = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1)
  return starts
}
function lineOf(starts, off) { // 1 始まりの行
  let lo = 0, hi = starts.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1 }
  return lo + 1
}

/** ソースを意味のあるトークンの列にする（空白・コメントは捨てる）。{ k: 'id'|'num'|'str'|'chr'|'life'|'op', s, i, e }。 */
export function lex(src, lang) {
  const toks = []
  const n = src.length
  const rust = lang === 'rust'
  const ops3 = rust ? RUST_OPS3 : GO_OPS3, ops2 = rust ? RUST_OPS2 : GO_OPS2
  let i = 0
  const push = (k, s, e) => toks.push({ k, s: src.slice(s, e), i: s, e })
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\v') { i++; continue }
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && c2 === '*') {
      let depth = 1; i += 2
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*' && rust) { depth++; i += 2 }
        else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2 }
        else i++
      }
      continue
    }
    if (c === '"') { const s = i; i++; while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; i++ } i++; push('str', s, Math.min(i, n)); continue }
    if (!rust && c === '`') { const s = i; i++; while (i < n && src[i] !== '`') i++; i++; push('str', s, Math.min(i, n)); continue }
    if (c === "'") {
      const s = i
      if (rust) {
        if (c2 === '\\') { i += 2; while (i < n && src[i] !== "'") i++; i++; push('chr', s, Math.min(i, n)); continue }
        const cp = src.codePointAt(i + 1) ?? 0, w = cp > 0xffff ? 2 : 1
        if (src[i + 1 + w] === "'") { i += w + 2; push('chr', s, i); continue }
        i++; while (i < n && isIdPart(src[i])) i++
        push('life', s, i); continue
      }
      i++; if (src[i] === '\\') i++
      i++; while (i < n && src[i] !== "'" && src[i] !== '\n') i++
      i++; push('chr', s, Math.min(i, n)); continue
    }
    if (isDigit(c) || (!rust && c === '.' && isDigit(c2 || ''))) {
      const s = i
      if (c === '0' && /[xXbBoO]/.test(c2 || '')) { i += 2; while (i < n && /[0-9a-fA-F_]/.test(src[i])) i++; if (rust) while (i < n && isIdPart(src[i])) i++ }
      else {
        while (i < n && /[0-9_]/.test(src[i])) i++
        if (src[i] === '.' && (isDigit(src[i + 1] || '') || (!rust && src[i + 1] !== '.'))) { i++; while (i < n && /[0-9_]/.test(src[i])) i++ }
        if (/[eE]/.test(src[i] || '') && /[0-9+-]/.test(src[i + 1] || '')) { i += 2; while (i < n && /[0-9_]/.test(src[i])) i++ }
        if (rust) while (i < n && isIdPart(src[i])) i++
        else if (src[i] === 'i') i++ // 虚数
      }
      push('num', s, i); continue
    }
    if (isIdStart(c)) {
      const s = i
      if (rust) {
        // 文字列接頭辞: r"" r#""# b"" br"" c"" cr"" / b'x'
        const m = /^(?:br|cr|r)(#*)"/.exec(src.slice(i, i + 40))
        if (m) {
          const close = '"' + m[1]
          let j = i + m[0].length
          const end = src.indexOf(close, j)
          i = end < 0 ? n : end + close.length
          push('str', s, i); continue
        }
        if ((c === 'b' || c === 'c') && c2 === '"') { i += 2; while (i < n && src[i] !== '"') { if (src[i] === '\\') i++; i++ } i++; push('str', s, Math.min(i, n)); continue }
        if (c === 'b' && c2 === "'") { i += 2; if (src[i] === '\\') i++; i++; while (i < n && src[i] !== "'") i++; i++; push('chr', s, Math.min(i, n)); continue }
        if (c === 'r' && c2 === '#' && isIdStart(src[i + 2] || '')) { i += 2 }
      }
      while (i < n && isIdPart(src[i])) i++
      push('id', s, i); continue
    }
    const t3 = src.slice(i, i + 3), t2 = src.slice(i, i + 2)
    if (ops3.includes(t3)) { push('op', i, i + 3); i += 3; continue }
    if (ops2.includes(t2)) { push('op', i, i + 2); i += 2; continue }
    push('op', i, i + 1); i++
  }
  return toks
}

// ============================================================ 変異の列挙 ============================================================

const ARITH = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' }
const EQUAL = { '==': '!=', '!=': '==', '<': '<=', '<=': '<', '>': '>=', '>=': '>' }
const LOGIC = { '&&': '||', '||': '&&' }
const ASSIGN = { '+=': '-=', '-=': '+=', '*=': '/=', '/=': '*=' }
const UPDATE = { '++': '--', '--': '++' }

function endsOperand(t, lang) {
  if (!t) return false
  if (t.k === 'num' || t.k === 'str' || t.k === 'chr') return true
  if (t.k === 'id') return !(lang === 'rust' ? RUST_KEYWORDS : GO_KEYWORDS).has(t.s)
  if (t.k === 'op') return t.s === ')' || t.s === ']' || (lang === 'rust' && t.s === '?')
  return false
}
// Rust: `<` が型の総称か比較か。CamelCase の名前（Vec, HashMap, Option）や `::`・`fn 名`・`impl`・`struct 名`の直後は総称。
function rustGenericOpen(toks, idx) {
  const p = toks[idx - 1], pp = toks[idx - 2]
  if (!p) return false
  if (p.k === 'op') return p.s === '::'
  if (p.k !== 'id') return false
  if (RUST_KEYWORDS.has(p.s) && p.s !== 'Self') return true // impl<T> / fn<..> / for<'a>
  if (pp && pp.k === 'id' && /^(fn|struct|enum|trait|type|union)$/.test(pp.s)) return true
  return /^[A-Z][A-Za-z0-9]*[a-z][A-Za-z0-9]*$/.test(p.s) || /^[A-Z]$/.test(p.s)
}

/** Go のソースから変異を列挙する。戻り: [{ off, end, repl, mutatorName, description }]。 */
export function goMutants(src) {
  const toks = lex(src, 'go'), starts = lineIndex(src), out = []
  const lineHead = new Map() // 行 → その行の最初のトークン
  for (const t of toks) { const l = lineOf(starts, t.i); if (!lineHead.has(l)) lineHead.set(l, t.s) }
  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx], prev = toks[idx - 1], next = toks[idx + 1]
    const add = (mutatorName, repl, description) => out.push({ off: t.i, end: t.e, repl, mutatorName, description: description || `\`${t.s}\` → \`${repl}\`` })
    if (t.k === 'op') {
      const bin = endsOperand(prev, 'go')
      const head = lineHead.get(lineOf(starts, t.i))
      if (ARITH[t.s] && bin) {
        if (prev.k === 'str' || next?.k === 'str') continue
        if (t.s === '*' && (/^(func|type|var|const)$/.test(head) || (prev.s === ']' && !endsOperand(toks[matchingOpen(toks, idx - 1) - 1], 'go')))) continue
        add('ArithmeticOperator', ARITH[t.s])
      } else if (EQUAL[t.s] && bin) add('EqualityOperator', EQUAL[t.s])
      else if (LOGIC[t.s] && bin) add('LogicalOperator', LOGIC[t.s])
      else if (ASSIGN[t.s]) add('AssignmentOperator', ASSIGN[t.s])
      else if (UPDATE[t.s] && bin) add('UpdateOperator', UPDATE[t.s])
      else if (t.s === '!' && !bin && next && next.s !== '=') add('UnaryOperator', '', '`!` を外す')
    } else if (t.k === 'id') {
      if ((t.s === 'true' || t.s === 'false') && !(prev && prev.s === '.')) add('BooleanLiteral', t.s === 'true' ? 'false' : 'true')
    } else if (t.k === 'num' && /^(0|[1-9][0-9]{0,14})$/.test(t.s) && !(prev && prev.s === '.')) {
      add('IntegerLiteral', String(Number(t.s) + 1))
    }
  }
  return out
}
function matchingOpen(toks, closeIdx) { // `]` の対の `[` の位置
  let d = 0
  for (let i = closeIdx; i >= 0; i--) { if (toks[i].s === ']') d++; else if (toks[i].s === '[') { d--; if (d === 0) return i } }
  return 0
}

const isCfgTest = a => /^cfg\(.*\btest\b.*\)$/.test(a) && !/\bnot\(\s*test\b/.test(a)
const isTestAttr = a => /^(?:[A-Za-z_][A-Za-z0-9_]*::)*(?:test|rstest|test_case|wasm_bindgen_test)(?:\(.*\))?$/.test(a)

/** Rust のソースを読む。mutants: 変異。regions: 試験コード（cfg(test) の項目と #[test] の関数）の行範囲。testFns: 試験関数（モジュール経路付き）。testModFiles: `#[cfg(test)] mod x;` の x。 */
export function rustScan(src) {
  const toks = lex(src, 'rust'), starts = lineIndex(src)
  const mutants = [], regions = [], testFns = [], testModFiles = []
  let depth = 0, parenDepth = 0, generic = 0
  const mods = [] // { name, open } open = 開き `{` の後の depth
  const regionStack = [] // { open, startLine }
  let pendingAttrs = [], regionNext = null, prev = null, nextTestFn = null
  const inRegion = () => regionStack.length > 0
  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx], next = toks[idx + 1]
    if (t.s === '#' && t.k === 'op' && (next?.s === '[' || (next?.s === '!' && toks[idx + 2]?.s === '['))) {
      const inner = next.s === '!'
      let j = idx + (inner ? 3 : 2), d = 1
      const parts = []
      while (j < toks.length && d > 0) { if (toks[j].s === '[') d++; else if (toks[j].s === ']') { d--; if (d === 0) break } parts.push(toks[j].s); j++ }
      if (!inner) pendingAttrs.push({ text: parts.join(''), line: lineOf(starts, t.i) })
      idx = j; prev = { k: 'op', s: ';' }; continue
    }
    if (t.k === 'id' && t.s === 'macro_rules' && next?.s === '!') { // macro_rules! name { ... } は読まない
      let j = idx + 3
      if (toks[j] && /^[{(\[]$/.test(toks[j].s)) { let d = 0; for (; j < toks.length; j++) { if (/^[{(\[]$/.test(toks[j].s)) d++; else if (/^[})\]]$/.test(toks[j].s)) { d--; if (d === 0) break } } }
      idx = j; pendingAttrs = []; prev = { k: 'op', s: ';' }; continue
    }
    if (t.k === 'id' && t.s === 'mod' && next?.k === 'id' && (toks[idx + 2]?.s === '{' || toks[idx + 2]?.s === ';')) {
      const testy = pendingAttrs.some(a => isCfgTest(a.text))
      if (toks[idx + 2].s === ';') { if (testy) testModFiles.push(next.s); pendingAttrs = []; idx += 2; prev = { k: 'op', s: ';' }; continue }
      mods.push({ name: next.s, open: depth + 1 })
      if (testy) regionNext = { line: pendingAttrs.find(a => isCfgTest(a.text)).line }
      pendingAttrs = []; idx++; prev = next; continue
    }
    if (t.k === 'id' && t.s === 'fn' && next?.k === 'id') {
      const test = pendingAttrs.find(a => isTestAttr(a.text))
      if (test) { nextTestFn = { name: next.s, modPath: mods.map(m => m.name), line: lineOf(starts, next.i) }; regionNext ||= { line: test.line } }
      else if (pendingAttrs.some(a => isCfgTest(a.text))) regionNext ||= { line: pendingAttrs.find(a => isCfgTest(a.text)).line }
      pendingAttrs = []
    } else if (pendingAttrs.length && t.k === 'id' && /^(impl|struct|enum|trait|const|static|use|type|union)$/.test(t.s) && pendingAttrs.some(a => isCfgTest(a.text))) {
      regionNext ||= { line: pendingAttrs.find(a => isCfgTest(a.text)).line }; pendingAttrs = []
    }
    if (t.k === 'op') {
      if (t.s === '{') {
        depth++
        if (regionNext) { regionStack.push({ open: depth, startLine: regionNext.line }); regionNext = null }
        if (nextTestFn) { testFns.push(nextTestFn); nextTestFn = null }
        pendingAttrs = []; generic = 0; prev = t; continue
      }
      if (t.s === '}') {
        if (regionStack.length && regionStack[regionStack.length - 1].open === depth) { const r = regionStack.pop(); regions.push({ start: r.startLine, end: lineOf(starts, t.i) }) }
        if (mods.length && mods[mods.length - 1].open === depth) mods.pop()
        depth--; pendingAttrs = []; generic = 0; prev = t; continue
      }
      if (t.s === ';') {
        if (regionNext) { regions.push({ start: regionNext.line, end: lineOf(starts, t.i) }); regionNext = null }
        nextTestFn = null; pendingAttrs = []; generic = 0; prev = t; continue
      }
      if (t.s === '(' || t.s === '[') parenDepth++
      else if (t.s === ')' || t.s === ']') parenDepth = Math.max(0, parenDepth - 1)
    }
    // 変異（試験コードの中は作らない）
    const emit = (mutatorName, repl, description) => { if (!inRegion()) mutants.push({ off: t.i, end: t.e, repl, mutatorName, description: description || `\`${t.s}\` → \`${repl}\`` }) }
    if (t.k === 'op') {
      const bin = endsOperand(prev, 'rust')
      if (t.s === '<' && (!bin || rustGenericOpen(toks, idx))) generic++
      else if ((t.s === '>' || t.s === '>>') && generic > 0) generic = Math.max(0, generic - (t.s === '>>' ? 2 : 1))
      else if (ARITH[t.s] && bin) { if (!(prev.k === 'str' || next?.k === 'str')) emit('ArithmeticOperator', ARITH[t.s]) }
      else if (EQUAL[t.s] && bin) emit('EqualityOperator', EQUAL[t.s])
      else if (LOGIC[t.s] && bin) emit('LogicalOperator', LOGIC[t.s])
      else if (ASSIGN[t.s]) emit('AssignmentOperator', ASSIGN[t.s])
      else if (t.s === '!' && !bin && next && next.s !== '=' && !(prev && prev.k === 'id' && !RUST_KEYWORDS.has(prev.s))) emit('UnaryOperator', '', '`!` を外す')
    } else if (t.k === 'id') {
      if ((t.s === 'true' || t.s === 'false') && !(prev && prev.s === '.')) emit('BooleanLiteral', t.s === 'true' ? 'false' : 'true')
    } else if (t.k === 'num') {
      const m = /^(0|[1-9][0-9]{0,14})((?:u|i)(?:8|16|32|64|128|size))?$/.exec(t.s)
      if (m && !(prev && prev.s === '.')) emit('IntegerLiteral', String(Number(m[1]) + 1) + (m[2] || ''))
    }
    prev = t
  }
  return { mutants, regions, testFns, testModFiles }
}

/** 変異を適用した全文と、位置（行全体を範囲にした location と、その行の置換後の全文 replacement）を付ける。 */
export function describeMutant(src, m, starts = lineIndex(src)) {
  const line = lineOf(starts, m.off)
  const lineStart = starts[line - 1]
  let lineEnd = src.indexOf('\n', lineStart); if (lineEnd < 0) lineEnd = src.length
  let raw = src.slice(lineStart, lineEnd); const cr = raw.endsWith('\r'); if (cr) { raw = raw.slice(0, -1); lineEnd-- }
  const before = src.slice(lineStart, m.off), after = src.slice(m.end, lineEnd)
  let mutated = before + m.repl + after
  // `!` を外した結果などで空白が重ならないようにする（意味は変えない）
  const lead = raw.length - raw.trimStart().length
  const trimmedOrig = raw.trim()
  mutated = mutated.slice(Math.min(lead, mutated.length)).replace(/\s+$/, '')
  return {
    line, replacement: mutated, code: trimmedOrig,
    location: { start: { line, column: lead + 1 }, end: { line, column: lead + trimmedOrig.length + 1 } },
    token: { start: { line, column: m.off - lineStart + 1 }, end: { line, column: m.end - lineStart + 1 } },
  }
}
export function applyMutant(src, m) { return src.slice(0, m.off) + m.repl + src.slice(m.end) }

// ============================================================ 標本抽出 ============================================================

/** seed から決まる乱数（mulberry32）。同じ seed・同じ列挙なら同じ標本。 */
export function seededRandom(seed) {
  let s = createHash('sha256').update(String(seed)).digest().readUInt32BE(0)
  return () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
/** all: [{ file, off, ... }]（file・off の順に整列済み）から n 件を seed で選ぶ。n が 0 以下か全部以上なら全部。選んだ物は元の順。 */
export function sampleMutants(all, n, seed) {
  if (!(n > 0) || n >= all.length) return all.slice()
  const rnd = seededRandom(seed), idx = all.map((_, i) => i)
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]] }
  return idx.slice(0, n).sort((a, b) => a - b).map(i => all[i])
}

// ============================================================ glob ============================================================

export function globToRegExp(glob) {
  const g = glob.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*' } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}
/** glob のどれかが、候補（path・名前・id）のどれかに当たるか。ワイルドカードの無い glob は basename とも比べる。 */
export function matchesAny(globs, candidates) {
  if (!globs?.length) return false
  const cs = candidates.filter(Boolean).map(c => String(c).replace(/\\/g, '/'))
  return globs.some(g => {
    const re = globToRegExp(g), plain = !/[*?]/.test(g)
    return cs.some(c => re.test(c) || (plain && (c.split('/').pop() === g || c.endsWith('.' + g) || c.endsWith('::' + g))))
  })
}

// ============================================================ 外部コマンド ============================================================

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    else process.kill(-child.pid, 'SIGKILL')
  } catch {}
}
/** 標準出力と標準エラーを同じファイルへ（出力の順序を保つ）。timeoutMs を超えたら子の木ごと止める。 */
function runCmd(cmd, args, { cwd, env, timeoutMs, outFile }) {
  return new Promise(resolve => {
    let fd
    try { fd = openSync(outFile, 'w') } catch (e) { return resolve({ code: -1, text: String(e), timedOut: false, error: e }) }
    let child, timedOut = false, timer = null, settled = false
    const finish = (code, signal, error) => {
      if (settled) return; settled = true
      if (timer) clearTimeout(timer)
      if (child?.pid && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL') } catch {} } // 居残る孫を片づける
      try { closeSync(fd) } catch {}
      let text = ''; try { text = readFileSync(outFile, 'utf8') } catch {}
      resolve({ code, signal, timedOut, text, error })
    }
    try { child = spawn(cmd, args, { cwd, env, stdio: ['ignore', fd, fd], detached: process.platform !== 'win32', windowsHide: true }) } catch (e) { return finish(-1, null, e) }
    child.on('error', e => finish(-1, null, e))
    child.on('close', (code, signal) => finish(code, signal))
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; killTree(child) }, timeoutMs)
  })
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts })
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), error: r.error }
}

// ============================================================ Go ============================================================

const GENERATED_RE = /^\/\/ Code generated .* DO NOT EDIT\.?$/m

function goModuleName(cwd) {
  try { return /^\s*module\s+(\S+)/m.exec(readFileSync(path.join(cwd, 'go.mod'), 'utf8'))?.[1]?.replace(/^"|"$/g, '') || null } catch { return null }
}
export function goPatterns(cwd) {
  if (existsSync(path.join(cwd, 'go.mod'))) return ['./...']
  try { // go.work だけの根: use するディレクトリごと
    const text = readFileSync(path.join(cwd, 'go.work'), 'utf8')
    const dirs = []
    for (const m of text.matchAll(/^\s*use\s+([^\s(]\S*)\s*(?:\/\/.*)?$/gm)) dirs.push(m[1])
    for (const m of text.matchAll(/^\s*use\s*\(([\s\S]*?)\)/gm)) for (const l of m[1].split('\n')) { const d = l.replace(/\/\/.*$/, '').trim(); if (d) dirs.push(d) }
    const pats = dirs.sort().map(d => `./${posix(d).replace(/^\.\//, '').replace(/\/$/, '')}/...`.replace('./././', './'))
    return pats.length ? pats : ['./...']
  } catch { return ['./...'] }
}

/** `go test -json` の出力を読む。試験ごとの状態と出力、パッケージごとの状態、build 失敗、timeout を返す（純粋）。 */
export function parseGoTestJson(text) {
  const tests = new Map(), pkgs = new Map()
  let buildFailed = false, timedOut = false
  const stray = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let ev
    if (line.startsWith('{')) { try { ev = JSON.parse(line) } catch { ev = null } }
    if (!ev) { stray.push(line); if (/\[(build|setup) failed\]/.test(line)) buildFailed = true; continue }
    if (ev.FailedBuild || (ev.ImportPath && /\[(build|setup) failed\]/.test(ev.Output || ''))) buildFailed = true
    const pkg = ev.Package || ev.ImportPath || ''
    if (/\[(build|setup) failed\]/.test(ev.Output || '') && !ev.Test) buildFailed = true
    if (/^panic: test timed out after/m.test(ev.Output || '')) timedOut = true
    if (ev.Test) {
      const key = pkg + '\u0000' + ev.Test
      let t = tests.get(key); if (!t) { t = { pkg, name: ev.Test, status: null, output: [] }; tests.set(key, t) }
      if (ev.Action === 'output') t.output.push(ev.Output)
      else if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') t.status = ev.Action
    } else {
      let p = pkgs.get(pkg); if (!p) { p = { pkg, status: null, output: [] }; pkgs.set(pkg, p) }
      if (ev.Action === 'output') p.output.push(ev.Output)
      else if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') p.status = ev.Action
    }
  }
  return { tests, pkgs, buildFailed, timedOut, stray }
}

const GO_NOISE = /^\s*(=== (RUN|PAUSE|CONT|NAME)\b|--- (PASS|FAIL|SKIP):|PASS$|FAIL$|ok\s|FAIL\s|\?\s|exit status \d+$)/
/** 試験の出力から失敗文を作る（見出し・要約の行を除く）。 */
export function goFailureText(output) {
  return output.join('').split('\n').filter(l => l.trim() && !GO_NOISE.test(l)).join('\n').trim()
}
// 狙い／前提。試験本文（_test.go の行）の t.Error / t.Fatal / testify の失敗は狙い。panic・製品側の行・build・timeout・記録なしは前提。
export function classifyGoFailure(error) {
  const e = String(error || '')
  if (!e) return '前提'
  if (/^panic: |\n\s*panic: |^fatal error: |goroutine \d+ \[/m.test(e)) return '前提'
  if (/^\s*[^\s:]*_test\.go:\d+(?::\d+)?:/m.test(e)) return '狙い'
  if (/Error Trace:\s+\S*_test\.go:\d+/.test(e)) return '狙い'
  return '前提'
}

/** parseGoTestJson の結果から、通った試験（seen）と落ちた試験（failed）を取り出す（純粋）。
 *  子を持つ親は、子の失敗の要約だけなら数えない。panic でプロセスごと落ちて pass/fail が付かなかった試験（run のまま）は、
 *  自分の出力に panic が有る物（または、途中の試験がそれ 1 本だけで package に panic が有る物）を落ちた試験として数える。 */
export function goFailedTests(p) {
  const failed = [], seen = []
  const names = [...p.tests.values()]
  const hasChild = new Map()
  for (const t of names) { const parent = t.name.includes('/') ? t.name.slice(0, t.name.lastIndexOf('/')) : null; if (parent) hasChild.set(t.pkg + '\u0000' + parent, true) }
  const pkgPanic = new Map(), unfinishedLeaves = new Map()
  for (const [pk, pv] of p.pkgs) { const txt = pv.output.join(''); if (/^panic: |^fatal error: /m.test(txt)) pkgPanic.set(pk, txt.split('\n').filter(l => !GO_NOISE.test(l)).join('\n').trim()) }
  const unfinished = t => t.status === null && p.pkgs.get(t.pkg)?.status === 'fail'
  for (const t of names) if (unfinished(t) && !hasChild.get(t.pkg + '\u0000' + t.name)) unfinishedLeaves.set(t.pkg, (unfinishedLeaves.get(t.pkg) || 0) + 1)
  for (const t of names) {
    const parentWithKids = hasChild.get(t.pkg + '\u0000' + t.name)
    const idv = `${t.pkg}.${t.name}`
    if (t.status === 'pass') { if (!parentWithKids) seen.push({ id: idv, name: idv, pkg: t.pkg, testName: t.name, status: 'pass' }); continue }
    let err = goFailureText(t.output)
    if (t.status === 'fail') {
      if (!err && pkgPanic.has(t.pkg)) err = pkgPanic.get(t.pkg)
    } else if (unfinished(t)) {
      if (parentWithKids) continue
      if (/^panic: |^fatal error: /m.test(err)) { /* 自分の出力に panic が有る */ }
      else if (unfinishedLeaves.get(t.pkg) === 1 && pkgPanic.has(t.pkg)) err = err ? err + '\n' + pkgPanic.get(t.pkg) : pkgPanic.get(t.pkg)
      else continue
    } else continue
    const hasOwn = /^\s*\S+\.go:\d+/m.test(err) || /Error Trace:/.test(err) || /^panic: /m.test(err)
    if (t.status === 'fail' && parentWithKids && !hasOwn) continue // 子の失敗の要約だけの親は数えない
    failed.push({ id: idv, name: idv, pkg: t.pkg, testName: t.name, error: clip(err), kind: classifyGoFailure(err) })
    seen.push({ id: idv, name: idv, pkg: t.pkg, testName: t.name, status: 'fail' })
  }
  return { failed, seen }
}

/** パッケージの dir（import path → dir）と試験関数の場所（dir\0名前 → { file, line }）。 */
function goTestIndex(cwd, env, patterns) {
  const r = sh('go', ['list', '-f', '{{.ImportPath}}\t{{.Dir}}\t{{join .GoFiles ","}}\t{{join .CgoFiles ","}}\t{{join .TestGoFiles ","}}\t{{join .XTestGoFiles ","}}', ...patterns], { cwd, env })
  const dirs = new Map(), prod = [], testFile = new Map()
  for (const l of r.out.split('\n')) {
    const [ip, dir, gof, cgo, tgo, xgo] = l.split('\t')
    if (!ip || !dir) continue
    dirs.set(ip.replace(/ \[.*\]$/, ''), dir)
    for (const f of [...(gof || '').split(','), ...(cgo || '').split(',')].filter(Boolean)) prod.push(posix(path.relative(cwd, path.join(dir, f))))
    for (const f of [...(tgo || '').split(','), ...(xgo || '').split(',')].filter(Boolean)) {
      const abs = path.join(dir, f), rel = posix(path.relative(cwd, abs))
      let src = ''; try { src = readFileSync(abs, 'utf8') } catch {}
      let m; const re = /^func\s+((?:Test|Example|Fuzz)\w*)\s*\(/gm
      const starts = lineIndex(src)
      while ((m = re.exec(src))) testFile.set(dir + '\u0000' + m[1], { file: rel, line: lineOf(starts, m.index) })
    }
  }
  return { dirs, prod, testFile, ok: r.status === 0, err: r.err }
}

// ============================================================ Rust ============================================================

/** `cargo test` の出力（stdout と stderr を順序通りに混ぜた物）を読む（純粋）。 */
export function parseCargoTest(text) {
  const sections = []
  let cur = null, fail = null
  const lines = String(text).split('\n')
  let compileError = /could not compile|error: aborting due to|^error(\[E\d+\])?: /m.test(text) && /could not compile/.test(text)
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    let m = /^\s+Running (.+?) \((.+?)\)\s*$/.exec(line)
    if (m) {
      const stem = path.basename(m[2].replace(/\\/g, '/')).replace(/\.exe$/i, '').replace(/-[0-9a-f]{16}$/, '')
      cur = { header: m[1].trim(), target: stem, tests: new Map(), failed: [] }
      sections.push(cur); fail = null; continue
    }
    if (/^\s+Doc-tests /.test(line)) { cur = null; fail = null; continue }
    if (!cur) continue
    m = /^test (.+?) \.\.\. (ok|FAILED|ignored)(?:, .*)?$/.exec(line)
    if (m) { cur.tests.set(m[1], { name: m[1], status: m[2] === 'ok' ? 'pass' : m[2] === 'FAILED' ? 'fail' : 'skip', output: [] }); fail = null; continue }
    m = /^---- (.+?) stdout ----$/.exec(line)
    if (m) { fail = { name: m[1], lines: [] }; cur.failed.push(fail); continue }
    if (/^failures:\s*$/.test(line) || /^test result:/.test(line) || /^error: test failed/.test(line) || /^running \d+ tests?$/.test(line)) { fail = null; continue }
    if (fail) fail.lines.push(line)
  }
  for (const s of sections) for (const f of s.failed) { const t = s.tests.get(f.name); if (t) t.output = f.lines }
  return { sections, compileError }
}

/** panic の位置 `path:line:col` と本文。新旧の書式（`panicked at path:l:c:\nmsg` / `panicked at 'msg', path:l:c`）を読む。 */
export function rustPanic(output) {
  const text = Array.isArray(output) ? output.join('\n') : String(output || '')
  let m = /panicked at (.+?):(\d+):(\d+):?\n([\s\S]*?)(?:\nnote: |\n*$)/.exec(text)
  if (m) return { file: m[1], line: Number(m[2]), message: m[4].trim() }
  m = /panicked at '([\s\S]*?)', (.+?):(\d+):(\d+)/.exec(text)
  if (m) return { file: m[2], line: Number(m[3]), message: m[1].trim() }
  return null
}
const RUNTIME_PANIC = /^called `(?:Option|Result)::(?:unwrap|expect)|^attempt to |^index out of bounds|^byte index |^explicit panic$|^already (?:borrowed|mutably borrowed)|^called `Result::unwrap_err|^slice index|^range (?:start|end) index/
/** isTestCode(file, line): panic の位置が試験コード（tests/・cfg(test)・#[test]）か。狙い = 試験コードでの assert 系の panic。 */
export function classifyRustFailure(output, isTestCode) {
  const p = rustPanic(output)
  if (!p) return '前提'
  if (!isTestCode(p.file, p.line)) return '前提'
  if (/^assertion\b/.test(p.message)) return '狙い'
  return RUNTIME_PANIC.test(p.message) ? '前提' : '狙い'
}

function cargoMetadata(cwd, env) {
  const r = sh('cargo', ['metadata', '--no-deps', '--format-version', '1'], { cwd, env, maxBuffer: 64 << 20 })
  if (r.status !== 0) return null
  try { return JSON.parse(r.out) } catch { return null }
}

// 試験関数 → ファイルの対応のためのモジュール経路
function rustFileMods(rel, rootKind) {
  const parts = rel.split('/')
  const i = parts.lastIndexOf(rootKind)
  const tail = parts.slice(i + 1)
  if (rootKind === 'src') {
    if (tail[0] === 'bin') { const rest = tail.slice(1); if (rest.length <= 1) return []; const r2 = rest.slice(1); const last = r2.pop().replace(/\.rs$/, ''); return [...r2, ...(last === 'mod' || last === 'main' ? [] : [last])] }
    const last = tail.pop().replace(/\.rs$/, '')
    return [...tail, ...(last === 'lib' || last === 'main' || last === 'mod' ? [] : [last])]
  }
  const last = tail.pop().replace(/\.rs$/, '')
  return tail.length === 0 ? [] : [...tail, ...(last === 'mod' ? [] : [last])]
}

// ============================================================ 共通の流れ ============================================================

function listFiles(root, rel, accept, skipDir) {
  const out = []
  const walk = d => {
    let ents = []; try { ents = readdirSync(path.join(root, d), { withFileTypes: true }) } catch { return }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = d ? d + '/' + e.name : e.name
      if (e.isDirectory()) { if (!skipDir(e.name, r)) walk(r) } else if (e.isFile() && accept(r)) out.push(r)
    }
  }
  walk(rel)
  return out
}
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'target', 'testdata', '.testgate-prune', '.idea', '.vscode'])

function nowMs() { return Date.now() }
function fileLog(logFile, text) { try { appendFileSync(logFile, text.endsWith('\n') ? text : text + '\n') } catch {} }
const clip = (s, n = MAX_ERROR) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

function copySandbox(from, to, { skipTarget = true } = {}) {
  cpSync(from, to, {
    recursive: true, verbatimSymlinks: true,
    filter: p => { const rel = posix(path.relative(from, p)); return !(rel === '.git' || rel.startsWith('.git/') || rel === 'node_modules' || rel === '.testgate-prune' || (skipTarget && (rel === 'target' || rel.startsWith('target/')))) },
  })
}

/** どちらの言語か。runner が渡されればそれ、無ければ go.mod／go.work か Cargo.toml の有る方（両方なら go）。 */
export function languageOf(cwd, runner) {
  if (runner === 'go' || runner === 'go test') return 'go'
  if (runner === 'cargo' || runner === 'cargo test') return 'cargo'
  if (existsSync(path.join(cwd, 'go.mod')) || existsSync(path.join(cwd, 'go.work'))) return 'go'
  if (existsSync(path.join(cwd, 'Cargo.toml'))) return 'cargo'
  return null
}

export async function detect(cwd) {
  return languageOf(cwd) !== null
}

export async function name(cwd) {
  const lang = languageOf(cwd)
  if (lang === 'go') return goModuleName(cwd) || path.basename(cwd)
  try {
    const t = readFileSync(path.join(cwd, 'Cargo.toml'), 'utf8')
    const sec = /\[package\]([\s\S]*?)(?=\n\[|$)/.exec(t)
    const m = sec && /^\s*name\s*=\s*"([^"]+)"/m.exec(sec[1])
    if (m) return m[1]
  } catch {}
  return path.basename(cwd)
}

/** 結果の変換（純粋）: 変異ごとの走行結果 → mutation.json の変異の status と killedBy、failures の行。 */
export function judgeRun(run, { excludedTest = () => false, baselineFailed = new Set() } = {}) {
  if (run.timedOut) return { status: 'Timeout', killedBy: [], failures: [] }
  if (run.compileError) return { status: 'CompileError', killedBy: [], failures: [] }
  const failed = run.failed.filter(f => !baselineFailed.has(f.id))
  const counted = failed.filter(f => !excludedTest(f))
  if (counted.length) return { status: 'Killed', killedBy: counted.map(f => f.id), failures: counted }
  if (failed.length) return { status: 'Survived', killedBy: [], failures: [] } // 除外した試験だけが落ちた
  if (run.failed.length === 0 && run.exitCode !== 0) return { status: 'RuntimeError', killedBy: [], failures: [] } // 試験が落ちたのではなく、道具が非 0 で終わった（TestMain の exit、abort 等）
  return { status: 'Survived', killedBy: [], failures: [] }
}

export async function prune(opts) {
  const { cwd: cwd0, runDir, logFile, sample = 200, seed = 'testgate', mutate = [], tests: testGlobs = [], exclude = [], timeoutMs = 60000, jobs, keepSandbox = false, env: env0 = process.env, log = () => {}, runner } = opts
  const cwd = path.resolve(cwd0)
  const lang = languageOf(cwd, runner)
  if (!lang) { log('testgate prune: go.mod / go.work / Cargo.toml が cwd に無い'); return { status: 2 } }
  const isGo = lang === 'go'
  const env = { ...env0, NO_COLOR: '1', CARGO_TERM_COLOR: 'never', RUST_BACKTRACE: '0' }
  delete env.CARGO_TARGET_DIR
  const tool = isGo ? 'go' : 'cargo'
  const ver = sh(tool, isGo ? ['version'] : ['--version'], { cwd, env })
  if (ver.status !== 0) { log(`testgate prune: ${tool} が動かない: ${ver.error?.message || ver.err}`); fileLog(logFile, `${tool} が動かない: ${ver.error?.message || ver.err}`); return { status: 2 } }
  log(`testgate prune: 道具 ${ver.out.split('\n')[0]}（自前の変異エンジン。外部の変異道具は不要）`)
  fileLog(logFile, `# ${ver.out}`)
  const runnerLabel = isGo ? 'go test' : 'cargo test'
  const root = mkdtempSync(path.join(tmpdir(), 'tg-prune-rustgo-'))
  const started = nowMs()
  try {
    return await pruneIn({ lang, isGo, cwd, runDir, logFile, sample, seed, mutate, testGlobs, exclude, timeoutMs, jobs, keepSandbox, env, log, root, runnerLabel, verLine: ver.out.split('\n')[0], started })
  } finally {
    if (keepSandbox) log(`testgate prune: 作業の写しを残した: ${root}`)
    else { try { rmSync(root, { recursive: true, force: true }) } catch {} }
  }
}

async function pruneIn(c) {
  const { lang, isGo, cwd, runDir, logFile, sample, seed, mutate, testGlobs, exclude, timeoutMs, env, log, root, runnerLabel } = c
  const notes = []
  // ---- プロジェクトを読む ----
  let copyRoot = cwd, sub = '', patterns = null, goIdx = null, meta = null
  if (isGo) {
    patterns = goPatterns(cwd)
    goIdx = goTestIndex(cwd, env, patterns)
    if (!goIdx.ok) { log(`testgate prune: go list が失敗: ${goIdx.err.slice(0, 500)}`); fileLog(logFile, `go list が失敗: ${goIdx.err}`); return { status: 2 } }
  } else {
    meta = cargoMetadata(cwd, env)
    if (!meta) { log('testgate prune: cargo metadata が失敗'); return { status: 2 } }
    copyRoot = path.resolve(meta.workspace_root)
    sub = posix(path.relative(copyRoot, cwd))
  }
  // ---- 変異対象のファイル ----
  const rels = [] // cwd からの相対 path
  const testRegions = new Map(), rustTestFns = [], rustTestFiles = new Set()
  if (isGo) {
    const set = new Set(goIdx.prod)
    for (const f of [...set].sort()) {
      let head = ''; try { head = readFileSync(path.join(cwd, f), 'utf8').slice(0, 2000) } catch { continue }
      if (GENERATED_RE.test(head) || /\.pb\.go$/.test(f)) continue
      if (/(^|\/)(vendor|testdata)\//.test(f)) continue
      rels.push(f)
    }
  } else {
    const cand = new Set()
    for (const p of meta.packages) {
      const pdir = path.dirname(p.manifest_path)
      const srcDir = path.join(pdir, 'src')
      for (const f of listFiles(pdir, 'src', r => r.endsWith('.rs'), (n, r) => SKIP_DIRS.has(n))) cand.add(posix(path.relative(cwd, path.join(pdir, f))))
      void srcDir
      for (const f of listFiles(pdir, 'tests', r => r.endsWith('.rs'), n => SKIP_DIRS.has(n))) rustTestFiles.add(posix(path.relative(cwd, path.join(pdir, f))))
    }
    const own = [...cand].filter(f => !f.startsWith('../'))
    // `#[cfg(test)] mod x;` の x.rs は試験
    const scans = new Map()
    for (const f of own) { let s; try { s = readFileSync(path.join(cwd, f), 'utf8') } catch { continue } scans.set(f, rustScan(s)) }
    for (const [f, sc] of scans) for (const mname of sc.testModFiles) {
      const dir = path.posix.dirname(f), base = path.posix.basename(f, '.rs')
      const mdir = ['lib', 'main', 'mod'].includes(base) ? dir : dir + '/' + base
      rustTestFiles.add(mdir + '/' + mname + '.rs'); rustTestFiles.add(mdir + '/' + mname + '/mod.rs')
    }
    for (const f of own.sort()) if (!rustTestFiles.has(f) && !/(^|\/)(tests|benches|examples)\//.test(f)) rels.push(f)
    for (const [f, sc] of scans) { testRegions.set(f, sc.regions); for (const t of sc.testFns) rustTestFns.push({ ...t, file: f }) }
    for (const f of [...rustTestFiles].sort()) {
      if (scans.has(f)) continue
      let s; try { s = readFileSync(path.join(cwd, f), 'utf8') } catch { continue }
      const sc = rustScan(s); for (const t of sc.testFns) rustTestFns.push({ ...t, file: f })
    }
  }
  let targets = rels
  if (mutate.length) {
    // --mutate: glob に当たる、試験でも生成物でもない製品コード
    const all = isGo ? goIdx.prod.map(String) : rels
    targets = [...new Set(all)].filter(f => matchesAny(mutate, [f])).sort()
  }
  // ---- 試験を流す道具の形 ----
  const sandboxes = [path.join(root, 'w0')]
  copySandbox(copyRoot, sandboxes[0], { skipTarget: !isGo })
  const runIn = (box) => path.join(box, sub)
  const goArgsFor = sec => ['test', '-json', '-vet=off', `-timeout=${sec}s`, ...(patterns || [])]
  let goArgs = goArgsFor(Math.max(5, Math.ceil(Math.max(timeoutMs * 5, 300000) * 0.9 / 1000)))
  const cargoArgs = ['test', '--workspace', '--tests', '--no-fail-fast']
  const outName = i => path.join(root, `out-${i}.txt`)

  const idPrefix = new Map() // Rust: header|target → id の接頭辞（baseline で決める）
  const rustId = (sec, name) => `${idPrefix.get(sec.header + '|' + sec.target) ?? sec.target}::${name}`

  /** 1 回流して、落ちた試験（id・name・error・kind）と状態を返す。 */
  const execute = async (box, wi, timeout) => {
    if (!isGo) return interpret(await runCmd('cargo', cargoArgs, { cwd: runIn(box), env, timeoutMs: timeout, outFile: outName(wi) }), box)
    // Go は panic すると、そのパッケージの残りの試験が走らない。panic した試験を -skip して、その package だけ流し直し、落ちた試験を全部集める
    let merged = null, args = goArgs
    const skipped = new Set()
    for (let round = 0; round < 6; round++) {
      const cur = interpret(await runCmd('go', args, { cwd: runIn(box), env, timeoutMs: timeout, outFile: outName(wi) }), box)
      merged = merged ? mergeExec(merged, cur) : cur
      if (cur.timedOut || cur.compileError || cur.spawnError) break
      const panicked = cur.failed.filter(f => /^panic: |^fatal error: /m.test(f.error))
      const fresh = panicked.filter(f => !skipped.has(f.pkg + '\u0000' + f.testName.split('/')[0]))
      if (!fresh.length) break
      for (const f of fresh) skipped.add(f.pkg + '\u0000' + f.testName.split('/')[0])
      const pkgs = [...new Set(fresh.map(f => f.pkg))]
      const names = [...skipped].map(k => k.split('\u0000')[1])
      args = [...goArgs.filter(a => !(patterns || []).includes(a)), '-skip', `^(${names.join('|')})$`, ...pkgs]
    }
    return merged
  }
  function mergeExec(a, b) {
    const seenIds = new Set(a.failed.map(f => f.id))
    return { ...a, timedOut: a.timedOut || b.timedOut, compileError: a.compileError || b.compileError, spawnError: a.spawnError || b.spawnError, exitCode: a.exitCode || b.exitCode,
      failed: [...a.failed, ...b.failed.filter(f => !seenIds.has(f.id))], seen: [...a.seen, ...b.seen], text: a.text + '\n' + b.text }
  }
  function tool() { return isGo ? 'go' : 'cargo' }
  const goPkgDir = ip => goIdx.dirs.get(ip) || ''
  function goTestInfo(t) { return goIdx.testFile.get(goPkgDir(t.pkg) + '\u0000' + t.testName.split('/')[0]) }
  const rustIsTestCode = (file, line) => {
    let f = String(file).replace(/\\/g, '/')
    if (path.isAbsolute(f)) f = posix(path.relative(copyRoot, f).startsWith('..') ? f : path.relative(copyRoot, f))
    f = path.posix.normalize(sub && f.startsWith(sub + '/') ? f.slice(sub.length + 1) : f)
    const rel = f.replace(/^\.\//, '')
    if (rustTestFiles.has(rel) || /(^|\/)tests\//.test(rel)) return true
    return (testRegions.get(rel) || []).some(r => line >= r.start && line <= r.end)
  }

  function interpret(r, box) {
    // 作業の写しの絶対 path を失敗文から消す（解釈の後。Windows の \\ は JSON の中で \\\\ になるので、読む前の文字列では消せない）
    const scrub = e => { if (!box) return e; const nat = runIn(box); return String(e).split(nat + path.sep).join('').split(posix(nat) + '/').join('') }
    const out = { timedOut: r.timedOut, exitCode: r.code, compileError: false, failed: [], seen: [], text: r.text, spawnError: r.error }
    if (isGo) {
      const p = parseGoTestJson(r.text)
      out.compileError = p.buildFailed
      if (p.timedOut) out.timedOut = true
      const g = goFailedTests(p)
      out.failed = g.failed; out.seen = g.seen
    } else {
      const p = parseCargoTest(r.text)
      out.compileError = p.compileError
      for (const sec of p.sections) for (const t of sec.tests.values()) {
        if (t.status === 'skip') continue
        const idv = rustId(sec, t.name)
        out.seen.push({ id: idv, name: idv, sec, testName: t.name, status: t.status })
        if (t.status === 'fail') { const err = clip(t.output.join('\n').trim()); out.failed.push({ id: idv, name: idv, sec, testName: t.name, error: err, kind: classifyRustFailure(err, rustIsTestCode) }) }
      }
    }
    for (const f of out.failed) f.error = scrub(f.error)
    return out
  }

  // ---- 下見: 変異なしで 1 回流す（試験の一覧・落ちる試験の除外） ----
  log(`testgate prune: 下見（変異なしで ${runnerLabel} を 1 回）`)
  const t0 = nowMs()
  let base = await execute(sandboxes[0], 0, Math.max(timeoutMs * 5, 300000))
  const baselineMs = nowMs() - t0
  fileLog(logFile, `# 下見 ${baselineMs}ms exit=${base.exitCode}\n${clip(base.text, 20000)}`)
  if (base.spawnError) { log(`testgate prune: ${tool()} を起動できない: ${base.spawnError.message}`); return { status: 2 } }
  if (base.timedOut) { log('testgate prune: 下見が時間切れ。--timeout-sec を延ばすか、試験を絞って'); return { status: 2 } }
  if (base.compileError) { log('testgate prune: 下見の build が通らない（変異の前に直る必要がある）。詳細は prune.log'); return { status: 2 } }
  if (!isGo) { // Rust の id の接頭辞: 同じ target 名で header が複数なら header を付けて区別する
    const p = parseCargoTest(base.text)
    const byTarget = new Map()
    for (const s of p.sections) { const k = s.target; const set = byTarget.get(k) || new Set(); set.add(s.header); byTarget.set(k, set) }
    for (const s of p.sections) idPrefix.set(s.header + '|' + s.target, byTarget.get(s.target).size > 1 ? `${s.target}[${s.header}]` : s.target)
    base = interpret({ text: base.text, code: base.exitCode, timedOut: false }, null)
  }
  if (base.seen.length === 0) { log('testgate prune: 下見で試験が 1 本も見つからない。出力は prune.log'); return { status: 2 } }
  const baselineFailed = new Set(base.failed.map(f => f.id))
  const dryRunExcluded = [...baselineFailed].sort()
  if (dryRunExcluded.length) log(`testgate prune: 下見で落ちた試験 ${dryRunExcluded.length} 本は除外する（変異なしでも落ちる）`)
  // 変異 1 件の上限: 下見の 2 倍 + 10 秒より短ければ延ばす（全試験を流す時間が上限を超えると全変異が Timeout になる）。
  // 逆に下見が短ければ、上限より早く打ち切る（`i++` → `i--` のような無限ループを毎回 --timeout-sec いっぱい待たない。下見の 4 倍 + 10 秒）。
  let mutantTimeout = Math.min(timeoutMs, baselineMs * 4 + 10000)
  if (baselineMs * 2 + 10000 > timeoutMs) { mutantTimeout = Math.ceil(baselineMs * 2 + 10000); notes.push(`下見が ${Math.round(baselineMs / 1000)} 秒かかったため、変異 1 件の上限を ${Math.round(mutantTimeout / 1000)} 秒に延ばした`); log(`testgate prune: ${notes.at(-1)}`) }
  if (isGo) goArgs = goArgsFor(Math.max(5, Math.ceil(mutantTimeout * 0.9 / 1000)))

  // ---- 試験の一覧（mutation.json の testFiles） ----
  const excludedGlobs = exclude
  const testFileOf = t => {
    if (isGo) { const info = goTestInfo(t); return info ? { file: info.file, line: info.line } : { file: '', line: undefined } }
    // Rust: 名前の経路と target から試験関数の場所を探す
    const name = t.testName, segs = name.split('::'), fn = segs.pop(), mods = segs
    const isIt = f => f.startsWith('tests/') || f.includes('/tests/')
    const c = rustTestFns.filter(x => x.name === fn && [...rustFileMods(x.file, isIt(x.file) ? 'tests' : 'src'), ...x.modPath].join('::') === mods.join('::'))
    const hit = c.find(x => (isIt(x.file) ? path.posix.basename(x.file, '.rs').replace(/-/g, '_') === t.sec.target.replace(/-/g, '_') : true)) || c[0]
    return hit ? { file: hit.file, line: hit.line } : { file: '', line: undefined }
  }
  const testInfo = new Map() // id → { name, file, line, excluded }
  const excludedNow = new Set()
  for (const t of base.seen) {
    if (t.status !== 'pass') continue
    const loc = testFileOf(t)
    const short = isGo ? t.testName : t.testName
    const filtered = (testGlobs.length && !matchesAny(testGlobs, [loc.file, t.id, short])) || matchesAny(excludedGlobs, [loc.file, t.id, short, t.name])
    if (filtered) { excludedNow.add(loc.file && matchesAny(excludedGlobs, [loc.file]) ? loc.file : t.id); testInfo.set(t.id, { ...loc, excluded: true }); continue }
    testInfo.set(t.id, { ...loc, excluded: false, name: t.name })
  }
  const excludedTest = f => testInfo.get(f.id)?.excluded === true
  const liveTests = [...testInfo.entries()].filter(([, v]) => !v.excluded)
  if (liveTests.length === 0) { log('testgate prune: 流せる試験が残らない（--tests / --exclude を確かめて）'); return { status: 2 } }

  // ---- 変異の列挙と標本 ----
  const sources = new Map(), all = []
  for (const f of targets) {
    let src; try { src = readFileSync(path.join(cwd, f), 'utf8') } catch { continue }
    sources.set(f, src)
    const ms = isGo ? goMutants(src) : rustScan(src).mutants
    ms.sort((a, b) => a.off - b.off)
    for (const m of ms) all.push({ file: f, ...m })
  }
  if (all.length === 0) { log('testgate prune: 変異が 1 件も作れない（--mutate の範囲を確かめて）'); return { status: 2 } }
  const picked = sampleMutants(all, sample, seed)
  const posCount = new Set(picked.map(m => `${m.file}:${m.off}`)).size
  log(`testgate prune: 変異 ${all.length} 件から ${picked.length} 件を標本にして流す（seed ${seed}、ファイル ${new Set(picked.map(m => m.file)).size}、試験 ${liveTests.length} 本、下見 ${Math.round(baselineMs / 100) / 10} 秒）`)

  // ---- 流す ----
  const nJobs = Math.max(1, Math.min(picked.length, Number(c.jobs) > 0 ? Number(c.jobs) : (isGo ? Math.max(1, Math.min(4, Math.floor(cpus().length / 2))) : 1)))
  for (let i = 1; i < nJobs; i++) { const dst = path.join(root, `w${i}`); cpSync(sandboxes[0], dst, { recursive: true, verbatimSymlinks: true }); sandboxes.push(dst) }
  const results = new Array(picked.length)
  let next = 0, done = 0
  const worker = async wi => {
    const box = sandboxes[wi]
    for (;;) {
      const k = next++
      if (k >= picked.length) return
      const m = picked[k]
      const abs = path.join(runIn(box), m.file), original = sources.get(m.file)
      let res
      try {
        writeFileSync(abs, applyMutant(original, m))
        res = await execute(box, wi, mutantTimeout)
      } finally { try { writeFileSync(abs, original) } catch {} }
      results[k] = res
      done++
      if (done % Math.max(1, Math.round(picked.length / 10)) === 0 || done === picked.length) log(`testgate prune: ${done}/${picked.length} 件`)
    }
  }
  await Promise.all(Array.from({ length: nJobs }, (_, i) => worker(i)))

  // ---- 書く ----
  const files = {}, failuresLines = []
  const statusCount = {}
  const fileMutants = new Map()
  picked.forEach((m, k) => {
    const res = results[k], verdict = judgeRun(res, { excludedTest, baselineFailed })
    const d = describeMutant(sources.get(m.file), m)
    const mid = String(k)
    const mutant = { id: mid, mutatorName: m.mutatorName, replacement: d.replacement, location: d.location, status: verdict.status, description: m.description }
    if (verdict.status === 'Killed') mutant.killedBy = verdict.killedBy
    else mutant.killedBy = []
    statusCount[verdict.status] = (statusCount[verdict.status] || 0) + 1
    if (!fileMutants.has(m.file)) fileMutants.set(m.file, [])
    fileMutants.get(m.file).push(mutant)
    for (const f of verdict.failures) failuresLines.push(JSON.stringify({ mutant: mid, test: f.id, name: f.name, error: f.error, kind: f.kind }))
    if (['CompileError', 'RuntimeError', 'Timeout'].includes(verdict.status)) fileLog(logFile, `# 変異 ${mid} ${m.file}:${d.line} ${m.mutatorName} → ${verdict.status}\n${clip(res.text, 3000)}`)
    else fileLog(logFile, `# 変異 ${mid} ${m.file}:${d.line} ${m.mutatorName} ${m.description} → ${verdict.status}${verdict.killedBy.length ? ` (${verdict.killedBy.length} 本)` : ''}`)
  })
  for (const [f, ms] of fileMutants) files[f] = { language: isGo ? 'go' : 'rs', source: sources.get(f), mutants: ms }
  // 試験: 下見で通った物 + 殺した物（一覧に無い親テスト等）
  const testFiles = {}
  const addTest = (idv, nameV, loc) => { const key = loc.file || ''; (testFiles[key] ||= { tests: [] }).tests.push({ id: idv, name: nameV, ...(loc.line ? { location: { start: { line: loc.line } } } : {}) }) }
  const known = new Set()
  for (const [idv, v] of liveTests) { addTest(idv, idv, v); known.add(idv) }
  for (const line of failuresLines) { const f = JSON.parse(line); if (!known.has(f.test) && !baselineFailed.has(f.test)) { addTest(f.test, f.name, isGo ? { file: '', line: undefined } : { file: '', line: undefined }); known.add(f.test) } }
  for (const v of Object.values(testFiles)) v.tests.sort((a, b) => (a.id < b.id ? -1 : 1))
  const report = { schemaVersion: '1', thresholds: { high: 80, low: 60 }, files, testFiles }
  writeFileSync(path.join(runDir, 'mutation.json'), JSON.stringify(report, null, 2) + '\n')
  writeFileSync(path.join(runDir, 'failures.jsonl'), failuresLines.length ? failuresLines.join('\n') + '\n' : '')
  const sampled = { total: all.length, sampled: picked.length, positions: posCount }
  writeFileSync(path.join(runDir, 'project.json'), JSON.stringify({
    cwd, runner: runnerLabel, adapter: 'rustgo/prune.mjs', tool: c.verLine, engine: '自前の字句ベース変異（ArithmeticOperator・EqualityOperator・LogicalOperator・AssignmentOperator・UpdateOperator・UnaryOperator・BooleanLiteral・IntegerLiteral）',
    command: isGo ? `go ${goArgs.join(' ')}` : `cargo ${cargoArgs.join(' ')}`, testList: isGo ? '下見の go test -json' : '下見の cargo test の出力',
    sampled, seed, mutateFiles: [...fileMutants.keys()], mutate, tests: testGlobs, exclude, excluded: [...excludedNow], dryRunExcluded,
    timeoutMs: mutantTimeout, baselineMs, status: statusCount,
  }, null, 2) + '\n')
  notes.unshift(`${runnerLabel}: 自前の字句ベース変異（演算子・真偽値・否定・整数リテラル）。関数本体の置換・文の削除は無い。変異 ${all.length} 件から ${picked.length} 件、状態 ${Object.entries(statusCount).map(([k, v]) => `${k} ${v}`).join('・')}`)
  const compileShare = (statusCount.CompileError || 0) / picked.length
  if (compileShare > 0.3) notes.push(`CompileError が ${Math.round(compileShare * 100)}%（型・総称の見分けが外れた変異。候補の集計からは外れる）`)
  return { status: 0, runner: runnerLabel, sampled, excluded: [...excludedNow], dryRunExcluded, notes }
}
