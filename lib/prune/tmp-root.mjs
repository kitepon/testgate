// 刈り込み1回ぶんの一時物の根。試験プロセスが SIGKILL で止められても（変異のタイムアウト、全試験報告後の居残り）、
// 'exit' ハンドラは走らないので試験の tmp() は消せない。そこで刈り込み全体の TMPDIR を専用の根にして、
// 終わった時に根ごと一度に消す。試験プロセスの env は process.env の写しなので、os.tmpdir() が全部この根の下になる。
// 2026-10-16: v0.3.6 の後も、Timeout で殺された回の一時物が残る穴があった。
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEYS = ['TMPDIR', 'TMP', 'TEMP']

/** 前回の刈り込みプロセス自体が殺された時の取りこぼしを掃く（staleMs より古い tg-run-*）。 */
export function sweepStaleRunTmp(base, staleMs, now = Date.now()) {
  let names = []
  try { names = readdirSync(base) } catch { return 0 }
  let n = 0
  for (const name of names) {
    if (!name.startsWith('tg-run-')) continue
    const p = join(base, name)
    try { if (now - statSync(p).mtimeMs > staleMs) { rmSync(p, { recursive: true, force: true }); n++ } } catch {}
  }
  return n
}

/** fn() の間だけ TMPDIR/TMP/TEMP を今回の根にする。終わったら env を戻して根を消す。 */
export async function withRunTmp(fn, { tmpdir: base = tmpdir(), staleMs = 24 * 3600 * 1000 } = {}) {
  sweepStaleRunTmp(base, staleMs)
  const root = mkdtempSync(join(base, 'tg-run-'))
  const prev = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
  for (const k of KEYS) process.env[k] = root
  try { return await fn(root) } finally {
    for (const k of KEYS) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k] }
    try { rmSync(root, { recursive: true, force: true }) } catch {}
  }
}
