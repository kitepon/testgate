#!/usr/bin/env node
// testgate hook <harness>: 段階0。stdin の hook 入力を読み、テスト実行なら記録し、
// そのまま同じ stdin で `rtk hook <harness>` を呼んで出力と終了コードを中継する。振る舞いは RTK 単体と同じ。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extractCommand, HARNESSES } from '../lib/harness.mjs'
import { splitWords, stripPrefix } from '../lib/shell-words.mjs'
import { detectRunner } from '../lib/detect.mjs'
import { appendLog, readRecent } from '../lib/log.mjs'
import { loadAdapters } from '../lib/adapters.mjs'
import { decide } from '../lib/gate.mjs'
import { execCapture, trimForModel } from '../lib/run.mjs'
import { recordFullPass, repoRoot } from '../lib/git.mjs'

const [, , sub, harness, ...rest] = process.argv
const tail = process.argv.slice(3)

if (sub === 'hook' && HARNESSES.includes(harness)) {
  const raw = readFileSync(0, 'utf8')
  await observe(harness, raw)
  if (harness === 'grok') relayGrok(raw)
  else relayToRtk(harness, raw, rest)
} else if (sub === 'post' && HARNESSES.includes(harness)) {
  // 実行後の hook: 同じ tool_use_id の事前記録と突き合わせて所要時間と結果を足す（段階0の補助。出力は変えない）
  const raw = readFileSync(0, 'utf8')
  await observeAfter(harness, raw)
  process.exit(0)
} else if (sub === 'run') {
  // 段階1: testgate run [--cwd DIR] -- <cmd...>
  process.exit(await runGate(tail))
} else if (sub === 'decide') {
  // 開発用: testgate decide "<command>" → アダプタの判断を表示（実行しない）
  const r = analyze(tail.join(' '))
  const adapters = await loadAdapters()
  console.log(JSON.stringify(r?.runner ? await decide({ argv: r.argv, cwd: process.cwd(), env: process.env, adapters, compound: r.compound }) : null, null, 2))
} else if (sub === 'inspect') {
  // 開発用: testgate inspect "<command>" → 判定結果を表示
  const r = analyze(tail.join(' '))
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
  const { id } = extractCommand(harness, event)
  const row = { harness, tool, id: id ?? null, cwd: cwd ?? process.cwd(), runner: r.runner, lang: r.lang, compound: r.compound, command, phase: 0 }
  // 影の判断: アダプタがあれば「段階1ならどう選んだか」を記録する。コマンドは変えない。
  try {
    const adapters = await loadAdapters()
    if (adapters.length) {
      const d = await decide({ argv: r.argv, cwd: row.cwd, env: process.env, adapters, compound: r.compound })
      if (d) Object.assign(row, { shadow: { adapter: d.adapter, mode: d.mode, reason: d.reason, argv: d.argv, changedCount: d.changedCount, base: d.base } })
    }
  } catch (error) { row.shadowError = error.message }
  await appendLog(row)
}

async function observeAfter(harness, raw) {
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return }
  const { command, id } = extractCommand(harness, event)
  const r = analyze(command)
  if (!r?.runner) return
  const pre = id ? readRecent(200).reverse().find(row => row.id === id && row.phase === 0) : null
  const text = outputText(event)
  const counts = genericCounts(text)
  await appendLog({ harness, id: id ?? null, runner: r.runner, lang: r.lang, command, phase: 0, event: 'after', durationMs: pre ? Date.now() - Date.parse(pre.ts) : null, ...counts })
}

function outputText(event) {
  const resp = event?.tool_response ?? event?.toolResponse ?? event?.output ?? ''
  if (typeof resp === 'string') return resp
  if (resp && typeof resp === 'object') return [resp.stdout, resp.stderr, resp.output, resp.content].filter(x => typeof x === 'string').join('\n')
  return ''
}

// アダプタ無しの大まかな件数読み（段階0用）。pytest / jest / cargo / go / node --test の合計行を拾う
function genericCounts(text) {
  const m = {}
  let x
  if ((x = /(\d+) passed/.exec(text))) m.passed = +x[1]
  if ((x = /(\d+) failed/.exec(text))) m.failed = +x[1]
  if ((x = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(text))) { m.passed = +x[1]; m.failed = +x[2] }
  if ((x = /Tests:\s+(?:(\d+) failed, )?(\d+) passed/.exec(text))) { m.passed = +x[2]; if (x[1]) m.failed = +x[1] }
  if ((x = /ℹ pass (\d+)/.exec(text))) m.passed = +x[1]
  if ((x = /ℹ fail (\d+)/.exec(text))) m.failed = +x[1]
  return m
}

async function runGate(args) {
  let cwd = process.cwd()
  let i = 0
  while (i < args.length && args[i] !== '--') { if (args[i] === '--cwd') { cwd = args[i + 1]; i += 2 } else i++ }
  const argv = args.slice(i + 1)
  if (!argv.length) { console.error('usage: testgate run [--cwd DIR] -- <command...>'); return 2 }
  const adapters = await loadAdapters()
  const d = await decide({ argv, cwd, env: process.env, adapters, compound: false })
  const adapter = d ? adapters.find(a => a.id === d.adapter) : null
  if (!d || d.mode === 'none') {
    if (d) await appendLog({ phase: 1, event: 'none', cwd, command: argv.join(' '), adapter: d.adapter, reason: d.reason, changedCount: d.changedCount })
    console.log(d ? `testgate: 変更に関わるテストが無いので流さない（${d.reason}）` : 'testgate: テストコマンドではない')
    return 0
  }
  const limitMs = (d.mode === 'full' || d.mode === 'passthrough') ? (Number(process.env.TESTGATE_FULL_LIMIT_SEC || 180) * 1000) : 0
  const res = await execCapture(d.argv, { cwd, env: process.env, timeoutMs: limitMs })
  const parsed = safe(() => adapter?.parseOutput?.(res.output)) ?? {}
  const shown = safe(() => adapter?.stripCounts?.(res.output)) ?? res.output
  const ok = res.status === 0 && !res.timedOut
  if (ok && d.mode === 'full' && d.root) recordFullPass(d.root, process.env)
  await appendLog({ phase: 1, event: 'run', cwd, command: argv.join(' '), ran: d.argv.join(' '), adapter: d.adapter, mode: d.mode, reason: d.reason, base: d.base, changedCount: d.changedCount, status: res.status, timedOut: res.timedOut, durationMs: res.durationMs, passed: parsed.passed, failed: parsed.failed, skipped: parsed.skipped, errors: parsed.errors })
  process.stdout.write(trimForModel(shown, { ok }))
  if (!shown.endsWith('\n')) process.stdout.write('\n')
  if (res.timedOut) process.stdout.write(`testgate: 全部流しが ${limitMs / 1000} 秒を超えたので止めた。速くするか、分けるか、消すこと。\n`)
  else if (d.mode === 'subset') process.stdout.write(`testgate: 変更に関わる分だけ流した（${d.reason}）。全部流すには TESTGATE_FULL=1。\n`)
  return res.timedOut ? 124 : res.status
}

function safe(fn) { try { return fn() } catch { return undefined } }

// Grok には RTK 自身の hook が無い。BellTeam の integrations/rtk/grok-hook.mjs と同じ動き:
// run_terminal_command の command を `rtk rewrite` に通し、書き換えがあれば updatedInput だけを返す。許可判定は変えない。
function relayGrok(raw) {
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

function relayToRtk(harness, raw, extra) {
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
