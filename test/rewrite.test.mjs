import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRunCommand, hookOutput, quotePosix, quotePwsh } from '../lib/rewrite.mjs'

const base = { node: '/usr/bin/node', entry: '/opt/testgate/current/bin/testgate.mjs', cwd: '/w/repo' }

test('posix: 素の語はそのまま、空白や記号は単引用で包む', () => {
  assert.equal(quotePosix('pytest'), 'pytest')
  assert.equal(quotePosix('-k'), '-k')
  assert.equal(quotePosix('a b'), "'a b'")
  assert.equal(quotePosix("it's"), `'it'\\''s'`)
  assert.equal(quotePosix('$HOME'), "'$HOME'")
})
test('pwsh: 単引用の中の引用は二重にする', () => {
  assert.equal(quotePwsh('C:\\x\\y'), 'C:\\x\\y')
  assert.equal(quotePwsh("it's"), "'it''s'")
  assert.equal(quotePwsh('a b'), "'a b'")
})
test('posix: 包んだコマンド', () => {
  const words = ['pytest', '-q', 'tests/']
  assert.equal(buildRunCommand({ ...base, words, argv: words }), '/usr/bin/node /opt/testgate/current/bin/testgate.mjs run --cwd /w/repo -- pytest -q tests/')
})
test('posix: 前置きの環境変数は残り、env は外れる', () => {
  const words = ['env', 'CI=1', 'TOKEN=a b', 'npm', 'test']
  assert.equal(buildRunCommand({ ...base, words, argv: ['npm', 'test'] }), "CI=1 TOKEN='a b' /usr/bin/node /opt/testgate/current/bin/testgate.mjs run --cwd /w/repo -- npm test")
})
test('posix: time・nice・timeout の包みがあれば包まない', () => {
  assert.equal(buildRunCommand({ ...base, words: ['time', 'pytest'], argv: ['pytest'] }), null)
  assert.equal(buildRunCommand({ ...base, words: ['timeout', '30', 'pytest'], argv: ['pytest'] }), null)
})
test('posix: -k の式や glob は引用されて意味が残る', () => {
  const words = ['pytest', '-k', 'a and not b', 'tests/*.py']
  assert.equal(buildRunCommand({ ...base, words, argv: words }), "/usr/bin/node /opt/testgate/current/bin/testgate.mjs run --cwd /w/repo -- pytest -k 'a and not b' 'tests/*.py'")
})
test('pwsh: & で node を呼び、Windows の道は単引用で包む', () => {
  const words = ['dotnet', 'test', 'Host.Tests', '--filter', 'FullyQualifiedName~X']
  const r = buildRunCommand({ words, argv: words, cwd: 'C:\\Users\\k\\repo', shell: 'pwsh', node: 'C:\\Program Files\\nodejs\\node.exe', entry: 'C:\\Users\\k\\.local\\lib\\testgate\\current\\bin\\testgate.mjs' })
  assert.equal(r, "& 'C:\\Program Files\\nodejs\\node.exe' C:\\Users\\k\\.local\\lib\\testgate\\current\\bin\\testgate.mjs run --cwd C:\\Users\\k\\repo -- dotnet test Host.Tests --filter FullyQualifiedName~X")
})
test('pwsh: 前置きがあれば包まない', () => {
  assert.equal(buildRunCommand({ ...base, words: ['CI=1', 'dotnet', 'test'], argv: ['dotnet', 'test'], shell: 'pwsh' }), null)
})
test('改行を含む語は包まない', () => {
  assert.equal(buildRunCommand({ ...base, words: ['pytest', 'a\nb'], argv: ['pytest', 'a\nb'] }), null)
})
test('cwd が無ければ --cwd を付けない', () => {
  assert.equal(buildRunCommand({ ...base, cwd: undefined, words: ['pytest'], argv: ['pytest'] }), '/usr/bin/node /opt/testgate/current/bin/testgate.mjs run -- pytest')
})
test('各ハーネスの hook 出力の形', () => {
  const c = JSON.parse(hookOutput('claude', { tool_input: { command: 'pytest', description: 'd' } }, 'X'))
  assert.deepEqual(c.hookSpecificOutput.updatedInput, { command: 'X', description: 'd' })
  assert.equal(c.hookSpecificOutput.hookEventName, 'PreToolUse')
  assert.equal(c.hookSpecificOutput.permissionDecision, undefined)
  const x = JSON.parse(hookOutput('codex', { tool_input: { command: 'pytest' } }, 'X'))
  assert.equal(x.hookSpecificOutput.permissionDecision, 'allow')
  assert.equal(x.hookSpecificOutput.updatedInput.command, 'X')
  const u = JSON.parse(hookOutput('cursor', { command: 'pytest' }, 'X'))
  assert.deepEqual(u, { continue: true, permission: 'allow', updated_input: { command: 'X' } })
  const g = JSON.parse(hookOutput('grok', { toolInput: { command: 'pytest', foo: 1 } }, 'X'))
  assert.deepEqual(g.hookSpecificOutput.updatedInput, { command: 'X', foo: 1 })
  assert.equal(hookOutput('nope', {}, 'X'), null)
})

import { fallbackArgv, gitBashPath, shellPlan } from '../lib/shell.mjs'
test('shellPlan: 非 Windows は従来どおり（PowerShell 以外は POSIX 複合も包む）', () => {
  assert.deepEqual(shellPlan({ harness: 'claude', tool: 'Bash', platform: 'linux' }), { compound: true, single: 'posix', bash: '/bin/sh' })
  assert.deepEqual(shellPlan({ harness: 'claude', tool: 'PowerShell', platform: 'darwin' }), { compound: false, single: 'pwsh', bash: '/bin/sh' })
})
test('shellPlan: Windows は Git Bash が見つかる Claude の Bash だけ POSIX 複合を包み、Codex は pwsh の単純コマンドだけ', () => {
  const found = { platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' }, exists: () => true }
  const none = { platform: 'win32', env: {}, exists: () => false }
  assert.deepEqual(shellPlan({ harness: 'claude', tool: 'Bash', ...found }), { compound: true, single: 'posix', bash: 'C:\\Git\\bin\\bash.exe' })
  assert.equal(shellPlan({ harness: 'claude', tool: 'Bash', ...none }).single, null)
  assert.equal(shellPlan({ harness: 'claude', tool: 'Bash', ...none }).compound, false)
  assert.deepEqual(shellPlan({ harness: 'claude', tool: 'PowerShell', ...found }), { compound: false, single: 'pwsh', bash: 'C:\\Git\\bin\\bash.exe' })
  assert.deepEqual(shellPlan({ harness: 'codex', tool: 'Bash', ...found }), { compound: false, single: 'pwsh', bash: 'C:\\Git\\bin\\bash.exe' })
  for (const harness of ['cursor', 'grok']) assert.deepEqual(shellPlan({ harness, tool: 'Bash', ...found }), { compound: false, single: null, bash: 'C:\\Git\\bin\\bash.exe' })
})
test('gitBashPath: 環境変数を先に、無ければ標準の置き場、どれも無ければ null', () => {
  assert.equal(gitBashPath({ CLAUDE_CODE_GIT_BASH_PATH: 'X:\\b.exe', ProgramFiles: 'C:\\PF' }, p => p === 'X:\\b.exe'), 'X:\\b.exe')
  assert.match(gitBashPath({ ProgramFiles: 'C:\\PF' }, p => /Git.bin.bash\.exe$/.test(p)), /Git.bin.bash\.exe$/)
  assert.equal(gitBashPath({}, () => false), null)
})
test('fallbackArgv: 非 Windows は /bin/sh、Windows は見つけた Git Bash で exec', () => {
  assert.deepEqual(fallbackArgv('cd x && npm test', { platform: 'linux' }), ['/bin/sh', '-c', 'exec cd x && npm test'])
  assert.deepEqual(fallbackArgv('npm test', { platform: 'win32', env: { CLAUDE_CODE_GIT_BASH_PATH: 'C:\\Git\\bin\\bash.exe' }, exists: () => true }), ['C:\\Git\\bin\\bash.exe', '-c', 'exec npm test'])
})
