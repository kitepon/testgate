// POSIXの単純コマンド列だけを読む。元のシェル構文は切片として保持する。
// 展開・実行はしない。関数、制御構文、置換、here-doc、backgroundは丸ごと中継する。
import { splitWords, stripPrefix } from './shell-words.mjs'
import { detectRunner } from './detect.mjs'

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in', 'select', 'function', '!', 'time', 'coproc', '[[', ']]'])
const SHELL_STATE = new Set(['.', 'source', 'eval', 'alias', 'unalias', 'exec', 'trap'])

function word(source, start) {
  let i = start
  let quote = ''
  let dynamic = false
  while (i < source.length) {
    const c = source[i]
    if (quote === "'") { i++; if (c === "'") quote = ''; continue }
    if (c === '\\') {
      if (i + 1 >= source.length || /[\r\n]/.test(source[i + 1])) return null
      i += 2; continue
    }
    if (c === '`' || (c === '$' && source[i + 1] === '(')) return null
    if (quote === '"') {
      if (c === '"') quote = ''
      if (c === '$') dynamic = true
      i++; continue
    }
    if (c === "'" || c === '"') { quote = c; i++; continue }
    if (/\s/.test(c) || /[&|;<>]/.test(c)) break
    if (/[(){}]/.test(c)) return null
    if (c === '$') {
      dynamic = true
      // 単純な変数参照だけ。${x:-$(...)}等をコマンド列と誤認しない。
      const variable = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|[?#!$@*0-9]|\{[A-Za-z_][A-Za-z0-9_]*\})/.exec(source.slice(i))
      if (!variable) return null
      i += variable[0].length; continue
    }
    i++
  }
  if (quote || i === start) return null
  const raw = source.slice(start, i)
  const sw = splitWords(raw)
  if (sw.error || sw.words.length !== 1) return null
  // tildeやbrace展開を固定のargvへ変えない。
  dynamic ||= raw.includes('~')
  return { type: 'word', start, end: i, raw, value: sw.words[0], dynamic }
}

export function compoundCommands(source) {
  if (typeof source !== 'string' || source.length > 128 * 1024 || /[\0\r]/.test(source)) return null
  const commands = []
  let tokens = []
  let i = 0
  let needsCommand = false
  const finish = () => {
    if (!tokens.length) return false
    const words = tokens.filter(t => t.type === 'word')
    const { argv } = stripPrefix(words.map(t => t.value))
    if (RESERVED.has(argv[0]) || SHELL_STATE.has(argv[0]) || argv.some(v => v === '[[' || v === ']]')) return false
    commands.push({ start: tokens[0].start, end: tokens.at(-1).end, words, argv,
      redirects: tokens.filter(t => t.type === 'redirect') })
    tokens = []
    return true
  }
  while (i < source.length) {
    if (source[i] === ' ' || source[i] === '\t') { i++; continue }
    if (source[i] === '#') {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    const separator = /^(?:&&|\|\||\||;|\n)/.exec(source.slice(i))?.[0]
    if (separator) {
      // 改行は&&/||/|の後にも置ける。それ以外の空コマンドは扱わない。
      if (separator === '\n' && !tokens.length) { i++; continue }
      if (!finish()) return null
      needsCommand = ![';', '\n'].includes(separator)
      i += separator.length
      continue
    }
    if (source[i] === '&' || source[i] === '(' || source[i] === ')' || source[i] === '{' || source[i] === '}') return null
    const redir = /^(\d*)(>>|>&|<&|>|<)/.exec(source.slice(i))
    if (redir) {
      const start = i
      if (redir[1] && !['0', '1', '2'].includes(redir[1])) return null
      i += redir[0].length
      while (source[i] === ' ' || source[i] === '\t') i++
      const target = word(source, i)
      if (!target) return null
      if (redir[2].endsWith('&') && !['0', '1', '2'].includes(target.value)) return null
      tokens.push({ type: 'redirect', start, end: target.end, raw: source.slice(start, target.end) })
      i = target.end; continue
    }
    const t = word(source, i)
    if (!t) return null
    tokens.push(t)
    needsCommand = false
    i = t.end
  }
  if (tokens.length ? !finish() : needsCommand) return null
  return commands
}

// 置き換える部分以外は、連結子、前後のコマンド、空白、コメントごと残す。
export function rewriteCompound(source, wrap) {
  const commands = compoundCommands(source)
  if (!commands) return null
  const replacements = []
  for (const command of commands) {
    if (!command.argv.length || command.words.some(w => w.dynamic)) continue
    const runner = detectRunner(command.argv)
    if (!runner) continue
    // 元シェルへ戻す時のため、展開前の単純コマンドを保存する。
    // 前置き環境変数はwrapperへ引き継がれるため、fallback引数へ値を複製しない。
    const originalShell = command.words.slice(command.words.length - command.argv.length).map(w => w.raw).join(' ')
    const replacement = wrap({ ...command, ...runner, originalShell })
    if (!replacement) continue
    const redirs = command.redirects.map(t => t.raw)
    replacements.push({ ...command, replacement: [replacement, ...redirs].join(' ') })
  }
  if (!replacements.length) return null
  let result = source
  for (const r of replacements.reverse()) result = result.slice(0, r.start) + r.replacement + result.slice(r.end)
  return { command: result, count: replacements.length }
}

// 段階0の記録用。引用符・$(...)/バッククォート・here-doc の本文の外で、連結子・改行・括弧だけを区切りに分ける。
// compoundCommands は括弧や here-doc を含む複合を読まずに null を返すが、記録は「どこかに本物のテストがあるか」を知りたい。
// 引用符の中の `cargo test|gdb` や here-doc の本文を、別のコマンドとして数えない。
export function splitTopLevel(source) {
  if (typeof source !== 'string') return []
  const parts = []
  let current = ''
  let quote = ''
  const heredocs = []
  let i = 0
  const cut = () => { if (current.trim()) parts.push(current.trim()); current = '' }
  while (i < source.length) {
    const c = source[i]
    if (quote === "'") { current += c; i++; if (c === "'") quote = ''; continue }
    if (c === '\\' && i + 1 < source.length) { current += c + source[i + 1]; i += 2; continue }
    if (quote === '"') { current += c; i++; if (c === '"') quote = ''; continue }
    if (c === "'" || c === '"') { quote = c; current += c; i++; continue }
    if (c === '`' || (c === '$' && source[i + 1] === '(')) {
      // 置換の中は丸ごと一つの語の一部として読み飛ばす。
      const close = c === '`' ? source.indexOf('`', i + 1) : closeParen(source, i + 1)
      const end = close < 0 ? source.length : close + 1
      current += source.slice(i, end); i = end; continue
    }
    const here = /^<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(source.slice(i))
    if (here) { heredocs.push({ tag: here[3], strip: here[1] === '-' }); current += here[0]; i += here[0].length; continue }
    if (c === '\n') {
      cut(); i++
      // here-doc の本文は、終端の行まで読み飛ばす。
      while (heredocs.length && i <= source.length) {
        const { tag, strip } = heredocs.shift()
        for (;;) {
          if (i >= source.length) break
          let end = source.indexOf('\n', i)
          if (end < 0) end = source.length
          const line = source.slice(i, end)
          i = Math.min(end + 1, source.length)
          if ((strip ? line.replace(/^\t+/, '') : line) === tag) break
        }
      }
      continue
    }
    if (/[;|&()]/.test(c)) { cut(); i++; continue }
    current += c; i++
  }
  cut()
  return parts
}

function closeParen(source, from) {
  let depth = 1
  for (let j = from; j < source.length; j++) {
    if (source[j] === '(') depth++
    else if (source[j] === ')' && --depth === 0) return j
  }
  return -1
}
