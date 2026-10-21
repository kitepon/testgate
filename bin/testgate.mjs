#!/usr/bin/env node
// testgate hook <harness>: stdin の hook 入力を読む。
// 段階1（既定、TESTGATE_PHASE=0 で段階0へ戻る）: アダプタが扱えるテストコマンドなら `testgate run -- <元のコマンド>` に包み直して返す。
// それ以外（テストでない、複合、アダプタが無い、包めない形）は段階0と同じ: 記録して、同じ stdin で `rtk hook <harness>` を呼び、出力と終了コードを中継する。
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extractCommand, HARNESSES } from '../lib/harness.mjs'
import { splitWords, stripPrefix } from '../lib/shell-words.mjs'
import { detectRunner } from '../lib/detect.mjs'
import { appendLog, readRecent } from '../lib/log.mjs'
import { genericCounts } from '../lib/counts.mjs'
import { loadAdapters, findAdapter } from '../lib/adapters.mjs'
import { decide } from '../lib/gate.mjs'
import { execCapture, trimForModel } from '../lib/run.mjs'
import { recordFullPass, repoRoot } from '../lib/git.mjs'
import { buildRunCommand, hookOutput } from '../lib/rewrite.mjs'

const [, , sub, harness, ...rest] = process.argv
const tail = process.argv.slice(3)

if (sub === 'hook' && HARNESSES.includes(harness)) {
  const raw = readFileSync(0, 'utf8')
  if (isCompatCaller(harness, raw)) process.exit(0)
  const rewritten = await gatePhase1(harness, raw)
  if (rewritten) { process.stdout.write(rewritten); process.exit(0) }
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
} else if (sub === 'prune') {
  // 段階2: testgate prune [--cwd DIR] [--sample N] … → 消してよい試験の候補を出す（消すのは担当）
  // testgate prune --merge-only NAME [--cwd DIR] → Stryker を流さず、state/prune/NAME の記録を合算し直す
  const { runPrune, runMergeOnly, parsePruneArgs, PRUNE_USAGE } = await import('../lib/prune/index.mjs')
  const o = parsePruneArgs(tail)
  if (o.error) { console.error(`${o.error}\n${PRUNE_USAGE}`); process.exit(2) }
  process.exit(o.mergeOnly ? runMergeOnly({ name: o.mergeOnly, cwd: o.cwd }) : await runPrune(o))
} else if (sub === 'decide') {
  // 開発用: testgate decide "<command>" → アダプタの判断を表示（実行しない）
  const r = analyze(tail.join(' '))
  const adapters = await loadAdapters()
  console.log(JSON.stringify(r?.runner ? await decide({ argv: r.argv, cwd: process.cwd(), env: process.env, adapters, compound: r.compound }) : null, null, 2))
} else if (sub === 'inspect') {
  // 開発用: testgate inspect "<command>" → 判定結果を表示
  const r = analyze(tail.join(' '))
  console.log(JSON.stringify(r, null, 2))
} else if (sub === 'hook' || sub === 'post') {
  // hook として呼ばれた時は、何があっても 2 を返さない（Claude・Codex では 2 がそのコマンドを止める）
  process.stderr.write(`testgate: unknown harness "${harness}"; passing command through\n`)
  process.exit(1)
} else {
  console.error('usage: testgate hook <claude|codex|cursor|grok> | testgate run [--cwd DIR] -- <command...> | testgate prune [--cwd DIR] [--sample N] | testgate prune --merge-only NAME [--cwd DIR] | testgate inspect <command>')
  process.exit(2)
}

// Grok と Cursor は ~/.claude/settings.json の hook も既定で読むので、同じ一回の実行が `hook claude` にも届く
// （実物 2026-10-13、トロニーの確認。Grok は tool_name=run_terminal_command、Cursor は tool_name=Shell で来る）。
// Claude Code 自身の shell 道具は Bash と、Windows の PowerShell（v0.1.4、fox の実物でドリリーが確認。RTK も PowerShell を書き換える）。
// それ以外の道具名で `hook claude` が呼ばれたら他ハーネスの相乗りと見なし、記録も RTK も呼ばずに通す。
// 書き換えはそのハーネス自身の hook（hook grok / hook cursor）が一度だけ行う。
export function isCompatCaller(harness, raw) {
  if (harness !== 'claude') return false
  const CLAUDE_SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return false }
  const tool = event?.tool_name
  return typeof tool === 'string' && !CLAUDE_SHELL_TOOLS.has(tool)
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

// 段階1: アダプタが扱えるテストコマンドを関所の run に包み直す。包めない時は null（段階0の道へ）。
// Windows は Claude の PowerShell（fox でドリリー・エクシアが確かめた道）だけ包む。他ハーネスの Windows は実物で確かめるまで通す。
async function gatePhase1(harness, raw) {
  if (process.env.TESTGATE_PHASE === '0') return null
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return null }
  const { command, cwd, tool, id, session, transcript } = extractCommand(harness, event)
  const r = analyze(command)
  if (!r?.runner || r.compound) return null
  const words = splitWords(command).words
  let shell = 'posix'
  if (tool === 'PowerShell') shell = 'pwsh'
  else if (process.platform === 'win32') return null
  try {
    const adapters = await loadAdapters()
    const adapter = findAdapter(adapters, r.argv, { cwd: cwd ?? process.cwd(), env: process.env })
    if (!adapter) return null
    const ran = buildRunCommand({ words, argv: r.argv, cwd, shell })
    if (!ran) return null
    const out = hookOutput(harness, event, ran)
    if (!out) return null
    await appendLog({ harness, tool, id, session, transcript, cwd: cwd ?? process.cwd(), runner: r.runner, lang: r.lang, compound: false, command, phase: 1, event: 'rewrite', adapter: adapter.id, ran })
    return out
  } catch (error) {
    process.stderr.write(`testgate: phase1 rewrite failed: ${error.message}; passing command through\n`)
    return null
  }
}

async function observe(harness, raw) {
  let event
  try { event = JSON.parse(raw.replace(/^\uFEFF/, '')) } catch { return }
  const { command, cwd, tool } = extractCommand(harness, event)
  const r = analyze(command)
  if (!r?.runner) return
  const { id, session, transcript } = extractCommand(harness, event)
  const row = { harness, tool, id, session, transcript, cwd: cwd ?? process.cwd(), runner: r.runner, lang: r.lang, compound: r.compound, command, phase: 0 }
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

async function runGate(args) {
  let cwd = process.cwd()
  let i = 0
  while (i < args.length && args[i] !== '--') { if (args[i] === '--cwd') { cwd = args[i + 1]; i += 2 } else i++ }
  const argv = args.slice(i + 1)
  if (!argv.length) { console.error('usage: testgate run [--cwd DIR] -- <command...>'); return 2 }
  const adapters = await loadAdapters()
  const d = await decide({ argv, cwd, env: process.env, adapters, compound: false, selectTimeoutMs: Number(process.env.TESTGATE_SELECT_TIMEOUT_MS || 30000) })
  const adapter = d ? adapters.find(a => a.id === d.adapter) : null
  if (!d || d.mode === 'none') {
    if (d) await appendLog({ phase: 1, event: 'none', cwd, command: argv.join(' '), adapter: d.adapter, reason: d.reason, changedCount: d.changedCount })
    console.log(d ? `testgate: 変更に関わるテストが無いので流さない（${d.reason}）` : 'testgate: テストコマンドではない')
    return 0
  }
  // 時間上限は、意図した全部流し（TESTGATE_FULL=1、アダプタが選んだ full）だけ。基準作りの full と、アダプタが判断できなかった passthrough には掛けない
  const limitMs = (d.mode === 'full' && !d.establish) ? (Number(process.env.TESTGATE_FULL_LIMIT_SEC || 180) * 1000) : 0
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
  else if (d.establish) process.stdout.write(`testgate: ${d.reason}。${ok ? '通ったので、次からはこの commit との差分だけ流す。' : '失敗があるので基準は作らない。通るまでは、変更に関わるテストが無い時も全部流す。'}\n`)
  else if (d.mode === 'passthrough') process.stdout.write(`testgate: 絞れなかったのでそのまま流した（${d.reason}）。\n`)
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
