// 実験用: 試験プロセスの --import。Stryker が渡した変異番号をリポジトリ直下の .active-mutant に書く（無ければ消す）。
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
const f = join(process.cwd(), '.active-mutant')
const v = process.env.__STRYKER_ACTIVE_MUTANT__
if (v) writeFileSync(f, v); else rmSync(f, { force: true })
