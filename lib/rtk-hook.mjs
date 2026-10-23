// RTKへのhook中継。試験の選択・実行や配置先の登録はここでは扱わない。
import { spawnSync } from 'node:child_process'

// Grok には RTK 自身の hook が無い。native PreToolUse の入力を中継する:
// run_terminal_command の command を `rtk rewrite` に通し、書き換えがあれば updatedInput だけを返す。許可判定は変えない。
export function relayGrok(raw) {
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { process.exit(0) }
  const input = event?.toolInput
  if (event?.toolName !== 'run_terminal_command' || typeof input?.command !== 'string') process.exit(0)
  const rtk = process.env.RTK_BIN || 'rtk'
  const res = spawnSync(rtk, ['rewrite', input.command], { encoding: 'utf8', cwd: event.cwd || process.cwd(), timeout: 4000 })
  if (res.error) {
    if (res.error.code === 'ENOENT') { process.stderr.write(`testgate: rtk not found; passing command through\n`); process.exit(0) }
    process.stderr.write(`testgate: rtk rewrite failed: ${res.error.code ?? res.error.message}\n`)
    process.exit(1)
  }
  if (res.stderr) process.stderr.write(res.stderr)
  if ([0, 3].includes(res.status) && res.stdout.trim()) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: res.stdout.trim() } } }))
  } else if (![1, 2].includes(res.status)) {
    process.stderr.write(`testgate: rtk rewrite failed: exit ${res.status}\n`)
    process.exit(1)
  }
  process.exit(0)
}

export function relayToRtk(harness, raw, extra) {
  const rtk = process.env.RTK_BIN || 'rtk'
  const res = spawnSync(rtk, ['hook', harness, ...extra], { input: raw, encoding: 'utf8', timeout: Number(process.env.TESTGATE_RTK_TIMEOUT_MS || 10000) })
  if (res.error) {
    // RTK が無い（ENOENT）: 何も書き換えずに通す。hook の失敗で席を止めない。
    if (res.error.code === 'ENOENT') { process.stderr.write(`testgate: rtk not found; passing command through\n`); process.exit(0) }
    // それ以外（timeout など）: 書き換えずに通すが、異常として知らせる（exit 1。2 は使わない。2 はブロックになる）
    process.stderr.write(`testgate: rtk hook failed: ${res.error.code ?? res.error.message}; passing command through\n`)
    process.exit(1)
  }
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  process.exit(res.status ?? 0)
}
