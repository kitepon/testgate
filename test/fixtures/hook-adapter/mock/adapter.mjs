// hook の段階1試験用: `npm test` を扱うふりをして、実行は mocktest.mjs に振り替える
export const id = 'mocknpm'
export const runners = ['npm test']
export function detect(argv) { return argv[0] === 'npm' && argv[1] === 'test' }
export async function select({ argv, changed, full }) {
  if (full) return { argv: ['node', 'mocktest.mjs'], mode: 'full', reason: 'mock: full' }
  if (!changed.length) return { argv, mode: 'none', reason: 'mock: no change' }
  if (changed.includes('a.txt')) return { argv: ['node', 'mocktest.mjs', '--only', 'a'], mode: 'subset', reason: 'mock: a だけ' }
  return { argv: ['node', 'mocktest.mjs'], mode: 'full', reason: 'mock: 全体' }
}
export function parseOutput(text) { const m = /(\d+) ok, (\d+) ng/.exec(text); return m ? { passed: +m[1], failed: +m[2] } : {} }
export function stripCounts(text) { return text.split('\n').filter(l => !/\d+ ok, \d+ ng/.test(l)).join('\n') }
