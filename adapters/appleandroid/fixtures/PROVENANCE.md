# fixtures の出所

## 実際に走らせて採った物（この席のコンテナ。2026-10-13）

| 置き場 | 内容 | 走らせた物 |
| --- | --- | --- |
| `gradle-multi/` | gradle の小さなマルチモジュール（core・app→core・util） | Gradle 8.10.2 + Temurin 21 |
| `swift-multi/` | SwiftPM の小さなパッケージ（XCTest 2 ターゲット、Swift Testing 1 ターゲット） | Swift 6.0.3 (Linux x86_64) |
| `outputs/swift-*.txt` | `swift test` の実出力（成功・失敗・skip・`--filter`・コンパイル失敗） | 上の swift-multi（失敗は一時コピーで壊して採取） |
| `outputs/gradle-*.txt` | `./gradlew clean test` の実出力（成功・失敗・コンパイル失敗。`-logging` は `testlogging.init.gradle` を付けた物） | 上の gradle-multi |
| `rtk/*.rtk.txt` | 上の出力を `rtk test`（rtk 0.51.0）に通した実出力 | `rtk test sh -c 'cat …; exit N'` |

## 公開されている実例（コピー。ライセンスは各リポジトリのMIT）

`outputs/public/` に置いた。ログは各プロジェクトの試験データで、中身は書き換えていない（specta・xcpretty は抜粋）。

| ファイル | 出所 | 形式 |
| --- | --- | --- |
| `MixedTestLog_6_0_Linux.txt` / `MixedTestLog_6_0_macOS.txt` | cpisciotta/xcbeautify `Tests/XcbeautifyLibTests/TestData/` | `swift test`（XCTest + Swift Testing、失敗あり）Linux・macOS |
| `ParallelTestLog.txt` | 同上 | xcodebuild 並列実行（Xcode 13 形式 `Test case '…' passed on 'Clone 1 of …'`、末尾の要約なし） |
| `TestLog.txt` | 同上 | `swift test`（83 件、1 失敗、1 skip。skip は要約に数えられない古い形式） |
| `demo_swift_testing_log.txt` | 同上 | Swift Testing（SF Symbols の記号、skip あり） |
| `spi_swift_testing_short_log.txt` | 同上 | Swift Testing（失敗3件） |
| `swift_test_log_macOS.txt` | 同上 | `swift test`（XCTest 113 + Swift Testing 351、失敗あり） |
| `specta_fail_octest.txt` | xcpretty/xcpretty `spec/fixtures/raw_specta_fail.txt` | 2013 年の xcodebuild（octest、922件、1失敗。`finished at` 形式） |
| `xcpretty_xcodebuild_excerpt.txt` | xcpretty/xcpretty `features/fixtures/xcodebuild.log` の 5296〜5963 行 | 2013 年の xcodebuild（成功。バンドルの要約が無い抜粋） |
| `xcpretty_kiwi_compile_fail.txt` | xcpretty/xcpretty `spec/fixtures/raw_kiwi_compilation_fail.txt` | xcodebuild のコンパイル失敗（clang の `error:` 2 件。末尾の `** BUILD FAILED **` が無い抜粋） |

## 作った物（実出力ではない）

- `outputs/constructed-xcodebuild-test-build-failed.txt`: 上の `xcpretty_kiwi_compile_fail.txt` の後ろに、Xcode が出す `** TEST BUILD FAILED **` と `The following build commands failed:` を足した物。`** TEST BUILD FAILED **` を含む実ログを公開物から見つけられなかったため、書式は Xcode の既知の出力に合わせて書いた。**実機の記録ではない**。実機（Mac の席）で採れたら差し替える。
- xcodebuild の「成功」の実出力は、コンテナでは採れず、公開ログのうち xcpretty の抜粋（`** TEST SUCCEEDED **` を含む元ログの一部）と、`swift test` の出力（XCTest の行は xcodebuild と同じ）で代える。
