// 段階1の書き換え: テストコマンドを `node <entry> run --cwd <dir> -- <元のコマンド>` に包み、ハーネスごとの hook 出力にする。
// 包んだ後は関所（run）がアダプタで絞って実行し、出力を整えて返す。RTK の書き換えは通らない（関所の出力はもう短い）。
import { resolve } from 'node:path'

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/

export function quotePosix(w) { return /^[A-Za-z0-9_.\/:=@%+,~-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'` }
export function quotePwsh(w) { return /^[A-Za-z0-9_.\/:=@%+,~\\-]+$/.test(w) ? w : `'${w.replace(/'/g, "''")}'` }

// 元のコマンドの語（words）と本体（argv）から、包んだコマンド行を作る。包めない形なら null。
// posix: 前置きの環境変数（FOO=1）と env は残す。time/nice/timeout の包みがあれば触らない（意味が変わる）。
// pwsh: 前置きは認めない（$env: の形は ; を伴い複合になる）。& で node を呼ぶ。
export function buildRunCommand({ words, argv, cwd, shell = 'posix', node = process.execPath, entry = resolve(process.argv[1]), originalShell, invocationId }) {
  if (!Array.isArray(words) || !Array.isArray(argv) || !argv.length || argv.length > words.length) return null
  const prefix = words.slice(0, words.length - argv.length)
  if (prefix.some(w => w !== 'env' && !ENV_ASSIGN.test(w))) return null
  if (shell === 'pwsh' && prefix.length) return null
  if (argv.some(w => /[\r\n\0]/.test(w))) return null
  const q = shell === 'pwsh' ? quotePwsh : quotePosix
  const head = shell === 'pwsh' ? ['&', q(node)] : [...prefix.filter(w => w !== 'env').map(w => { const [k, ...v] = w.split('='); return `${k}=${q(v.join('='))}` }), q(node)]
  const dir = cwd ? ['--cwd', q(cwd)] : []
  const fallback = originalShell === undefined ? [] : ['--original-shell', q(originalShell)]
  const identity = invocationId ? ['--invocation-id', q(invocationId)] : []
  return [...head, q(entry), 'run', ...dir, ...fallback, ...identity, '--', ...argv.map(q)].join(' ')
}

// ハーネスごとの「入力を差し替える」hook 出力。RTK が同じハーネスへ返す形に合わせる（codex は公式仕様の形）。
export function hookOutput(harness, event, command) {
  switch (harness) {
    case 'claude': return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecisionReason: 'testgate: 変更に関わるテストだけ流す', updatedInput: { ...(event?.tool_input ?? {}), command } } })
    case 'codex': return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'testgate: 変更に関わるテストだけ流す', updatedInput: { ...(event?.tool_input ?? {}), command } } })
    case 'cursor': return JSON.stringify({ continue: true, permission: 'allow', updated_input: { command } })
    case 'grok': return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...(event?.toolInput ?? {}), command } } })
    default: return null
  }
}
