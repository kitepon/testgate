// 各ハーネスの hook 入力から、コマンド文字列と cwd を取り出す。
export function extractCommand(harness, event) {
  switch (harness) {
    // id: 道具呼び出しの id。session: 会話の id。transcript: 会話記録の path（Claude）。後で会話記録と突き合わせるために残す
    case 'claude': return { command: event?.tool_input?.command, cwd: event?.cwd, tool: event?.tool_name, id: event?.tool_use_id ?? null, session: event?.session_id ?? null, transcript: event?.transcript_path ?? null }
    case 'codex': return { command: event?.tool_input?.command, cwd: event?.cwd, tool: event?.tool_name, id: event?.call_id ?? event?.tool_use_id ?? null, session: event?.session_id ?? event?.thread_id ?? null, transcript: event?.transcript_path ?? null }
    case 'cursor': return { command: event?.command ?? event?.tool_input?.command, cwd: event?.cwd ?? event?.workspace_roots?.[0], tool: 'Shell', id: event?.generation_id ?? null, session: event?.conversation_id ?? null, transcript: null }
    case 'grok': return { command: event?.toolInput?.command, cwd: event?.cwd, tool: event?.toolName, id: event?.toolCallId ?? event?.toolUseId ?? null, session: event?.sessionId ?? null, transcript: null }
    default: return { command: undefined }
  }
}
export const HARNESSES = ['claude', 'codex', 'cursor', 'grok']
