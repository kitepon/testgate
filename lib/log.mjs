import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

export function logPath(env = process.env) {
  if (env.TESTGATE_LOG) return env.TESTGATE_LOG
  // 置き場は ~/.local/state（BellTeam の夜のバックアップに入る。~/.local/share は入らない）
  const base = env.XDG_STATE_HOME || join(env.HOME || homedir(), '.local', 'state')
  return join(base, 'testgate', 'log.jsonl')
}

// 記録に残すコマンドから、前置きの環境変数の値を消す（TOKEN=… npm test など）
export function redactCommand(command) {
  if (typeof command !== 'string') return command
  return command.replace(/(^|\s|&&\s*|;\s*|\|\s*|\benv\s+)([A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|\S+)/g, '$1$2=***')
}

export async function appendLog(record, env = process.env) {
  const path = logPath(env)
  const row = { ts: new Date().toISOString(), host: hostname(), bot: env.BELLTEAM_BOT_ID || basenameOf(env.BELLTEAM_PROJECT) || null, ...record }
  if ('command' in row) row.command = redactCommand(row.command)
  if (row.ran) row.ran = redactCommand(row.ran)
  try {
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, JSON.stringify(row) + '\n')
  } catch (error) {
    // 記録に失敗しても hook は止めない
    process.stderr.write(`testgate: log failed: ${error.message}\n`)
  }
  return row
}

function basenameOf(p) { return p ? p.split('/').filter(Boolean).pop() : null }

// 直近 n 行を読む（post の突き合わせ用）
export function readRecent(n = 200, env = process.env) {
  try {
    const lines = readFileSync(logPath(env), 'utf8').trim().split('\n')
    return lines.slice(-n).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}
