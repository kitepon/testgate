import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'

export function logPath(env = process.env) {
  if (env.TESTGATE_LOG) return env.TESTGATE_LOG
  const base = env.XDG_DATA_HOME || join(env.HOME || homedir(), '.local', 'share')
  return join(base, 'testgate', 'log.jsonl')
}

export async function appendLog(record, env = process.env) {
  const path = logPath(env)
  const row = { ts: new Date().toISOString(), host: hostname(), bot: env.BELLTEAM_BOT_ID || basenameOf(env.BELLTEAM_PROJECT) || null, ...record }
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
