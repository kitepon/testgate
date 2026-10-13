#!/usr/bin/env node
// testgate hook <harness>: 段階0。stdin の hook 入力を読み、テスト実行なら記録し、
// そのまま同じ stdin で `rtk hook <harness>` を呼んで出力と終了コードを中継する。振る舞いは RTK 単体と同じ。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extractCommand, HARNESSES } from '../lib/harness.mjs'
import { splitWords, stripPrefix } from '../lib/shell-words.mjs'
import { detectRunner } from '../lib/detect.mjs'
import { appendLog } from '../lib/log.mjs'

const [, , sub, harness, ...rest] = process.argv

if (sub === 'hook' && HARNESSES.includes(harness)) {
  const raw = readFileSync(0, 'utf8')
  await observe(harness, raw)
  if (harness === 'grok') relayGrok(raw)
  else relayToRtk(harness, raw, rest)
} else if (sub === 'inspect') {
  // 開発用: testgate inspect "<command>" → 判定結果を表示
  const r = analyze(rest.join(' '))
  console.log(JSON.stringify(r, null, 2))
} else {
  console.error('usage: testgate hook <claude|codex|cursor|grok> | testgate inspect <command>')
  process.exit(2)
}

export function analyze(command) {
  if (typeof command !== 'string' || !command.trim()) return null
  const { words, compound, error } = splitWords(command)
  if (error) return { compound: true, runner: null }
  // 複合でも、どこかにテストランナーがあれば記録はする（select は呼ばない）
  const segments = compound ? splitSegments(command) : [command]
  for (const seg of segments) {
    const sw = splitWords(seg)
    if (sw.error) continue
    const { argv } = stripPrefix(sw.words)
    const hit = detectRunner(argv)
    if (hit) return { compound, ...hit, argv, command }
  }
  return { compound, runner: null, argv: stripPrefix(words).argv }
}

function splitSegments(command) {
  return command.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean)
}

async function observe(harness, raw) {
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return }
  const { command, cwd, tool } = extractCommand(harness, event)
  const r = analyze(command)
  if (!r?.runner) return
  await appendLog({ harness, tool, cwd: cwd ?? process.cwd(), runner: r.runner, lang: r.lang, compound: r.compound, command, phase: 0 })
}

// Grok には RTK 自身の hook が無い。BellTeam の integrations/rtk/grok-hook.mjs と同じ動き:
// run_terminal_command の command を `rtk rewrite` に通し、書き換えがあれば updatedInput だけを返す。許可判定は変えない。
function relayGrok(raw) {
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { process.exit(0) }
  const input = event?.toolInput
  if (event?.toolName !== 'run_terminal_command' || typeof input?.command !== 'string') process.exit(0)
  const rtk = process.env.RTK_BIN || 'rtk'
  const res = spawnSync(rtk, ['rewrite', input.command], { encoding: 'utf8', cwd: event.cwd || process.cwd(), timeout: 4000 })
  if (res.error) { process.stderr.write(`testgate: rtk unavailable: ${res.error.message}\n`); process.exit(0) }
  if (res.stderr) process.stderr.write(res.stderr)
  if ([0, 3].includes(res.status) && res.stdout.trim()) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, command: res.stdout.trim() } } }))
  } else if (![1, 2].includes(res.status)) {
    process.stderr.write(`testgate: rtk rewrite failed: exit ${res.status}\n`)
    process.exit(1)
  }
  process.exit(0)
}

function relayToRtk(harness, raw, extra) {
  const rtk = process.env.RTK_BIN || 'rtk'
  const res = spawnSync(rtk, ['hook', harness, ...extra], { input: raw, encoding: 'utf8', timeout: 10000 })
  if (res.error) {
    // RTK が無い・落ちた: 何も書き換えずに通す（hook 失敗で席を止めない）
    process.stderr.write(`testgate: rtk unavailable: ${res.error.message}\n`)
    process.exit(0)
  }
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  process.exit(res.status ?? 0)
}
