# testgate 刈り込みアダプタ契約（v0.1、2026-10-19）

関所本体（マクスウェル所有）と、JavaScript 以外の言語の刈り込み（`testgate prune`）アダプタ（マナ: Python、ジエン: Rust・Go、エクシア: .NET）の境目。
段階1の `adapter.mjs`（docs/adapter-contract.md）とは別のファイル `prune.mjs` で、同じ `adapters/<dir>/` に置く。
本体は「候補の集計・合算・記録・担当への文面」を持ち、アダプタは「変異を作って試験を流し、結果を 2 つのファイルに書く」だけを持つ。
候補の決め方（冗長・検出0・前提のみ・広域のみ、狙い／前提の分類、合算）は本体の `lib/prune/candidates.mjs` で、アダプタは触らない。

## 形

- `adapters/<dir>/prune.mjs`（dir は dotnet / pytest / rustgo）。Node.js の ESM、**npm の依存なし**。言語側の変異道具（下）は子プロセスで呼ぶ。
- 開発中の置き場は各担当の自分のプロジェクト `work/testgate-adapter-<lang>/`（`prune.mjs`、`test/*.test.mjs`、`fixtures/`、README の追記）。本体への取り込みは段階1と同じく、マクスウェルが commit を `git am` で統合する（著者は保つ）。
- 試験は `node --test adapters/<dir>/test/*.test.mjs` で通る。言語の道具が無い環境では、その試験だけ skip（本体の prune.test の `toolsReady` と同じ形）にし、道具無しで通る部分（結果ファイルの変換、kind の判定、標本の抽出）は skip しない。
- 本体の呼び方: `testgate prune --runner dotnet|pytest|cargo|go [--cwd DIR] [--sample N] [--seed S] [--mutate GLOB]... [--tests GLOB]... [--exclude GLOB]... [--jobs N] [--timeout-sec N] [--test-timeout-sec N] [--keep-sandbox]`。`--runner` 無しで `package.json` が無い時は、各アダプタの `detect(cwd)` が true の物を使う。

## エクスポート

```js
export const id = 'dotnet'               // アダプタ名
export const runners = ['dotnet test']   // 人が読む走者名

// 1. 判定（--runner 無しの時だけ呼ばれる）。この cwd をこのアダプタで刈り込めるなら true。5 秒以内。
export async function detect(cwd, { env }) → boolean

// 2. 記録の名前（任意）。~/.local/state/testgate/prune/<名前>/ になる。無ければ basename(cwd)。
//    月次の合算はこの名前で過去の回を束ねるので、同じリポジトリで安定した名前（例: csproj の名前、go.mod の module 名、Cargo.toml の package 名）。
export async function name(cwd, { env }) → string

// 3. 刈り込み。runDir に下の「書く物」を書く。戻りは status と事実。
export async function prune({
  cwd,            // リポジトリ（または package）の根
  runDir,         // 記録のフォルダ（作成済み、空）。ここ以外に永続物を残さない。一時物は os.tmpdir() の下（本体が TMPDIR を専用の根に向け、終わったら根ごと消す）
  logFile,        // runDir/prune.log。道具の stdout/stderr はここへ追記する
  sample,         // 変異の標本数（既定 200、0 は全部）
  seed,           // 標本抽出の seed（文字列）。同じ seed・同じ commit なら同じ標本
  mutate,         // --mutate の glob（空なら既定: 製品コードだけ。試験・生成物・依存は外す）
  tests,          // --tests の glob（空なら既定）
  exclude,        // --exclude（試験ファイルや試験名の glob。候補にも出さない）
  timeoutMs,      // 変異 1 件の上限（既定 60 秒）。超えた変異は status 'Timeout'
  testTimeoutMs,  // 試験 1 本の上限
  jobs,           // 並列数（未指定なら道具の既定）
  keepSandbox,    // true なら作業の写しを消さない（調査用）
  env, log,       // log(行) は人向けの進み（本体が stderr へ出す）。道具の生の出力は logFile へ
}) → {
  status,         // 0 = 成功。mutation.json が無ければ本体は失敗として記録し、この status（0 なら 1）で終わる
  runner,         // 記録に残す走者名（例 'dotnet test'、'go test'）
  sampled,        // { total: 全変異数, sampled: 流した数, positions: 位置の数 }（分かる範囲で。無ければ null）
  excluded,       // 実際に除外した試験（ファイル or 名前）
  preflightExcluded, dryRunExcluded, // 下見・初回試験で落ちて除外した物（任意）
  notes,          // candidates.txt の冒頭に出す注記の配列（任意。例: 「DB 試験は skip のまま」）
}
```

## 書く物（runDir の下）

### 1. `mutation.json`（必須）

[mutation-testing-elements の report schema](https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema)（Stryker・Stryker.NET が出す形）。本体が読む項目:

```jsonc
{
  "schemaVersion": "1",
  "thresholds": { "high": 80, "low": 60 },
  "files": {
    "src/Calc.cs": {                       // cwd からの相対 path（/ 区切り）
      "language": "cs",
      "source": "...ファイルの元の全文...",   // 合算と「変異位置の関数名・元コード」に使う。必須
      "mutants": [{
        "id": "0",                         // この回の中で一意な文字列
        "mutatorName": "ArithmeticOperator",
        "replacement": "a - b",            // 完全な置換後のコード（短縮しない。エレグの注文）
        "location": { "start": { "line": 12, "column": 20 }, "end": { "line": 12, "column": 25 } },  // 1 始まり
        "status": "Killed",                // Killed | Survived | Timeout | NoCoverage | CompileError | RuntimeError | Ignored
        "killedBy": ["Calc.Tests.AddTests.Adds"],  // この変異で落ちた試験の id の配列（Killed の時。全部。先頭 1 件だけにしない）
        "coveredBy": ["..."]               // 任意
      }]
    }
  },
  "testFiles": {
    "tests/Calc.Tests/AddTests.cs": {      // 試験ファイルの相対 path。ファイルが分からなければ "" でも可（候補には名前だけ出る）
      "tests": [{ "id": "Calc.Tests.AddTests.Adds", "name": "Calc.Tests.AddTests.Adds", "location": { "start": { "line": 9 } } }]
    }
  }
}
```

- `killedBy` が試験ごとに無いと、冗長も検出0も出せない。**変異 1 件につき全試験を流し、落ちた試験を全部記録する**のが要件。道具が「最初の失敗で止める」なら、止めない設定にするか、道具の外で自分の試験実行を組む。
- `status` は Killed（試験が落ちた）、Survived（全部通った）、Timeout（timeoutMs を超えた。`killedBy` は空）、NoCoverage（どの試験も通らない。道具が分かる時だけ）、CompileError（変異で build が落ちた。候補の集計から外れる）。
- 試験の `id` は回をまたいで安定した完全名（Go: `pkg/path.TestName/Sub`、Python: pytest の nodeid、Rust: `module::path::test_name`、.NET: `Namespace.Class.Method`）。月次の合算は id で束ねる。
- 変異の対応も合算は `file・始終の位置・mutatorName・replacement・source の hash` で取るので、短縮 label を id にしない。

### 2. `failures.jsonl`（強く求める。無いと殺しが全部「不明」= 前提扱いになり、冗長の候補が出ない）

変異ごと・落ちた試験ごとに 1 行の JSON:

```jsonc
{ "mutant": "0", "test": "Calc.Tests.AddTests.Adds", "name": "Calc.Tests.AddTests.Adds",
  "error": "Assert.Equal() Failure\nExpected: 3\nActual: -1\n   at Calc.Tests.AddTests.Adds() in tests/Calc.Tests/AddTests.cs:line 12",  // 失敗文の全文（4000 字まで）
  "kind": "狙い" }   // 狙い | 前提。アダプタが判定する（下）。付けなければ本体が JS 向けの規則（AssertionError で始まり、最初の frame が試験ファイル）で判定するので、JS 以外では必ず付ける
```

`kind` の規則（本体の JS と同じ意味）:
- **狙い** = 試験本文の断言で落ちた。Go: `t.Error*/t.Fatal*`（testify の `assert.*`/`require.*` 含む）が試験ファイルの行で出た失敗。Python: `AssertionError` で、traceback の最後の frame が試験ファイル。Rust: `assertion ... failed`／`assert_eq!` の panic で、位置が試験ファイル（`#[cfg(test)]` のモジュールか `tests/`）。.NET: `Xunit.Sdk.*Exception`／`NUnit.Framework.AssertionException`／`Microsoft.VisualStudio.TestTools.UnitTesting.AssertFailedException` で、stack の最初の frame が試験のクラス。
- **前提** = それ以外。製品コードや helper の中の panic・例外・nil 参照、fixture・setup・DB 接続の失敗、build の失敗、timeout。
- 同じ変異で 3 本以上が同じ失敗文（path・数値・引用を消した 1 行目）で落ちた物は、本体が断言でも「前提」に落とす。アダプタはやらない。

### 3. `project.json`（任意。無ければ本体が最小の物を書く）

cwd・走者・使った道具と版・試験の一覧の取り方・除外・標本の範囲（file／関数）。担当が候補を読む時の「標本の範囲」の材料（エレグの注文 4）。

### 4. `prune.log`

道具の生の出力。本体は中身を見ない。

## 標本抽出

- `sample` 件を `seed` で決定的に選ぶ。道具が位置の指定を受けない時は、ファイル単位・演算子単位の絞り込みでよい（`sampled.positions` にその数）。全変異数（`total`）は道具の列挙（dry run）から取る。
- `**/node_modules/**`・`vendor/`・`target/`・`bin/ obj/`・`.venv/`・生成物・試験ファイルは変異対象から外す（本体の JS で mabimoba の node_modules が標本の 7 割を食った）。

## 言語ごとの道具（候補。担当が決めてよい。契約は「書く物」だけ）

| 言語 | 変異の道具 | killedBy の取り方 | failures の取り方 |
| --- | --- | --- | --- |
| .NET | Stryker.NET（`dotnet stryker --reporter json`、`coverage-analysis perTest`） | json 報告の `killedBy`（schema そのまま） | 報告に失敗文が無い。VsTest の `--logger trx` を Stryker の試験実行へ渡せるか、無理なら Killed の変異だけ `dotnet test --logger trx` で流し直して取る（2 段） |
| Go | go-mutesting（`--exec` で自前の script）か gremlins | 自前 script で `go test -json ./...` を流し、`{"Action":"fail","Test":...}` を集める | 同じ `go test -json` の `output` 行（`--- FAIL` の後の `file.go:12: ...`） |
| Python | mutmut 3（`mutants/` に試験ごとの結果）か cosmic-ray | mutmut の記録、または変異ごとに `pytest --junitxml` | junit の `<failure message>` と traceback |
| Rust | cargo-mutants（`mutants.out/` に変異ごとの log） | 各 log の `test x ... FAILED` | 同じ log の `---- x stdout ----` と `panicked at` |

道具は本体に入れない。初回に `~/.local/share/testgate/prune-tools/<dir>/`（`$TESTGATE_PRUNE_TOOLS` で変更）へ導入する（.NET は `dotnet tool install --tool-path`、Rust は `cargo install --root`、Go は `GOBIN`、Python は venv）。導入の有無と版を `log` に出す。

## 受入（本体へ取り込む条件）

1. `node --test adapters/<dir>/test/*.test.mjs` が通る。fixtures に小さな実物のプロジェクト（製品 1〜2 ファイル・試験 3 本以上。「狙い」と「前提」の両方の失敗が出る物）を入れ、道具がある環境では実物を 1 回流して `mutation.json`・`failures.jsonl` の中身（killedBy が試験ごと、kind が両方出る）を断言する。
2. 記録に出た実リポジトリで 1 回流し、`candidates.txt` が出る: .NET は fox の OpenLogicool（エクシア。記録の 56 回の大半）、Go は fox の OL-RemoteWindow（ジエン。`go test` 1 回。担当はヘンゼル）。Python・Rust は関所の記録にリポジトリが無いので fixtures で足りる。流した時間・変異数・Killed/Timeout/生存・試験数・候補の内訳を README に書く。
3. 一時物を残さない（`/tmp` の自分の物は終了時に消す。本体の試験と同じく前後の件数を見る）。
4. 本体の `npm test`（521 本）が落ちない。

## 優先

1. .NET（fox の記録で `dotnet test` 56 回、OpenLogicool。段階1でも一番大きい）。
2. Go（OL-RemoteWindow 1 回）。
3. Python・Rust（記録に無い。完了条件には入っているので fixtures で動く所まで）。

## 本体側の約束

- `lib/prune/index.mjs` が `--runner` → `adapters/<dir>/prune.mjs` の表（`PRUNE_ADAPTER_RUNNERS`）を持ち、アダプタの戻りと 2 ファイルから候補・合算・`log.jsonl` の 1 行・`candidates*.{json,txt}` を出す（v0.3.13）。
- `failures.jsonl` の `kind` は本体の判定より優先する。
- 本体の集計の変更（広域・同因の束ね・被覆の決め方）はアダプタに影響しない。
