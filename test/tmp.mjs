// 試験用の一時ディレクトリ。作った物はプロセスの終了時にまとめて消す。
// node --test は試験ファイルごとに別プロセスで流すので、ファイルの試験が全部終わった時点で消える。
// 2026-10-16: 後片付けの無い試験が /tmp に tg-* を積み、testgate 自身の刈り込み（変異の数だけ試験を繰り返す）で
// inode を使い切り BellTeam の配送が ENOSPC で落ちた。以後、試験の一時物はこの道具で作る。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const made = []
process.on('exit', () => { for (const d of made) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

/** prefix 付きの一時ディレクトリを tmpdir() の下に作って返す。 */
export function tmp(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
