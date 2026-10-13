// 段階1: 関所が自分でテストコマンドを実行する。生出力を取って件数を読み、合計行を落として返す。
import { spawn } from 'node:child_process'

export function execCapture(argv, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    const started = Date.now()
    const child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' })
    let out = ''
    const cap = 64 * 1024 * 1024
    const take = d => { if (out.length < cap) out += d }
    child.stdout.on('data', take); child.stderr.on('data', take)
    let timedOut = false
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000) }, timeoutMs) : null
    child.on('error', error => { if (timer) clearTimeout(timer); resolve({ status: 127, output: `${error.message}\n`, durationMs: Date.now() - started, timedOut }) })
    child.on('close', status => { if (timer) clearTimeout(timer); resolve({ status: status ?? 1, output: out, durationMs: Date.now() - started, timedOut }) })
  })
}

// 出力が長い時、成功なら末尾だけ、失敗なら全文（上限あり）
export function trimForModel(text, { ok, maxLines = 400, tailLines = 40 }) {
  const lines = text.split('\n')
  if (ok && lines.length > tailLines) return [`… ${lines.length - tailLines} 行省略（成功）`, ...lines.slice(-tailLines)].join('\n')
  if (!ok && lines.length > maxLines) return [...lines.slice(0, 20), `… ${lines.length - maxLines} 行省略`, ...lines.slice(-(maxLines - 20))].join('\n')
  return text
}
