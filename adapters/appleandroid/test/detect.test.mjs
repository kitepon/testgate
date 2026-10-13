import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detect, id, runners } from '../adapter.mjs'

const yes = cmd => test(`detect true: ${cmd}`, () => assert.equal(detect(cmd.split(' ')), true))
const no = cmd => test(`detect false: ${cmd}`, () => assert.equal(detect(cmd.split(' ')), false))

test('id は小文字英字のみ、runners がある', () => {
  assert.match(id, /^[a-z]+$/)
  assert.ok(runners.length >= 3)
})

// ── swift ──
;[
  'swift test',
  'swift test --parallel',
  'swift test -c release',
  'swift test --enable-code-coverage --skip-build',
  'swift test --filter CalcTests',
  'swift test --package-path ./pkg',
  'swift --package-path ./pkg test',
  '/usr/bin/swift test',
  'xcrun swift test',
  'env CI=1 swift test',
  'CI=1 swift test',
  'time swift test',
  'swift-test',
].forEach(yes)
;[
  'swift build',
  'swift build --build-tests',
  'swift build -c release',
  'swift run',
  'swift package resolve',
  'swift package update',
  'swift --version',
  'swift -version',
  'swift test --help',
  'swift test -h',
  'swift test --list-tests',
  'swift test -l',
  'swift test list',
  'swift test --show-codecov-path',
  'swift',
  'swiftlint',
  'swift-format .',
].forEach(no)

// ── xcodebuild ──
;[
  'xcodebuild test',
  'xcodebuild test -scheme App',
  'xcodebuild -scheme App -destination platform=iOS_Simulator,name=iPhone_15 test',
  'xcodebuild -workspace A.xcworkspace -scheme A -destination platform=macOS test',
  'xcodebuild test-without-building -xctestrun x.xctestrun',
  'xcodebuild clean test -scheme App',
  'xcodebuild -quiet test -scheme App',
  'xcodebuild test -scheme App -only-testing:AppTests/FooTests',
  'xcodebuild test -scheme App -skip-testing:AppUITests',
  'xcodebuild test -scheme App -testPlan Unit',
  'xcodebuild test -scheme App -enableCodeCoverage YES',
  'xcodebuild test -scheme App CODE_SIGNING_ALLOWED=NO',
  'xcrun xcodebuild test -scheme App',
  'xcrun --sdk iphoneos xcodebuild test -scheme App',
  'NSUnbufferedIO=YES xcodebuild test -scheme App',
].forEach(yes)
;[
  'xcodebuild build',
  'xcodebuild -scheme App build',
  'xcodebuild -scheme App -configuration Release build',
  'xcodebuild build-for-testing -scheme App',
  'xcodebuild archive -scheme App',
  'xcodebuild clean',
  'xcodebuild clean build',
  'xcodebuild analyze -scheme App',
  'xcodebuild -showBuildSettings',
  'xcodebuild -showBuildSettings -scheme App',
  'xcodebuild -showTestPlans -scheme App',
  'xcodebuild -showdestinations -scheme App',
  'xcodebuild -showsdks',
  'xcodebuild -list',
  'xcodebuild -version',
  'xcodebuild -help',
  'xcodebuild -scheme App test -dry-run',
  'xcodebuild -scheme App -enumerate-tests test',
  'xcodebuild -exportArchive -archivePath a -exportPath b',
  'xcodebuild -resolvePackageDependencies',
  'xcodebuild',
  'xcodebuild -scheme test build',
].forEach(no)

// ── gradle ──
;[
  './gradlew test',
  'gradle test',
  'gradlew test',
  '.\\gradlew.bat test',
  'gradlew.bat test',
  '/work/app/gradlew test',
  './gradlew test --tests com.example.FooTest',
  './gradlew :app:test',
  './gradlew app:test',
  './gradlew :app:testDebugUnitTest',
  './gradlew testDebugUnitTest',
  './gradlew testReleaseUnitTest',
  './gradlew check',
  './gradlew allTests',
  './gradlew jvmTest',
  './gradlew connectedDebugAndroidTest',
  './gradlew connectedCheck',
  './gradlew clean test',
  './gradlew test --info --no-daemon',
  './gradlew --console=plain test',
  './gradlew -p sub test',
  './gradlew test -x lint',
  './gradlew test --continue --rerun-tasks',
  './gradlew -Pfoo=bar -Dx=y test',
  './gradlew --offline :core:test :app:test',
  'JAVA_HOME=/opt/jdk ./gradlew test',
  'env JAVA_HOME=/opt/jdk ./gradlew test',
  'bash ./gradlew test',
  './gradlew check -x test',
  './gradlew build',
  './gradlew clean build',
  './gradlew build --info',
  'gradle buildNeeded',
].forEach(yes)
;[
  './gradlew assemble',
  './gradlew assembleDebug',
  './gradlew clean',
  './gradlew build -x test',
  './gradlew build -x check',
  './gradlew test -x test',
  './gradlew testClasses',
  './gradlew compileTestKotlin',
  './gradlew compileTestJava',
  './gradlew lint',
  './gradlew tasks',
  './gradlew tasks --all',
  './gradlew help --task test',
  './gradlew dependencies --configuration testRuntimeClasspath',
  './gradlew projects',
  './gradlew properties',
  './gradlew --version',
  './gradlew -v',
  './gradlew --help',
  './gradlew -h',
  './gradlew test --dry-run',
  './gradlew test -m',
  './gradlew --stop',
  './gradlew wrapper --gradle-version 8.10',
  './gradlew jacocoTestReport',
  './gradlew',
  'gradle',
].forEach(no)

// ── ランナーでない ──
;[
  'ls',
  'ls -la',
  'pytest --version',
  'python -m pytest',
  'npm test',
  'cargo test',
  'go test ./...',
  'node --test',
  'make test',
  'mvn test',
  'echo swift test',
  'cat gradlew',
  'git status',
  'rm -rf build',
].forEach(no)

test('空や不正な argv は false', () => {
  assert.equal(detect([]), false)
  assert.equal(detect(undefined), false)
  assert.equal(detect(['env']), false)
})
