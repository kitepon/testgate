// 段階0の判定表。アダプタが揃ったら各アダプタの detect に置き換わる。
// 返り値: { runner, lang } か null。runner はログ用の名前。
const TABLE = [
  { lang: 'python', runner: 'pytest', match: a => a[0] === 'pytest' || a[0] === 'py.test' || (/^python[0-9.]*$/.test(a[0]) && a[1] === '-m' && a[2] === 'pytest') || (a[0] === 'uv' && a[1] === 'run' && a[2] === 'pytest') || (a[0] === 'poetry' && a[1] === 'run' && a[2] === 'pytest') },
  { lang: 'javascript', runner: 'jest', match: a => a[0] === 'jest' || (isNpx(a) && a[1] === 'jest') },
  { lang: 'javascript', runner: 'vitest', match: a => a[0] === 'vitest' || (isNpx(a) && a[1] === 'vitest') },
  { lang: 'javascript', runner: 'node --test', match: a => /^node[0-9.]*$/.test(a[0]) && a.includes('--test') },
  { lang: 'javascript', runner: 'npm test', match: a => (['npm', 'pnpm', 'yarn', 'bun'].includes(a[0]) && (a[1] === 'test' || a[1] === 't' || (a[1] === 'run' && a[2] === 'test'))) },
  { lang: 'rustgo', runner: 'cargo test', match: a => a[0] === 'cargo' && (a[1] === 'test' || a[1] === 'nextest') },
  { lang: 'rustgo', runner: 'go test', match: a => a[0] === 'go' && a[1] === 'test' },
  { lang: 'appleandroid', runner: 'swift test', match: a => a[0] === 'swift' && a[1] === 'test' },
  { lang: 'appleandroid', runner: 'xcodebuild test', match: a => a[0] === 'xcodebuild' && (a.includes('test') || a.includes('test-without-building')) },
  { lang: 'appleandroid', runner: 'gradle test', match: a => /(^|\/)gradlew?(\.bat)?$/.test(a[0]) && a.some(x => /(^|:)test$/.test(x) || /(^|:)connectedAndroidTest$/.test(x)) },
  { lang: 'dotnet', runner: 'dotnet test', match: a => a[0] === 'dotnet' && a[1] === 'test' },
  { lang: 'cmake', runner: 'ctest', match: a => a[0] === 'ctest' },
  { lang: 'rtk', runner: 'rtk test', match: a => a[0] === 'rtk' && a[1] === 'test' },
]
const NON_RUN = new Set(['--version', '-h', '--help', '--collect-only', '--listTests', '--list', '-showTestPlans'])
function isNpx(a) { return a[0] === 'npx' || a[0] === 'pnpx' || (a[0] === 'pnpm' && a[1] === 'exec') || (a[0] === 'yarn' && a[1] === 'dlx') }

export function detectRunner(argv) {
  if (!argv.length) return null
  let a = argv
  if (a[0] === 'rtk' && a[1] !== 'test') a = a.slice(1) // RTKの書換後の形も拾う
  for (const row of TABLE) {
    if (row.match(a)) {
      if (a.some(x => NON_RUN.has(x))) return null
      return { runner: row.runner, lang: row.lang }
    }
  }
  return null
}
