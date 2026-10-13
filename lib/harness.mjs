// 各ハーネスの hook 入力から、コマンド文字列と cwd を取り出す。
export function extractCommand(harness, event) {
  switch (harness) {
    case 'claude': return { command: event?.tool_input?.command, cwd: event?.cwd, tool: event?.tool_name, id: event?.tool_use_id ?? event?.session_id }
    case 'codex': return { command: event?.tool_input?.command, cwd: event?.cwd, tool: event?.tool_name, id: event?.session_id }
    case 'cursor': return { command: event?.command ?? event?.tool_input?.command, cwd: event?.cwd ?? event?.workspace_roots?.[0], tool: 'Shell', id: event?.conversation_id }
    case 'grok': return { command: event?.toolInput?.command, cwd: event?.cwd, tool: event?.toolName, id: event?.sessionId }
    default: return { command: undefined }
  }
}
export const HARNESSES = ['claude', 'codex', 'cursor', 'grok']
