export const id = 'mock'
export const runners = ['mocktest']
export function detect(argv) { return argv[0] === 'node' && argv[1] === 'mocktest.mjs' }
export async function select({ argv, changed, full }) {
  if (full) return { argv, mode: 'full', reason: 'mock: full' }
  if (!changed.length) return { argv, mode: 'none', reason: 'mock: no change' }
  if (changed.includes('a.txt')) return { argv: [...argv, '--only', 'a'], mode: 'subset', reason: 'mock: a だけ' }
  return { argv, mode: 'full', reason: 'mock: 全体' }
}
export function parseOutput(text) { const m = /(\d+) ok, (\d+) ng/.exec(text); return m ? { passed: +m[1], failed: +m[2] } : {} }
export function stripCounts(text) { return text.split('\n').filter(l => !/\d+ ok, \d+ ng/.test(l)).join('\n') }
