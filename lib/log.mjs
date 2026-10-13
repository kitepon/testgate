import { appendFile, mkdir } from 'node:fs/promises'
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
