// シェルのコマンド行を語に分ける。展開はしない（glob・変数は文字列のまま）。
// 複合コマンド（&& || ; | リダイレクト サブシェル）を見つけたら compound=true。
const CONTROL = new Set(['&&', '||', ';', '|', '>', '>>', '<', '2>', '&>', '2>&1'])

export function splitWords(line) {
  const words = []
  let cur = ''
  let has = false
  let compound = false
  let i = 0
  const push = () => { if (has) { words.push(cur); cur = ''; has = false } }
  while (i < line.length) {
    const c = line[i]
    if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; has = true; i += 2; continue }
    if (c === "'") { const j = line.indexOf("'", i + 1); if (j < 0) return { words: [], compound: true, error: 'unterminated quote' }; cur += line.slice(i + 1, j); has = true; i = j + 1; continue }
    if (c === '"') {
      let j = i + 1
      while (j < line.length && line[j] !== '"') { if (line[j] === '\\' && j + 1 < line.length) j++; j++ }
      if (j >= line.length) return { words: [], compound: true, error: 'unterminated quote' }
      cur += line.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1'); has = true; i = j + 1; continue
    }
    if (c === '$' && line[i + 1] === '(') { compound = true }
    if (c === '`') { compound = true }
    if (/\s/.test(c)) { push(); i++; continue }
    if (c === '&' || c === '|' || c === ';' || c === '>' || c === '<' || c === '(' || c === ')') {
      // 直前が 2 のようなリダイレクト番号なら語ごと制御記号扱い
      push()
      let op = c
      while (i + op.length < line.length && /[&|><1-9]/.test(line[i + op.length]) && op.length < 4) op += line[i + op.length]
      if (op.length > 1 && !CONTROL.has(op)) op = c
      compound = true
      i += op.length
      continue
    }
    cur += c; has = true; i++
  }
  push()
  return { words, compound }
}

// 環境変数の前置き（FOO=1 cmd）と、よくある包み（env, time, nice, npx --yes）を外して本体を返す
export function stripPrefix(words) {
  let w = words.slice()
  const env = {}
  while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { const [k, ...v] = w[0].split('='); env[k] = v.join('='); w.shift() }
  while (w.length) {
    if (w[0] === 'env') { w.shift(); while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) { const [k, ...v] = w[0].split('='); env[k] = v.join('='); w.shift() }; continue }
    if (w[0] === 'time' || w[0] === 'nice' || w[0] === 'nohup') { w.shift(); continue }
    if (w[0] === 'timeout' && w.length > 2) { w.splice(0, 2); continue }
    break
  }
  return { argv: w, env }
}
