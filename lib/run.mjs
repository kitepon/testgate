// 段階1: 関所が自分でテストコマンドを実行する。生出力を取って件数を読み、合計行を落として返す。
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

// Windows の起動。shell:true は argv を未引用で cmd.exe へ連結するので、--filter の | がパイプになり、
// 空白を含む実行ファイルの道も切れる（fox の実機で出た）。実行ファイル（.exe/.com）は shell を通さず直接起こす。
// .cmd/.bat（npm・npx など）だけは cmd.exe が要るので、引数を自分で引用して渡す。
export function envGet(env, name) {
  const key = Object.keys(env ?? {}).find(k => k.toUpperCase() === name.toUpperCase())
  return key ? env[key] : undefined
}

const WIN_BATCH = new Set(['.cmd', '.bat'])

function isFile(p) { try { return statSync(p).isFile() } catch { return false } }

// 実行ファイルを PATH と PATHEXT で探す。見つからなければ file は元の名前のまま（起動側が ENOENT を出す）。
export function resolveWin(cmd, env = process.env, { exists = isFile, pathMod = path } = {}) {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
  const hasExt = exts.includes(pathMod.extname(cmd).toLowerCase())
  // 拡張子が無い名前は PATHEXT の候補を先に見る。nodejs の npm のように拡張子無しの POSIX 用ファイルが同じ場所にあるため、素の名前は最後。
  const candidates = p => hasExt ? [p] : [...exts.map(e => p + e), p]
  const dirs = /[\\/]/.test(cmd) ? [''] : ['', ...(envGet(env, 'PATH') || '').split(pathMod.delimiter).filter(Boolean)]
  for (const dir of dirs) {
    if (dir === '' && !/[\\/]/.test(cmd)) continue
    for (const file of candidates(dir ? pathMod.join(dir, cmd) : cmd)) {
      if (exists(file)) return { file, batch: WIN_BATCH.has(pathMod.extname(file).toLowerCase()) }
    }
  }
  return { file: cmd, batch: WIN_BATCH.has(pathMod.extname(cmd).toLowerCase()) }
}

// cmd.exe へ渡す 1 語の引用。空白と cmd のメタ文字（& | < > ^ ( ) % ! "）があれば二重引用符で囲む。
// 二重引用符の中では & | < > ^ ( ) が文字になる。内側の " は \" にして CRT の分割に合わせる。
export function quoteCmd(w) {
  if (w === '') return '""'
  if (!/[\s&|<>^()%!"]/.test(w)) return w
  return `"${w.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

export function winSpawnArgs(argv, env = process.env, deps) {
  const { file, batch } = resolveWin(argv[0], env, deps)
  if (!batch) return { file, args: argv.slice(1), options: { windowsHide: true } }
  const line = [file, ...argv.slice(1)].map(quoteCmd).join(' ')
  return { file: envGet(env, 'ComSpec') || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true, windowsHide: true } }
}

export function execCapture(argv, { cwd, env, timeoutMs, forwardOutput = false }) {
  return new Promise(resolve => {
    const started = Date.now()
    const w = process.platform === 'win32' ? winSpawnArgs(argv, env) : { file: argv[0], args: argv.slice(1), options: {} }
    const child = spawn(w.file, w.args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'], ...w.options })
    let out = ''
    const cap = 64 * 1024 * 1024
    const take = d => { if (out.length < cap) out += d }
    child.stdout.on('data', d => { take(d); if (forwardOutput) process.stdout.write(d) })
    child.stderr.on('data', d => { take(d); if (forwardOutput) process.stderr.write(d) })
    let timedOut = false
    let killTimer
    const timer = timeoutMs ? setTimeout(() => {
      timedOut = true; child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
      killTimer.unref()
    }, timeoutMs) : null
    const cleanup = () => { if (timer) clearTimeout(timer); if (killTimer) clearTimeout(killTimer) }
    child.on('error', error => { cleanup(); if (forwardOutput) process.stderr.write(`${error.message}\n`); resolve({ status: 127, output: `${error.message}\n`, durationMs: Date.now() - started, timedOut }) })
    child.on('close', status => { cleanup(); resolve({ status: status ?? 1, output: out, durationMs: Date.now() - started, timedOut }) })
  })
}

// 出力が長い時、成功なら末尾だけ、失敗なら全文（上限あり）
export function trimForModel(text, { ok, maxLines = 400, tailLines = 40 }) {
  const lines = text.split('\n')
  if (ok && lines.length > tailLines) return [`… ${lines.length - tailLines} 行省略（成功）`, ...lines.slice(-tailLines)].join('\n')
  if (!ok && lines.length > maxLines) return [...lines.slice(0, 20), `… ${lines.length - maxLines} 行省略`, ...lines.slice(-(maxLines - 20))].join('\n')
  return text
}
