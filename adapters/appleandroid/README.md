# testgate アダプタ: swift test・xcodebuild test・gradle test

契約 v0.4（`/srv/bellteam/bots/bot-47fad91c/docs/testgate-adapter-contract.md`）に沿った Node ESM モジュール。外部依存なし。

```
node --test test/*.test.mjs                                   # 通常の試験（実ランナー不要）
TESTGATE_REAL_RUNNERS=1 JAVA_HOME=… node --test test/integration.test.mjs   # 実 gradle・swift で確かめる（任意）
```

- `id = 'appleandroid'`、`runners = ['swift test', 'xcodebuild test', 'gradle test']`
- `reason` の先頭は `swift test:` / `xcodebuild test:` / `gradle test:`。

## 対応している呼び方（detect が true）

環境変数の前置（`CI=1 …`、`JAVA_HOME=… ./gradlew test`）と、ラッパー `env` `time` `nice` `nohup` `xcrun`（`--sdk X` も） `arch` `caffeinate` `command` `exec` を外して判定する。`bash ./gradlew test` も見る。

| ランナー | 呼び方の例 |
| --- | --- |
| swift | `swift test`、`swift test --parallel`、`-c release`、`--enable-code-coverage`、`--skip-build`、`--package-path DIR`、`swift --package-path DIR test`、`xcrun swift test`、`swift-test` |
| xcodebuild | `xcodebuild test`、`xcodebuild -scheme S -destination D test`、`test-without-building`、`clean test`、`-testPlan`、`-only-testing:`・`-skip-testing:`（select は passthrough）、`KEY=VALUE` のビルド設定 |
| gradle | `./gradlew test`、`gradle test`、`gradlew.bat test`、`check`、`allTests`、`jvmTest`、`testDebugUnitTest` など `test*` と `*Test`、`connected*AndroidTest`、`connectedCheck`、`:app:test`、`clean test`、`--tests X`、`-p DIR`、`--continue` などのオプション |

## テストを走らせない呼び方（detect が false）

- swift: `build`、`run`、`package …`、`--version`、`-h`/`--help`、`test --list-tests`/`-l`/`list`、`test --show-codecov-path`
- xcodebuild: `build`、`build-for-testing`、`archive`、`analyze`、`clean` だけ、`-showBuildSettings`、`-showTestPlans`、`-showdestinations`、`-showsdks`、`-list`、`-version`、`-help`、`-enumerate-tests`、`-dry-run`、`-exportArchive`、`-resolvePackageDependencies`、アクション無し
- gradle: `assemble*`、`clean`、`lint`、`testClasses`・`compile*Test*`（テストのコンパイルだけ）、`tasks`、`help`、`dependencies`、`projects`、`properties`、`wrapper`、`--version`、`--help`、`--dry-run`/`-m`、`--test-dry-run`、`jacocoTestReport`、タスク無し、`-x test` でテストを外した呼び方
- どのランナーでもない呼び方（`ls`、`pytest --version`、`npm test`、`mvn test`、`make test` など）

`./gradlew assemble` は false。`gradle build` は `check` を通じてテストも走らせるので true（下の「gradle の追加の決まり」）。

## select の振る舞い

順に判定する。

1. `full: true` → 元の argv のまま `full`。
2. `changed` が空 → `none`（前回の失敗があっても変えない）。
3. `changed` が文書だけ（`*.md`・`*.txt`・`LICENSE`・`docs/`・`.github/` など。`src/`・`Sources/`・`Tests/` の下は文書扱いしない） → `none`。
4. 人が範囲を絞っている → `passthrough`: swift の `--filter`/`--skip`、xcodebuild の `-only-testing`/`-skip-testing`/`-testPlan`、gradle の `--tests`、`-Dtest.single`、モジュール修飾のタスク（`:core:test`）、サブプロジェクトの中や `-p サブ` からの実行。
5. swift・xcodebuild → `full`（選ぶ手段が無い。時間上限は関所側）。
6. gradle → 下のモジュール選択。

### gradle の追加の決まり（2026-10-13 マクスウェルの判断）

- **件数のための `-I`**: subset と、ルールで決まった `full`（settings 変更など）では、argv に `-I <adapter.mjs と同じ場所の gradle-testlogging.init.gradle の絶対パス>` を足す（実行ファイルの直後）。`gradle-testlogging.init.gradle` は成功・失敗・skip の行を出させる。パスは `import.meta.url` から解くので、関所がディレクトリごと移しても壊れない。**足さない時**: 人が `-I`/`--init-script` を付けている、`passthrough`、`none`、`full: true`（契約の受入条件「元の argv がそのまま返る」を守るため）。
- **`build`**（`build`・`buildNeeded`・`buildDependents`）: `build` は `check` 経由でテストも流すので detect は true。select は常に `full` で argv は変えない（`-I` も足さない。`none` にもしない）。reason は「build は check 経由でテストも流す」。`build -x test`・`build -x check` は流れないので false。`:app:build` のようにモジュールを指す物は passthrough。`build test` のように並べた物は修飾できないので full。

### gradle のモジュール選択

`./gradlew test` を `./gradlew :a:test :b:test` に直す。テストは実行せず、ファイルを読むだけ（外部コマンドなし）。

1. `settings.gradle(.kts)` を cwd から上へ探し、`include` とその `projectDir` の付け替えを読む。
2. 変更ファイルをモジュールの長い一致で割り当てる。モジュールの外・ルート直下のソースなど、割り当てられない物は `full`。
3. 各モジュールの `build.gradle(.kts)` から `project(':x')` と `projects.x.y`（typesafe accessor、kebab-case は camelCase）を読み、依存元を推移的に足す。変えたモジュールの**依存先**は足さない。
4. 変更モジュールと依存元のうちテストソースを持つ物の `:m:test` を、元のタスクの位置に並べる（`clean`・オプション・環境変数の前置は残す）。
5. 全モジュールに及ぶなら `full`。テストを持つモジュールが無いなら `none`。

次は `full` にする（契約 v0.3）: `settings.gradle(.kts)`、どこかの `build.gradle(.kts)`、`gradle.properties`、ロックファイル（`*.lockfile`）、`libs.versions.toml`、`gradle/` 以下、`buildSrc/`・`build-logic/`、`*.gradle(.kts)`（スクリプトプラグイン）、`gradlew`、`local.properties`。

そのほか `full` に落とす場合: 単一プロジェクト、settings が `eachDir` など動的、ルートの build.gradle が `project(':x')` で依存を書いている、タスク名が `test`/`check` 以外（`testDebugUnitTest` など。修飾すると、そのタスクが無いモジュールで落ちる）。

## parseOutput

| 形式 | 読み取る物 |
| --- | --- |
| XCTest（swift test・xcodebuild。Linux・macOS、`-[Cls m]` と `Cls.m`、2013 年の octest、Xcode 13 の `on 'Clone 1 of …'`） | `All tests`/`Selected tests` の要約（無ければバンドルの要約、それも無ければケース行）。skip は要約の `N tests skipped`、無ければケース行。`failed` は失敗したテスト名の数（要約の failures は表明の数なので） |
| Swift Testing（記号は ✔✘ でも SF Symbols でも可） | `Test run with N tests …` の行 + 失敗・skip の行。XCTest と同じ出力に両方あれば足す |
| gradle | `testLogging` で出した `Cls > m PASSED/FAILED/SKIPPED` の行（select が足す init script で出る）、無ければ失敗行と `N tests completed, M failed`。init script 無しの成功は件数が出ないので `passed` は undefined（作らない） |
| 時間 | XCTest の `(…)` 内の秒、Swift Testing の `after … seconds`、gradle の `BUILD … in 1m 2s` |
| errors（v0.4） | コンパイルの `file:line: error:`（clang・swiftc・javac。XCTest の失敗行は除く）と Kotlin の `e:` の行の数、`** TEST BUILD FAILED **`/`** BUILD FAILED **`、gradle のテストでないタスクの `FAILED`、設定の失敗。`failed` にも足す。テストが走っていないので `passed` は undefined |

`failures` は 50 件まで。テスト名（`Cls.method`、`Cls > method()`）、コンパイルの error は `file:line: error: …`（5件まで）。

### rtk 短縮後の出力

`rtk test`（0.51.0）は swift・xcodebuild・gradle を知らず、出力を**末尾5行**に切る（`OUTPUT (last 5 lines):` で始まる）。件数は一部しか見えない（Swift Testing の行だけ残り、XCTest の分が消える等）ので、`passed`/`failed`/`skipped`/`errors`/`durationMs` を**返さない**。見えている失敗名だけ `failures` に残す。**件数を取るなら rtk に通す前の生出力を渡す**こと。

## stripCounts

落とす行: XCTest の `Executed N tests, with …`、Swift Testing の `Test run with N tests …`、gradle の `N tests completed, M failed`、javac の `N error(s)`、clang の `N errors generated.`。
残す行: 個々のテストの `passed`/`failed` 行、`error:` の詳細、スタック、`Test Suite '…' failed at`、`** TEST FAILED **`、`BUILD FAILED in …`、`N actionable tasks: …`（テスト件数ではない）。

## 対応していない呼び方と理由

- `fastlane scan`、`xcodebuild … | xcpretty`、`./gradlew test | tee`（パイプ・別ツールの内側。パイプは関所が止める）
- `mvn test`・`make test`・`bazel test`（担当外）
- gradle のタスクの camelCase 略語（`./gradlew cT`）、`gradle -Dorg.gradle.…` で別名に束ねたタスク、独自に `test` を名づけ直したタスクは検出できない
- `swift test` を `--filter` で絞る選択、xcodebuild の `-only-testing` の自動生成: 変更からテストを引く既製の仕組みが無く、自作は取りこぼしが出るため（契約は常に full）
- gradle で、convention plugin（`buildSrc`・`build-logic`）がモジュール間の依存を足している構成: 依存表が作れないので、そのファイルの変更は `full` にするが、プラグインが足す `project()` 依存そのものは読めない
- `-p` でルートの下の別ビルドを指す入れ子の複合ビルド（`includeBuild`）の中のファイルは、どのモジュールにも属さないので `full`

## fixtures

`fixtures/PROVENANCE.md` に、実際に走らせた物・公開ログ・作った物の別を書いた。

- `fixtures/gradle-multi/`: core・app（core に依存）・util（独立）、`./gradlew` つき
- `fixtures/swift-multi/`: Core・App（Core に依存）・Util（独立。Swift Testing）
- `fixtures/outputs/`、`fixtures/rtk/`: 実出力（生と rtk 短縮後）
