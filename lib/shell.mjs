// 段階1で元のシェル構文を流す shell と、ハーネス・OSごとの包み方の決定。
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// Windows の Git Bash。CLAUDE_CODE_GIT_BASH_PATH（Claude Code 自身の指定）を先に、無ければ標準の置き場。無ければ null。
export function gitBashPath(env = process.env, exists = existsSync) {
  const candidates = [
    env.CLAUDE_CODE_GIT_BASH_PATH,
    env.ProgramFiles && join(env.ProgramFiles, 'Git', 'bin', 'bash.exe'),
    env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Git', 'bin', 'bash.exe'),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]
  return candidates.find(path => path && exists(path)) ?? null
}

// compound: 複合を POSIX の構文として包めるか。single: 単純コマンドの包み方（'posix' | 'pwsh' | null=包まない）。bash: 元の構文を流す shell。
// 非 Windows は /bin/sh。Windows で POSIX の構文を包むのは、Claude の Bash（Git Bash）だけ。
// Codex の「Bash」道具は Windows では PowerShell 構文なので pwsh（複合は包まない）。他の Windows ハーネスは実物で確かめるまで包まない。
export function shellPlan({ harness, tool, platform = process.platform, env = process.env, exists = existsSync }) {
  if (platform !== 'win32') return { compound: tool !== 'PowerShell', single: tool === 'PowerShell' ? 'pwsh' : 'posix', bash: '/bin/sh' }
  const bash = gitBashPath(env, exists)
  const claudeBash = harness === 'claude' && tool === 'Bash' && bash !== null
  const pwsh = tool === 'PowerShell' || harness === 'codex'
  return { compound: claudeBash, single: pwsh ? 'pwsh' : claudeBash ? 'posix' : null, bash }
}

export function fallbackArgv(originalShell, { platform = process.platform, env = process.env, exists = existsSync } = {}) {
  const bash = platform === 'win32' ? gitBashPath(env, exists) ?? 'bash' : '/bin/sh'
  return [bash, '-c', 'exec ' + originalShell]
}
