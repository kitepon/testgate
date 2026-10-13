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
2. 波及は**最上位の型（宣言）単位**で追う（ファイルの中の別の型へは、その型自身が言及されない限り広がらない。`using` 指令と最後の型の後ろは、ファイル内の全ての型への言及として数える）。型を読めないファイルはファイル全体で1つとして扱う。入れ子の private 型（修飾子なしも private）の名前は、外側の最上位の型の外から参照できないので、他のファイルの言及先に数えない（別ファイルの同名の private 入れ子型との取り違えを防ぐ）。private の入れ子型を持つ型は、同じ完全名の partial の別ファイルと運命を共にする。
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
