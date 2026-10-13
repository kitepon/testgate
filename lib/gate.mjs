// 段階1の判断: テストコマンド argv を受け、アダプタで選んだ argv と記録用の情報を返す。実行はしない。
import { changedFiles, lastFullPass } from './git.mjs'
import { findAdapter, runSelect } from './adapters.mjs'

export async function decide({ argv, cwd, env, adapters, compound, selectTimeoutMs }) {
  const adapter = findAdapter(adapters, argv, { cwd, env })
  if (!adapter) return null
  const full = env.TESTGATE_FULL === '1'
  if (compound) return { adapter: adapter.id, mode: 'passthrough', argv, reason: '複合コマンドなので書き換えない', full }
  const g = changedFiles(cwd, null)
  if (!g) return { adapter: adapter.id, mode: 'passthrough', argv, reason: 'git リポジトリではない', full }
  if (g.error) return { adapter: adapter.id, root: g.root, mode: 'passthrough', argv, reason: `git の問い合わせに失敗したので書き換えない（${g.error}）`, full }
  const base = lastFullPass(g.root, env)
  const g2 = base ? changedFiles(cwd, base) : g
  if (!g2 || g2.error) return { adapter: adapter.id, root: g.root, mode: 'passthrough', argv, reason: `git の問い合わせに失敗したので書き換えない（${g2?.error ?? 'unknown'}）`, full }
  // 全部通った記録が無く、変更も無い（commit 直後など）時は、何が確かめ済みか分からないので一度全部流して基準を作る。
  // この全部流しは関所の都合なので時間上限を掛けない（establish）。アダプタが選ぶ full や TESTGATE_FULL=1 には上限が付く。
  if (!full && !g2.base && g2.changed.length === 0) return { adapter: adapter.id, root: g2.root, base: null, changedCount: 0, full, argv, mode: 'full', establish: true, reason: '全部通った記録が無く、変更も無いので一度全部流して基準を作る' }
  const r = await runSelect(adapter, { argv, cwd, env, changed: g2.changed, base: g2.base, full }, selectTimeoutMs ? { timeoutMs: selectTimeoutMs } : {})
  return { adapter: adapter.id, root: g2.root, base: g2.base, changedCount: g2.changed.length, full, ...r }
}
