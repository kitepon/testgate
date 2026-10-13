import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'
import { select, detect } from '../adapter.mjs'
import { tempRepo, put } from './helpers.mjs'

const CALC = 'core/src/main/java/demo/core/Calc.java'
const GREETER = 'app/src/main/java/demo/app/Greeter.java'
const STRINGS = 'util/src/main/java/demo/util/Strings.java'
const G = ['./gradlew', 'test']

const INIT = fileURLToPath(new URL('../gradle-testlogging.init.gradle', import.meta.url))

// gradle の subset・full には件数用の -I <init script> が付く。ここでは外して比べ、付くことは別の試験で見る。
function dropInit(s) {
  const i = s.argv.indexOf('-I')
  if (i < 0 || s.argv[i + 1] !== INIT) return { ...s, hadInit: false }
  return { ...s, argv: [...s.argv.slice(0, i), ...s.argv.slice(i + 2)], hadInit: true }
}

async function gsel(repo, over = {}) {
  return dropInit(await select({ argv: G, cwd: repo.dir, env: {}, changed: [], base: null, full: false, ...over }))
}

// ───────── gradle: モジュール単位の選択 ─────────

test('gradle: core を変えると core と依存元 app だけ。独立した util は含まない', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: [CALC] })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['./gradlew', ':app:test', ':core:test'])
    assert.ok(!s.argv.some(a => a.includes('util')))
    assert.match(s.reason, /^gradle test:/)
  } finally { r.cleanup() }
})

test('gradle: 独立した util だけを変えると util だけ', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: [STRINGS] })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['./gradlew', ':util:test'])
  } finally { r.cleanup() }
})

test('gradle: app だけを変えても core は流さない（依存先は対象外）', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: [GREETER] })
    assert.deepEqual(s.argv, ['./gradlew', ':app:test'])
  } finally { r.cleanup() }
})

test('gradle: テストファイルの変更もそのモジュールを選ぶ', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: ['util/src/test/java/demo/util/StringsTest.java'] })
    assert.deepEqual(s.argv, ['./gradlew', ':util:test'])
  } finally { r.cleanup() }
})

test('gradle: 削除されたファイルも対応づく', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: ['core/src/main/java/demo/core/Removed.java'] })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['./gradlew', ':app:test', ':core:test'])
  } finally { r.cleanup() }
})

test('gradle: 他のタスクとオプションは元の位置のまま残る', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { argv: ['./gradlew', 'clean', 'test', '--info', '--continue'], changed: [STRINGS] })
    assert.deepEqual(s.argv, ['./gradlew', 'clean', ':util:test', '--info', '--continue'])
  } finally { r.cleanup() }
})

test('gradle: 環境変数の前置とラッパーを保つ', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { argv: ['JAVA_HOME=/x', './gradlew', '--console=plain', 'test'], changed: [STRINGS] })
    assert.deepEqual(s.argv, ['JAVA_HOME=/x', './gradlew', '--console=plain', ':util:test'])
  } finally { r.cleanup() }
})

test('gradle: check も修飾する', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { argv: ['./gradlew', 'check'], changed: [STRINGS] })
    assert.deepEqual(s.argv, ['./gradlew', ':util:check'])
  } finally { r.cleanup() }
})

test('gradle: 変更が全モジュールに及ぶなら full（元の argv）', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: [CALC, STRINGS] })
    assert.equal(s.mode, 'full')
    assert.deepEqual(s.argv, G)
  } finally { r.cleanup() }
})

test('gradle: 変更なしは none。前回の失敗があっても変えない', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: [], base: 'abc123' })
    assert.equal(s.mode, 'none')
  } finally { r.cleanup() }
})

test('gradle: full:true は元の argv をそのまま返す', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const argv = ['./gradlew', 'clean', 'test', '--info']
    const s = await gsel(r, { argv, changed: [CALC], full: true })
    assert.equal(s.mode, 'full')
    assert.deepEqual(s.argv, argv)
  } finally { r.cleanup() }
})

test('gradle: 文書だけの変更は none', async () => {
  const r = tempRepo('gradle-multi')
  try {
    for (const c of [['docs/README.md'], ['README.md'], ['CHANGELOG.md', 'docs/x.txt'], ['.github/workflows/ci.yml']]) {
      const s = await gsel(r, { changed: c })
      assert.equal(s.mode, 'none', c.join())
    }
  } finally { r.cleanup() }
})

test('gradle: src の下の md は文書扱いしない（テスト資源かもしれない）', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: ['util/src/test/resources/case.md'] })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['./gradlew', ':util:test'])
  } finally { r.cleanup() }
})

// ───────── gradle: 全体に効くファイルは full（契約 v0.3） ─────────

for (const f of [
  'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts',
  'app/build.gradle', 'util/build.gradle.kts', 'gradle.properties', 'app/gradle.properties',
  'gradle.lockfile', 'app/gradle.lockfile', 'gradle/libs.versions.toml',
  'gradle/wrapper/gradle-wrapper.properties', 'gradle/dependency-locks/x.lockfile',
  'gradle/verification-metadata.xml', 'buildSrc/src/main/kotlin/x.kt', 'build-logic/convention/build.gradle.kts',
  'gradlew', 'scripts/publish.gradle', 'local.properties'
]) {
  test(`gradle: ${f} が変わったら full`, async () => {
    const r = tempRepo('gradle-multi')
    try {
      const s = await gsel(r, { changed: [STRINGS, f] })
      assert.equal(s.mode, 'full')
      assert.deepEqual(s.argv, G)
      assert.ok(s.reason.includes(f.split('/').pop()) || s.reason.includes(f), s.reason)
    } finally { r.cleanup() }
  })
}

test('gradle: どのモジュールにも属さないソースは full', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { changed: ['config/detekt.yml'] })
    assert.equal(s.mode, 'full')
  } finally { r.cleanup() }
})

// ───────── gradle: 人が範囲を絞っている時は passthrough ─────────

for (const argv of [
  ['./gradlew', 'test', '--tests', 'demo.core.CalcTest'],
  ['./gradlew', 'test', '--tests=demo.core.CalcTest'],
  ['./gradlew', ':core:test'],
  ['./gradlew', 'core:test'],
  ['./gradlew', ':app:testDebugUnitTest'],
  ['./gradlew', 'test', '-Dtest.single=CalcTest'],
]) {
  test(`gradle: ${argv.slice(1).join(' ')} は passthrough`, async () => {
    const r = tempRepo('gradle-multi')
    try {
      const s = await gsel(r, { argv, changed: [STRINGS] })
      assert.equal(s.mode, 'passthrough')
      assert.deepEqual(s.argv, argv)
    } finally { r.cleanup() }
  })
}

test('gradle: サブプロジェクトの中から打った test は passthrough', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await gsel(r, { argv: ['../gradlew', 'test'], cwd: path.join(r.dir, 'core'), changed: [CALC] })
    assert.equal(s.mode, 'passthrough')
    const s2 = await gsel(r, { argv: ['./gradlew', '-p', 'core', 'test'], changed: [CALC] })
    assert.equal(s2.mode, 'passthrough')
  } finally { r.cleanup() }
})

test('gradle: ルートを -p で指しても選べる', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await select({ argv: ['gradle', '-p', r.dir, 'test'], cwd: '/', env: {}, changed: [STRINGS], base: null, full: false })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['gradle', '-I', INIT, '-p', r.dir, ':util:test'])
  } finally { r.cleanup() }
})

// ───────── gradle: 構成の読み取り ─────────

test('gradle: variant 名のタスクは修飾すると未定義タスクで落ちるので full', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const argv = ['./gradlew', 'testDebugUnitTest']
    const s = await gsel(r, { argv, changed: [STRINGS] })
    assert.equal(s.mode, 'full')
    assert.deepEqual(s.argv, argv)
    assert.match(s.reason, /testDebugUnitTest/)
  } finally { r.cleanup() }
})

test('gradle: git ルートの下の入れ子（cwd がルートでない）', async () => {
  const r = tempRepo('gradle-multi', { subdir: 'mobile' })
  try {
    const s = await gsel(r, { changed: ['mobile/' + STRINGS] })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['./gradlew', ':util:test'])
    // プロジェクトの外の変更は無関係
    const s2 = await gsel(r, { changed: ['server/main.go'] })
    assert.equal(s2.mode, 'none')
  } finally { r.cleanup() }
})

test('gradle: Kotlin DSL の typesafe accessor と kebab-case の依存を読む', async () => {
  const r = tempRepo('gradle-multi')
  try {
    put(r.dir, 'settings.gradle', '')
    put(r.dir, 'settings.gradle.kts', 'include(":core", ":my-lib", ":app", ":util")\n')
    put(r.dir, 'app/build.gradle.kts', 'dependencies { implementation(projects.myLib) }\n')
    put(r.dir, 'app/build.gradle', '')
    put(r.dir, 'my-lib/build.gradle.kts', 'dependencies { api(projects.core) }\n')
    put(r.dir, 'my-lib/src/test/java/T.java', '')
    // settings.gradle が空でも .kts を優先して読む
    const s = await gsel(r, { changed: [CALC] })
    assert.equal(s.mode, 'subset')
    assert.deepEqual(s.argv, ['./gradlew', ':app:test', ':core:test', ':my-lib:test'])
  } finally { r.cleanup() }
})

test('gradle: projectDir の付け替えを読む', async () => {
  const r = tempRepo('gradle-multi')
  try {
    put(r.dir, 'settings.gradle',
      "include ':core', ':app'\ninclude ':util'\nproject(':util').projectDir = file('libs/util-impl')\n")
    put(r.dir, 'libs/util-impl/build.gradle', '')
    put(r.dir, 'libs/util-impl/src/test/java/T.java', '')
    const s = await gsel(r, { changed: ['libs/util-impl/src/main/java/X.java'] })
    assert.deepEqual(s.argv, ['./gradlew', ':util:test'])
  } finally { r.cleanup() }
})

test('gradle: テストが無いモジュールだけの変更は none', async () => {
  const r = tempRepo('gradle-multi')
  try {
    put(r.dir, 'settings.gradle', "include ':core', ':app', ':util', ':assets'\n")
    put(r.dir, 'assets/build.gradle', '')
    put(r.dir, 'assets/src/main/resources/a.json', '{}')
    const s = await gsel(r, { changed: ['assets/src/main/resources/a.json'] })
    assert.equal(s.mode, 'none')
    assert.match(s.reason, /テストが無い/)
  } finally { r.cleanup() }
})

test('gradle: settings が動的ならモジュール表を作れず full', async () => {
  const r = tempRepo('gradle-multi')
  try {
    put(r.dir, 'settings.gradle', "rootDir.eachDir { if (new File(it, 'build.gradle').exists()) include it.name }\n")
    const s = await gsel(r, { changed: [STRINGS] })
    assert.equal(s.mode, 'full')
    assert.deepEqual(s.argv, G)
  } finally { r.cleanup() }
})

test('gradle: ルートの build.gradle が project(":x") で依存を書くなら full', async () => {
  const r = tempRepo('gradle-multi')
  try {
    put(r.dir, 'build.gradle', "project(':app') { dependencies { implementation project(':util') } }\n")
    const s = await gsel(r, { changed: [STRINGS] })
    assert.equal(s.mode, 'full')
  } finally { r.cleanup() }
})

test('gradle: settings が無い単一プロジェクトは full', async () => {
  const r = tempRepo('gradle-multi')
  try {
    put(r.dir, 'settings.gradle', '')
    const s = await gsel(r, { changed: [STRINGS] })
    assert.equal(s.mode, 'full')
  } finally { r.cleanup() }
})

// ───────── swift / xcodebuild: 選択の仕組みが無いので full ─────────

const SW = ['swift', 'test']
const XC = ['xcodebuild', 'test', '-scheme', 'App', '-destination', 'platform=macOS']

for (const [name, argv, label] of [['swift', SW, /^swift test:/], ['xcodebuild', XC, /^xcodebuild test:/]]) {
  test(`${name}: 変更があっても full。argv はそのまま`, async () => {
    const r = tempRepo('swift-multi')
    try {
      const s = await select({ argv, cwd: r.dir, env: {}, changed: ['Sources/Core/Calc.swift'], base: null, full: false })
      assert.equal(s.mode, 'full')
      assert.deepEqual(s.argv, argv)
      assert.match(s.reason, label)
    } finally { r.cleanup() }
  })
  test(`${name}: 変更なしは none`, async () => {
    const s = await select({ argv, cwd: '/tmp', env: {}, changed: [], base: 'x', full: false })
    assert.equal(s.mode, 'none')
  })
  test(`${name}: full:true は元の argv`, async () => {
    const s = await select({ argv, cwd: '/tmp', env: {}, changed: ['a.swift'], base: null, full: true })
    assert.equal(s.mode, 'full')
    assert.deepEqual(s.argv, argv)
  })
  test(`${name}: 文書だけの変更は none`, async () => {
    const s = await select({ argv, cwd: '/tmp', env: {}, changed: ['README.md', 'docs/guide.md'], base: null, full: false })
    assert.equal(s.mode, 'none')
  })
}

for (const argv of [
  ['swift', 'test', '--filter', 'CalcTests'],
  ['swift', 'test', '--filter=CalcTests/testAdd'],
  ['swift', 'test', '--skip', 'SlowTests'],
  ['xcodebuild', 'test', '-scheme', 'App', '-only-testing:AppTests/FooTests'],
  ['xcodebuild', 'test', '-scheme', 'App', '-skip-testing:AppUITests'],
  ['xcodebuild', 'test', '-scheme', 'App', '-only-testing', 'AppTests'],
  ['xcodebuild', 'test', '-scheme', 'App', '-testPlan', 'Unit'],
]) {
  test(`${argv.slice(0, 2).join(' ')} ${argv.slice(2).join(' ')} は passthrough`, async () => {
    const s = await select({ argv, cwd: '/tmp', env: {}, changed: ['Sources/Core/Calc.swift'], base: null, full: false })
    assert.equal(s.mode, 'passthrough')
    assert.deepEqual(s.argv, argv)
  })
}

test('テストを走らせない呼び方は select でも触らない', async () => {
  for (const argv of [['swift', 'build'], ['xcodebuild', 'build'], ['./gradlew', 'assemble'], ['ls']]) {
    const s = await select({ argv, cwd: '/tmp', env: {}, changed: ['a.swift'], base: null, full: false })
    assert.equal(s.mode, 'passthrough')
    assert.deepEqual(s.argv, argv)
  }
})

// ───────── gradle: 件数のための -I と build の扱い（マクスウェル 2026-10-13 の判断）─────────

test('gradle: subset と選択による full には -I <init script> が付く。passthrough・none・full:true には付かない', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const sub = await select({ argv: G, cwd: r.dir, env: {}, changed: [STRINGS], base: null, full: false })
    assert.equal(sub.mode, 'subset')
    assert.deepEqual(sub.argv, ['./gradlew', '-I', INIT, ':util:test'])
    assert.ok(path.isAbsolute(INIT) && existsSync(INIT))
    const fullRule = await select({ argv: G, cwd: r.dir, env: {}, changed: ['settings.gradle'], base: null, full: false })
    assert.equal(fullRule.mode, 'full')
    assert.deepEqual(fullRule.argv, ['./gradlew', '-I', INIT, 'test'])
    for (const over of [{ changed: [] }, { changed: [CALC], full: true }, { argv: ['./gradlew', 'test', '--tests', 'X'], changed: [CALC] }]) {
      const s = await select({ argv: G, cwd: r.dir, env: {}, base: null, full: false, ...over })
      assert.ok(!s.argv.includes('-I'), JSON.stringify(s))
      if (over.argv) assert.deepEqual(s.argv, over.argv)
    }
  } finally { r.cleanup() }
})

test('gradle: 人が -I / --init-script を付けていれば足さない', async () => {
  const r = tempRepo('gradle-multi')
  try {
    for (const flag of [['-I', '/x/mine.gradle'], ['--init-script', '/x/mine.gradle'], ['--init-script=/x/mine.gradle']]) {
      const argv = ['./gradlew', ...flag, 'test']
      const s = await select({ argv, cwd: r.dir, env: {}, changed: [STRINGS], base: null, full: false })
      assert.equal(s.mode, 'subset')
      assert.deepEqual(s.argv, ['./gradlew', ...flag, ':util:test'])
    }
  } finally { r.cleanup() }
})

test('gradle: init script は adapter と同じ場所にあり、passed/failed/skipped を出させる', () => {
  assert.ok(existsSync(INIT))
  assert.match(readFileSync(INIT, 'utf8'), /events 'passed', 'failed', 'skipped'/)
})

for (const argv of [
  ['./gradlew', 'build'],
  ['./gradlew', 'clean', 'build'],
  ['./gradlew', 'build', '--info'],
  ['gradle', 'buildNeeded'],
  ['./gradlew', 'buildDependents'],
]) {
  test(`gradle: ${argv.slice(1).join(' ')} は detect true、select は full で argv を変えない`, async () => {
    const r = tempRepo('gradle-multi')
    try {
      assert.equal(detect(argv), true)
      for (const changed of [[STRINGS], [], ['README.md'], ['settings.gradle']]) {
        const s = await select({ argv, cwd: r.dir, env: {}, changed, base: null, full: false })
        assert.equal(s.mode, 'full', changed.join())
        assert.deepEqual(s.argv, argv)
        assert.match(s.reason, /build は check 経由でテストも流す/)
      }
    } finally { r.cleanup() }
  })
}

test('gradle: build でも -x test・-x check ならテストは流れないので detect false', () => {
  assert.equal(detect(['./gradlew', 'build', '-x', 'test']), false)
  assert.equal(detect(['./gradlew', 'build', '-x', 'check']), false)
  assert.equal(detect(['./gradlew', 'assemble']), false)
})

test('gradle: build と test を並べたら build は修飾できないので full（argv はそのまま）', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const argv = ['./gradlew', 'build', 'test']
    const s = await gsel(r, { argv, changed: [STRINGS] })
    assert.equal(s.mode, 'full')
    assert.deepEqual(s.argv, argv)
  } finally { r.cleanup() }
})

test('gradle: :app:build のようにモジュールを指す build は passthrough', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const s = await select({ argv: ['./gradlew', ':app:build'], cwd: r.dir, env: {}, changed: [STRINGS], base: null, full: false })
    assert.equal(s.mode, 'passthrough')
    assert.deepEqual(s.argv, ['./gradlew', ':app:build'])
  } finally { r.cleanup() }
})

test('select は argv を書き換えない（元の配列を破壊しない）', async () => {
  const r = tempRepo('gradle-multi')
  try {
    const argv = ['./gradlew', 'test']
    const copy = [...argv]
    await gsel(r, { argv, changed: [STRINGS] })
    assert.deepEqual(argv, copy)
  } finally { r.cleanup() }
})
