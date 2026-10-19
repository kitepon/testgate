# testgate アダプタ: .NET（dotnet test）

契約: `/srv/bellteam/bots/bot-47fad91c/docs/testgate-adapter-contract.md`（v0.5 で確認）。外部依存なしの Node ESM。

```
node --test test/*.test.mjs
```

dotnet が PATH に無い席では、実機で流す試験1本だけ skip になる（それ以外は solution・csproj・.cs を読むだけで dotnet を呼ばない）。SDK は `environment/setup.sh` が自分のプロジェクトへ入れる。

- `id = 'dotnet'`、`runners = ['dotnet test']`。`reason` の先頭は `dotnet test: `。
- **選択のために外部コマンドを呼ばない**。solution・csproj・ソースを読むだけなので、restore 前でも、SDK が無い席でも選べる（5秒の上限は `deadline` で守る）。

## 対応する呼び方

| 呼び方 | 動作 |
| --- | --- |
| `dotnet test` / `dotnet test X.sln` / `.slnx` / `.slnf` / 引数なし（cwd に solution が1つ） | 変更ファイルの所属プロジェクトを ProjectReference の逆引きでたどり、影響するテストプロジェクトだけを流す。可能ならテストクラス単位まで `--filter` で絞る |
| テストプロジェクトのディレクトリで `dotnet test`（csproj が1つ、solution なし） | そのプロジェクトが範囲。依存先（ProjectReference の推移）の変更も影響として扱い、クラス単位で絞る。影響が届かなければ `none` |
| `-c Release`、`--no-build`、`-l trx`、`-- RunConfiguration...` など | そのまま残す。名前のある値付きオプションを読み飛ばして、位置引数を見分ける |
| 前置き | `rtk dotnet test`、`DOTNET_CLI_UI_LANGUAGE=en dotnet test`、`dotnet.exe`、フルパス |

## argv の形

- 影響テストプロジェクトが1つ → `dotnet test <相対パス.csproj> --filter "..." <元のオプション>`。
- 2つ以上で、全部ではない → **solution filter（.slnf）を一時ディレクトリ（`<tmp>/testgate-dotnet/<hash>.slnf`）へ書き**、`dotnet test <それ> --filter "..."`。`dotnet test` は位置引数を1つしか取れないため。内容は同じなら同じファイル名（hash）。リポジトリ内には何も書かない。
- 全部のテストプロジェクトに届く時は、元の位置引数のまま `--filter` だけ足す（または `full`）。
- `--filter` の式は `FullyQualifiedName~Ns.Class|FullyQualifiedName~Ns.Class2`（xUnit・NUnit・MSTest 共通）。入れ子クラスは外側のクラス名で拾える。クラスが300件・式が7000字を超える時、名前に特殊文字がある時は filter を付けない（プロジェクト単位まで）。

## 動作の決まり

### プロジェクト単位

- 変更ファイルの所属 = 最も深い csproj のディレクトリの下（`bin/`・`obj/` を除く）。csproj が `..` や `$(...)` で取り込む外部ファイル（`<Compile Include="..\Shared\*.cs">`、`<Import>`）も所属に数える。
- 影響 = 変更プロジェクトと、それを ProjectReference で（推移して）参照するプロジェクト。実行範囲のテストプロジェクトと重なる分が対象。
- テストプロジェクトの判定: `IsTestProject`、`Microsoft.NET.Test.Sdk` / xunit / NUnit / MSTest / TUnit の PackageReference、`Sdk="MSTest.Sdk"`、`Directory.Build.props` が test の SDK を足している時の名前（`*Tests`）。
- 変更が `.md` だけ、またはどのプロジェクトにも属さない → `none`。変更したのが `bin/`・`obj/` の中だけでも `none`。

### テストクラス単位（プロジェクト内）

テストが1プロジェクトに固まっている時の絞り込み。**型名の言及のグラフ**で選ぶ。

1. 範囲の全プロジェクトの `.cs`（と `.xaml`/`.axaml`/`.razor`）を読み、コメントと文字列を落として型（class・struct・record・interface・enum、入れ子も）と拡張メソッド名を宣言として集める。
2. 波及は**最上位の型（宣言）単位**で追う（ファイルの中の別の型へは、その型自身が言及されない限り広がらない。`using` 指令と最後の型の後ろは、ファイル内の全ての型への言及として数える）。型を読めないファイルはファイル全体で1つとして扱う。型の手前にある top-level statements は直後の型へ帰属させず、独立のノード（暗黙の `Program`）にする。暗黙の `Program` だけが宣言者の時は、`typeof(Program)`・`<Program>`・`new Program`・型として置いた `Program x` のような型の使い方だけを言及に数え、同名のメソッドや変数（`Program()`）は数えない。入れ子の private 型（修飾子なしも private）の名前は、外側の最上位の型の外から参照できないので、他のファイルの言及先に数えない（別ファイルの同名の private 入れ子型との取り違えを防ぐ）。private の入れ子型を持つ型は、同じ完全名の partial の別ファイルと運命を共にする。
   型Yが、型Xの宣言した名前を識別子として含むなら（Y のコメントは読まない。文字列は補間式にコードがあるので読む）「Y は X に依存」。
3. 変更ファイルから、依存の逆向きに推移でたどる。さらに、変更ファイルの型が継承・実装している基底型（宣言が範囲内にある物）を言及するファイルも足す（DI や interface 越しに使う側へ届かせるため）。ただし、テストプロジェクトだけが所有するファイル（test double など）の基底からは、本体側の言及先へ広げない（テストの変更が本体の使う側へ逆流するのを止める。基底の宣言もテスト側にある時は広げる）。
4. たどり着いたファイルのうち、テストプロジェクトの物の最上位の型を `--filter` にする。

絞らない（プロジェクト全体を流す）条件:

- csproj・`appsettings.json`・resx・画像など、型へ分けられない変更（所属プロジェクトに依存するテストプロジェクト全部）。
- 削除されたソース（消える前の宣言を読めない）。
- 型の宣言を読めないソース（top-level statements のみ等）に届いた時。
- 同じ実行に「絞れない」テストプロジェクトが混じる時（filter は実行全体に掛かるため、全体で絞らない）。
- 環境変数 `TESTGATE_DOTNET_NOFILTER` を立てた時（プロジェクト単位まで）。

### full・none・passthrough

- `Directory.Build.props/targets/rsp`、`Directory.Packages.props`、`global.json`、`nuget.config`、`.editorconfig`（対象プロジェクトの祖先にある物）、solution 自体（.sln/.slnx/.slnf）の変更 → `full`。どのプロジェクトが取り込むか分からない `.props`/`.targets` も `full`。
- 影響がテストプロジェクト全部の全クラスに及ぶ → `full`。reason は **「単一テストプロジェクトで、テストクラス単位の絞りも効かない」** と **「影響が実行範囲の全体に及ぶ（選べたが全部）」** を分ける。
- 流す物が無い（変更がテストに言及されない）→ `none`。
- 人が絞っている → `passthrough`: `--filter`、プロジェクト・dll の名指し、位置引数が複数。solution・ディレクトリ・引数なしが選択の対象。
- 読み込みに失敗した（csproj が壊れている等）→ `full`。5秒に収まらない・ソースが160MBを超える → `passthrough`。

## parseOutput

- VSTest の要約行 `Passed! - Failed: 0, Passed: 2403, Skipped: 0, Total: 2403, Duration: 4 s - X.dll (net8.0)`（`Failed!` も）をプロジェクトごとに合算。失敗テストは `Failed Ns.Class.Method [12 ms]` の行と xUnit の `[FAIL]` 行。
- `errors`: ビルドエラー（`: error CSxxxx:` / `MSBxxxx` / `NUxxxx`）をプロジェクトごとに1と数え、`Test Run Aborted` も数える。`failed` にも含める。`failures` にはビルドエラーの場所（`Clock.cs(5,5): CS0246`）が入る。
- rtk 短縮後（`ok dotnet test: 9 tests passed, ... (588 ms)` / `fail dotnet test: 8 passed, 1 failed ...` と `Failed Tests:` の下の名前）。
- 古い形式（`Total tests: N` / `Passed:` / `Failed:`）も読む。
- `stripCounts`: `Passed!` 行（`Failed!` は件数を落として残す）、`A total of N test files matched`、`Passed  X [..]`（詳細出力）、`ok dotnet test:` 行を落とす。失敗の詳細・例外・ビルドエラーは残す。

## 対応していない呼び方（passthrough または検出しない）

- 検出しない: `--help`・`-h`・`--version`・`--list-tests`/`-t`、`dotnet build`、`dotnet run`、`dotnet watch test`、`dotnet vstest`、`dotnet msbuild -t:VSTest`。
- passthrough: `--filter` の指定、`X.csproj`・`X.dll` の名指し。
- Microsoft.Testing.Platform（.NET 10 の `dotnet test` の新モード、`OutputType=Exe` のテスト）の出力は、要約行の形が違うので未確認。件数が読めない時は `parseOutput` が `undefined` を返す。
- `.fs`・`.vb` のテストプロジェクトはプロジェクト単位まで（クラス単位の絞りは C# のみ）。

## 既知の限界（取りこぼしうる所）

型名の言及による絞り込みは**静的な近似**で、実行時にしか決まらない結び付きは追えない。取りこぼしが出る典型:

- リフレクション・文字列での型解決、アセンブリのスキャンによる DI 登録、`Type.GetType("...")`。
- `appsettings.json` や埋め込みリソースの内容に依存するテスト（変更したファイルが所属プロジェクトの下にあれば、そのプロジェクト全体を流すので拾う）。
- ソースジェネレーターが作る型・分析器の挙動。
- 範囲外のファイルを実行時に読む物（csproj が取り込まない）。

それでも不安な席は `TESTGATE_DOTNET_NOFILTER=1`（プロジェクト単位まで）か `TESTGATE_FULL=1`（全部）を使える。名前の衝突（同名の型が別の名前空間にある）は多めに拾う側に倒れる。

- パス比較は大文字小文字を区別する（Windows は区別しない設定にしてあるが実機では未確認）。
- `.slnx` の読み取りと、`.slnf` から `.slnx` を指す書き方は SDK 9.0.318 で確かめた（SDK 8 は `.slnx` を読めない）。

## fixtures

- `fixtures/dotnet-sln/` — solution。`Core` ← `Util` ← `App`、独立の `Indep`。テストは `Main.Tests`（Greeter・Money・Formatter・Report・Scheduler の5クラス）、`Util.Tests`（Clock）、`Indep.Tests`。xUnit。`FX_FAIL=1` で1件落ちる。
- `fixtures/samples/` — 実出力。`dotnet-pass/fail/buildfail.txt`（SDK 8.0.425）と `rtk-dotnet-pass/fail/buildfail.txt`。

## 日本語の VSTest 出力

合計行は `成功!`/`失敗!` と `失敗:`・`合格:`・`スキップ:`・`合計:`・`期間:`（区切りは「、」）を読む。個別の `失敗 名前 [2 s]` 行も失敗名に数える。`合格 名前 [..]` 行は stripCounts が消す。実機（fox, SDK10.0.401）の採取で確かめた。他の言語の出力は未対応。

## prune（刈り込み、段階2）

`prune.mjs` は段階1の `adapter.mjs` と独立する。npm依存なし。

```sh
testgate prune --runner dotnet --cwd /path/to/repository --sample 200 --seed monthly-2026-10
# 対象を明示する例（globはリポジトリの根から）
testgate prune --runner dotnet --cwd /path/to/repository --mutate 'src/Calc/**/*.cs' --tests 'tests/Calc.Tests/**/*.cs' --sample 10
```

`--tests` はテストcsprojまたはC#ソースのglob。`--exclude` は試験ソースのglobまたは完全修飾メソッド名のglob。テストcsprojはMicrosoft.NET.Test.Sdk/xUnit/NUnit/MSTest参照またはIsTestProjectから発見する。参照とCompile項目は `dotnet msbuild -getItem` で評価し、生成物・テスト・依存ライブラリを変異させない。cwdは依存するcsprojとソースを含むリポジトリの根を指定する。外部のProjectReferenceを書き換えることはしない。

### 実行方式

[Stryker.NET 5.0.0](https://www.nuget.org/packages/dotnet-stryker/5.0.0) を `dotnet tool install --tool-path` で契約指定の `prune-tools/dotnet/5.0.0/` へ初回に導入する。dotnet SDKとNuGetへの初回アクセスが必要。MSBuildのJSON項目取得に対応するSDKが必要で、受入はSDK10で確認した。テスト実行はVSTest形式の `dotnet test --logger trx` を対象とする。MTP専用プロジェクトは未対応で、結果の無い実行を成功や検出0へ補わない。

Stryker.NETの[disable-bailとcoverage分析](https://stryker-mutator.io/docs/stryker-net/configuration/)は失敗の打ち切りを止められるが、JSON報告には失敗文が無く、VSTestの実行設定は内部生成で任意のTRX loggerを渡す入口が無い。このため次の二段階にした。

1. Stryker.NETに全mutatorを `ignore-mutations` として与え、変異の元ソース・位置・完全なreplacementをJSONへ列挙する。Stryker内部では変異テストを実行しない。列挙のJSONは `enumeration-*.json` に残す。
2. seedと変異の内容・source hashで決まる順番から、sample件を正確に選ぶ（0は全件）。作業コピーのソースへ一件だけ適用し、全対象テストをTRX付きで流す。最初の失敗で止めず、全失敗テストを `killedBy` へ、同じ実行の失敗文を `failures.jsonl` へ書く。次の変異の前にソースを戻す。

初回の非変異テストで失敗またはskipしたメソッドは候補から外し、`preflightExcluded` と注記に残す。型付きのxUnit/NUnit/MSTest断言例外と、TRXが例外型を省くxUnit/MSTestの定型断言文を扱う。断言で、最初のstack frameが当該試験クラスなら「狙い」。helperやsetup、製品例外、判定不能は「前提」。失敗本文とstackは4000字まで残す。Theoryのデータ行は完全修飾メソッド名で束ね、初回に一行でも失敗したメソッドは全体を除外する。

計装によるcoverage判定はしない。全対象テストが通った変異はSurvivedとし、NoCoverageとは区別しない。変異でビルドが落ちればCompileError、試験が完了せず全対象の結果が揃わなければRuntimeError、変異全体の上限を超えた時はTimeoutでkilledByを空にする。試験ごとの上限はVSTestの[blame-hang](https://learn.microsoft.com/dotnet/core/tools/dotnet-test-vstest)を使い、ダンプを作らずtesthostを終了する。親の上限超過時は子プロセスの木も終了する。

ソースの変異を混ぜないため変異実行は直列。`--jobs`を指定しても同時変異数は増やさず注記する。これは速度上の制約で、初期版では全失敗の取得を優先した。試験の長いプロジェクトは `--mutate`・`--tests`・`--sample` で範囲を指定する。Windowsの長いテスト一覧はRunSettingsのTestCaseFilterに書き、コマンド行長の制限を避ける。

通常の一時物は本体の一時根の下へ作り、終了時に削除する。`--keep-sandbox` の時は `runDir/sandbox/` に保持する（本体が一時根を削除しても調査用の写しは残る）。リポジトリにGitの追跡ファイルがある時はそれをコピーし、未追跡物は持ち込まない。原本を編集せず、出力の永続物はrunDirと契約指定の外部道具だけ。

### 受入の記録

- 小fixture: `fixtures/prune/`。製品1ファイル、試験4メソッド。算術の変異は重複する2メソッドを両方killedByへ記録。Booleanの変異はsetup中の例外として「前提」を記録。検出0・冗長・前提のみの候補が出ることを断言する。foxの `node --test adapters/dotnet/test/prune.test.mjs` で実物を実行し正常終了。一時物の前後一致と原本不変も断言した（最終確認は約22秒）。
- Linuxの本体 `npm test` は正常終了。.NET SDKが無いため実物fixtureだけ対象外、TRX変換・kind・標本・ソース置換の検証は実行した。
- fox/OpenLogicoolの実リポジトリ確認は下に追記する。候補は採否の判断材料で、自動で試験を削除しない。変異を列挙できない場合は、試験を「検出0」として並べず失敗する。

#### fox / OpenLogicool（2026-10-19）

HEAD `a040f85716fee279a451762088c5931a90a2c122`、SDK10.0.402、Stryker.NET5.0.0。原本を変えず、v0.3.13本体へ候補アダプタを載せた専用TEMPのCLIで一回実行した。

```sh
testgate prune --runner dotnet --cwd C:\Users\kite_\Developer\openlogicool --sample 4 --seed exia-dotnet-accept-20261019 --mutate 'src/OpenLogicool.Host/G13LcdDisplayFrameSelector.cs' --tests 'tests/OpenLogicool.Host.Tests/G13LcdDisplayFrameSelectorTests.cs' --timeout-sec 90 --test-timeout-sec 30 --jobs 1
```

| 項目 | 結果 |
| --- | --- |
| CLI終了 | 0、candidates.txtを生成 |
| 所要時間 | 356.8秒（本体記録356.5秒） |
| 変異の範囲 | G13LcdDisplayFrameSelector.csの17変異からseedで4変異を抽出 |
| 結果 | Killed1、Timeout0、生存1、CompileError2 |
| 試験の範囲 | G13LcdDisplayFrameSelectorTestsの2メソッド、各変異で両方を実行 |
| 候補 | 前提のみ1、冗長0、広域のみ0、検出0は0。残す1 |
| 殺しの分類 | 狙い1、前提1、不明0 |

候補は `Saved_frame_is_selected_and_missing_setting_selects_windows`。内蔵frameの初期化が壊れた変異で前提の例外になっており、削除の採否は求めない。今回の結果は、明示した標本と試験の候補出力を確認した範囲である。

記録はfoxの `C:\Users\kite_\.local\state\testgate\prune\openlogicool\20261019-012032\`。candidates.txt/candidates.json/mutation.json/failures.jsonl/project.json/prune.logを保持。原本HEADとtracked差分は前後で一致した。列挙時にStryker.NETがプロジェクト全体を解析・コンパイルするため、明示した一ファイルでも初期費用が大きい。変異自体の実行よりこの列挙が時間の中心だった。

実機確認で共有コンパイラのAnalyzerAssemblyLoader等が本体の一時根に残ったため、アダプタの子プロセスでは共有コンパイラとMSBuildの再利用を無効にし、削除時の再試行を追加した。原本のビルドサーバー全体を停止しない。最終fixtureでは本体のwithRunTmpで包み、一時根の前後一致も確認する。

当該実機回の残存物は、完了と所有を確認して削除再試行で回収済み。削除後は当該tg-run/tg-dotnet-pruneの残存なし。再利用停止を入れた最終fixtureも、本体の一時根を含めた前後一致で成功した。
