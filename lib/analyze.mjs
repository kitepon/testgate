// 段階0の判定: コマンドにテストランナーがあるか。複合でも、どこかに本物のテストがあれば記録する。
import { splitWords, stripPrefix } from './shell-words.mjs'
import { detectRunner } from './detect.mjs'
import { splitTopLevel } from './compound.mjs'

export function analyze(command) {
  if (typeof command !== 'string' || !command.trim()) return null
  const { words, compound, error } = splitWords(command)
  if (error) return { compound: true, runner: null }
  // 複合でも、どこかにテストランナーがあれば記録はする（select は呼ばない）。
  // 複合は引用符・$(...)・here-doc の外だけで分ける（`ps | rg 'cargo test'` や here-doc の本文を段階0の行にしない）。
  const parts = compound ? splitTopLevel(command).map(seg => { const sw = splitWords(seg); return sw.error ? [] : stripPrefix(sw.words).argv }) : [stripPrefix(words).argv]
  for (const argv of parts) {
    const hit = detectRunner(argv)
    if (hit) return { compound, ...hit, argv, command }
  }
  return { compound, runner: null, argv: stripPrefix(words).argv }
}
