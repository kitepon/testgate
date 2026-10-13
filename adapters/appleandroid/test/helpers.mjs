import { cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIX = path.join(ROOT, 'fixtures')

export const read = rel => readFileSync(path.join(FIX, rel), 'utf8')

// fixtures の小さなリポジトリを一時ディレクトリへ写し、git リポジトリにする。
// subdir を指定すると git ルートの下にその名前で置く（cwd がルートでない場合の試験用）。
export function tempRepo(name, { subdir = '' } = {}) {
  const top = mkdtempSync(path.join(tmpdir(), 'tgate-'))
  const dest = subdir ? path.join(top, subdir) : top
  cpSync(path.join(FIX, name), dest, { recursive: true })
  rmSync(path.join(dest, 'build'), { recursive: true, force: true })
  execFileSync('git', ['init', '-q'], { cwd: top })
  return { top, dir: dest, cleanup: () => rmSync(top, { recursive: true, force: true }) }
}

export function put(dir, rel, text) {
  const p = path.join(dir, rel)
  mkdirSync(path.dirname(p), { recursive: true })
  writeFileSync(p, text)
}
