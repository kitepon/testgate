import { isAbsolute, resolve } from 'node:path'
// 各ハーネスの hook 入力から、コマンド文字列と cwd を取り出す。
export function extractCommand(harness, event) {
  switch (harness) {
    // id: 道具呼び出しの id。session: 会話の id。transcript: 会話記録の path（Claude）。後で会話記録と突き合わせるために残す
    case 'claude': return { command: event?.tool_input?.command, cwd: nonEmpty(event?.cwd), tool: event?.tool_name, id: event?.tool_use_id ?? null, session: event?.session_id ?? null, transcript: event?.transcript_path ?? null }
    // Codex の exec_command は tool_input.workdir で実行場所を指定できる（相対なら event.cwd 基準）。包んだ run の --cwd がこれと違うと試験ファイルが見つからない（リトルマーメイド 2026-10-18）。
    case 'codex': return { command: event?.tool_input?.command, cwd: withWorkdir(event?.cwd, event?.tool_input?.workdir ?? event?.tool_input?.cwd), tool: event?.tool_name, id: event?.call_id ?? event?.tool_use_id ?? null, session: event?.session_id ?? event?.thread_id ?? null, transcript: event?.transcript_path ?? null }
    // Cursor は cwd が空文字で来る事がある（実物 2026.10.01、トロニーの確認）。空は無い物として workspace_roots へ落とす。
    // generation_id は conversation_id と同じ値で、道具呼び出しごとの id ではないので id には使わない。
    case 'cursor': return { command: event?.command ?? event?.tool_input?.command, cwd: nonEmpty(event?.cwd) ?? nonEmpty(event?.workspace_roots?.[0]) ?? undefined, tool: 'Shell', id: null, session: event?.conversation_id ?? null, transcript: null }
    case 'grok': return { command: event?.toolInput?.command, cwd: nonEmpty(event?.cwd), tool: event?.toolName, id: event?.toolCallId ?? event?.toolUseId ?? null, session: event?.sessionId ?? null, transcript: null }
    default: return { command: undefined }
  }
}
function nonEmpty(v) { return typeof v === 'string' && v.trim() ? v : undefined }
function withWorkdir(cwd, workdir) {
  const base = nonEmpty(cwd); const w = nonEmpty(workdir)
  if (!w) return base
  return isAbsolute(w) ? w : resolve(base ?? process.cwd(), w)
}
export const HARNESSES = ['claude', 'codex', 'cursor', 'grok']
