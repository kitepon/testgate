// Frozen compatibility reference; not an installed hook.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Grok's documented native PreToolUse format; preserve every input field.
const event = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
const input = event.toolInput;
if (event.toolName === 'run_terminal_command' && typeof input?.command === 'string') {
  const result = spawnSync(process.env.RTK_BIN || 'rtk', ['rewrite', input.command], {
    encoding: 'utf8', cwd: event.cwd || process.cwd(), timeout: 4000,
  });
  if (result.error) throw result.error;
  if (result.stderr) process.stderr.write(result.stderr);
  // RTK rewrite uses Claude permission rules. Grok retains its own permission
  // checks: never emit an allow decision or relax a deny from another hook.
  if ([0, 3].includes(result.status) && result.stdout.trim()) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', updatedInput: { ...input, command: result.stdout.trim() },
    } }));
  } else if (![1, 2].includes(result.status)) {
    throw new Error(`rtk rewrite failed: exit ${result.status}, signal ${result.signal}`);
  }
}
