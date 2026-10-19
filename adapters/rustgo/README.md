# testgate アダプタ: Rust（cargo test）・Go（go test）

契約: `/srv/bellteam/bots/bot-47fad91c/docs/testgate-adapter-contract.md`（v0.3 で確認）。外部依存なしの Node ESM。

```
node --test test/*.test.mjs
```

cargo / go が PATH に無い席では、それを要する試験は skip になる（失敗にはならない）。ツールチェーンは `environment/setup.sh` が自分のプロジェクトへ入れる。

- `id = 'rustgo'`、`runners = ['cargo test', 'go test']`。`reason` の先頭にランナー名（`cargo test: ` / `go test: `）が付く。

## 対応する呼び方

| 呼び方 | 動作 |
| --- | --- |
| `cargo test` / `cargo t` / `cargo +nightly test` / `cargo test --workspace [--exclude X]` / `cargo test --release -- --nocapture` | 変更 crate と、それに依存する crate（dev-/build-依存を含む）だけを `-p` で指定する。`--workspace`・`--all` は選択で置き換える。`--` 以降と他のフラグは残す |
| `go test` / `go test ./...` / `go test -v -count=1 ./...` / `go test ./... -args ...` | 変更 package と、それを import する側（テストの import・外部テスト package を含む）だけを import path で指定する。`./...` は選択で置き換える。フラグは残す |
| 前置き | `FOO=bar cargo test`、`env FOO=1 go test`、`rtk cargo test`、`rtk go test`、フルパスの `/path/to/go test` |
| ワークスペース | cargo: `cargo metadata` の workspace_members。go: `go.work` の `use` を全部、無ければ最寄りの `go.mod` |
| 作業場所 | crate・package の中で打った時は、その crate / package が範囲。範囲に影響が届かなければ `none` |

## 動作の決まり

- 変更なし・README 等どの crate/package にも属さない変更だけ → `none`。
- `Cargo.lock`、ワークスペースルートの `Cargo.toml`、`rust-toolchain(.toml)`、`.cargo/`、`go.work(.sum)`、`go.mod`/`go.sum`（そのモジュール全体）、`vendor/` → `full`（元の argv を返す）。
- 影響が実行範囲の全体に及ぶ時 → `full`、元の argv。reason は「単一crate/packageのため選択手段が無い（全部流す）」と「影響が実行範囲の全体に及ぶ（選べたが全部）」を分けて書く。
- `parseOutput` の `errors`: `error: could not compile` と go の `[build failed]`/`[setup failed]` を数え、`failed` にも含める。
- 削除されたファイル: Go は消えた package を import していた側を選ぶ。Rust は crate ごと消えた（`.rs`・`Cargo.toml` が現存しない crate 外）時は依存側を引けないので `full`。
- 依存の解決が壊れた（manifest 不正など）→ `full`。cargo / go が無い・5秒に収まらない → `passthrough`。
- Go の変更ファイルの所属は、package ディレクトリ直下、`testdata/`、`go:embed` の対象。cargo は crate ディレクトリ配下のすべて。
- `go list` は `GOPROXY=off`、`cargo metadata` は `--offline` で呼ぶ（ネットワークに出ない）。

## 対応していない呼び方（passthrough または検出しない）

- 人が範囲を絞った実行: `cargo test -p x` / `--package` / `-pX`、`cargo test <テスト名>`、`--test|--bench|--example|--bin <名前>`。`go test ./core`、`./core/...`、import path 指定、`-run`、`-skip`、`-fuzz`、`.go` ファイル指定、`-C`、`-o`、`-exec`、`-overlay`、`-modfile`。人が絞ったものを関所が書き換えないため（契約）。`--test` 等は `-p` を足すと壊れる事があるため。
- 検出しない（テストを走らせない・別ランナー）: `--help`/`--version`、`cargo test -- --list`、`go test -list`、`go test -c`、`cargo nextest`、`cargo tarpaulin`、`gotestsum`、`cargo make`、`make test`。nextest・gotestsum は出力形式が別で、取りこぼしなく扱う根拠がまだ無い。
- cargo の alias（`.cargo/config` の `[alias]`）と `cargo xtask` は展開しない。
- 複合コマンド（`cd x && cargo test`）は関所が止めるのでここには届かない。

## 既知の限界

- Rust のテストが実行時に `include_str!` 以外の方法で crate 外のファイルを読む場合、その変更は取りこぼす。Go の相対パス読み込みで `testdata/` 外を読む場合も同じ。
- cargo に crate 内のテスト粒度の選択は無いので、単一 crate の repo では変更があれば `full` になる。
- 同名の crate が複数ある時は `name@version` で指定する。
- パス比較は大文字小文字を区別する（Windows で差のみの名前を使う repo は未対応）。Windows 実機では未確認。

## fixtures

- `fixtures/rust-ws/` — workspace（fxcore ← util ← app、独立の indep）。
- `fixtures/go-mod/` — 単一モジュール（core ← util ← app、独立の indep）。
- `fixtures/samples/` — 実出力。`cargo-*`・`go-*` は生、`rtk-*` は rtk 0.51.0 の短縮後。
- 試験は fixtures を一時ディレクトリへ複製して `git init` し、実際に cargo / go を動かす。

## 刈り込み（`prune.mjs`）

`testgate prune --runner go|cargo [--cwd DIR] [--sample N] [--seed S] [--mutate GLOB]... [--tests GLOB]... [--exclude GLOB]... [--jobs N] [--timeout-sec N] [--keep-sandbox]` のアダプタ。契約: `docs/prune-adapter-contract.md`（v0.1）。`--runner` 無しは `detect(cwd)`（`go.mod`／`go.work`／`Cargo.toml`）。外部依存なしの Node ESM。試験は `node --test adapters/rustgo/test/prune.test.mjs`（go・cargo が無い席では実物の一巡だけ skip）。

### 変異の道具

go-mutesting・cargo-mutants は使わず、`prune.mjs` の中の字句ベースの変異エンジンで作る。導入が要らない（`go` と `cargo` だけ）、Windows（fox）でそのまま動く、位置・置換後の全文・標本の seed を自分で持てる、試験ごとの結果を取りこぼさない、が理由。

| mutatorName | 変異 |
| --- | --- |
| ArithmeticOperator | `+`⇔`-`、`*`⇔`/`、`%`→`*`（2 項の時だけ。文字列の連結・単項・型の `*` は除く） |
| EqualityOperator | `==`⇔`!=`、`<`⇔`<=`、`>`⇔`>=` |
| LogicalOperator | `&&`⇔`\|\|` |
| AssignmentOperator | `+=`⇔`-=`、`*=`⇔`/=` |
| UpdateOperator | Go の `++`⇔`--` |
| UnaryOperator | 単項の `!` を外す（Rust のマクロの `!` は除く） |
| BooleanLiteral | `true`⇔`false` |
| IntegerLiteral | 10 進の整数 n → n+1（Rust は `u8` 等の接尾辞を保つ。浮動小数・16 進・`x.0` の添字は除く） |

- 関数本体の置換・文の削除・戻り値の差し替えは無い（cargo-mutants や go-mutesting より粗い）。広げる時は `goMutants`／`rustScan` に足す。
- 字句ベースなので型と式の見分けが外れる事がある（Go の `*`、Rust の総称 `<`）。その変異は build で落ち `CompileError` になり、候補の集計から外れる。`CompileError` が 3 割を超えたら `candidates.txt` の注記に出る。
- 対象: Go は `go list` が今の OS で build に入れる `.go`（`*_test.go`・`vendor/`・`testdata/`・`Code generated … DO NOT EDIT.`・`*.pb.go` を除く）。Rust は各 package の `src/` の `.rs`（`#[cfg(test)]` の項目・`#[test]` の関数・`#[cfg(test)] mod x;` の `x.rs`・`macro_rules!`・属性の中、`tests/`・`benches/`・`examples/` を除く）。`--mutate` は cwd からの glob（試験・生成物は引き続き除く）。
- 標本: 全変異を file・位置の順に並べ、`seed` の乱数（mulberry32）で `sample` 件を選ぶ。同じ seed・同じ commit なら同じ標本。`sampled = { total: 全変異, sampled: 流した数, positions: 位置の数 }`。

### 流し方と記録

- **共通**: 作業の写し（`os.tmpdir()/tg-prune-rustgo-*`。`.git`・`node_modules`・Rust は `target/` を除く）を作り、変異 1 件ずつ該当ファイルを書き換えて全試験を流し、必ず元へ書き戻す。写しは終わりに消す（`--keep-sandbox` で残す）。先に変異なしで 1 回流し（下見）、試験の一覧を取る。下見で落ちる試験は全変異から外し `dryRunExcluded` に書く。下見の build が通らなければ status 2 で終わる。
- **Go**: `go test -json -vet=off -timeout=… ./...`（`go.work` だけの根は `use` ごと）。`-count` は付けず Go の試験キャッシュを使う（変異の影響が届かない package は再実行されない）。試験の id は `import path.TestName/Sub`。subtest があれば leaf を試験とし、子の失敗の要約だけの親は数えない。**panic すると package の残りの試験が走らない**ので、panic した試験を `-skip` してその package を流し直し（最大 6 回）、落ちた試験を全部集める。別の goroutine の panic で test binary ごと落ち、`run` のまま残った試験は、自分の出力に panic が有れば落ちた試験として数える。build の失敗は `CompileError`、`panic: test timed out` は `Timeout`。
- **Rust**: `cargo test --workspace --tests --no-fail-fast`（doc テストは流さない）。出力は標準出力と標準エラーを同じファイルへ書いて順序を保つ。試験の id は `target::module::path::test_name`（lib の単体試験は crate 名、`tests/api.rs` は `api`。同じ target 名で header が複数なら `target[header]`）。試験関数の場所は `#[test]`（`tokio::test`・`rstest` 等を含む）を字句で拾って対応づける。
- **時間**: 変異 1 件の上限は `min(--timeout-sec, 下見の 4 倍 + 10 秒)`。下見の 2 倍 + 10 秒が `--timeout-sec` を超える時は延ばし、`notes` に書く（そうしないと全変異が `Timeout`）。超えたら子の木ごと止めて `Timeout`（`killedBy` は空）。`--test-timeout-sec` は使わない（go test・cargo test に試験 1 本の上限が無い）。
- **並列**: `--jobs`。未指定は Go が `min(4, CPU/2)`、Rust は 1（Rust は作業の写しごとに `target/` が要るため）。2 つ目以降の写しは下見の後に複製する。
- **status**: Killed、Survived、Timeout、CompileError、RuntimeError（試験が落ちたのではなく、道具が非 0 で終わった。TestMain の `os.Exit` 等）。NoCoverage は出さない。`--exclude` した試験だけが落ちた変異は Survived。
- **mutation.json**: `location` はその変異がある**行全体**（1 始まり、列は先頭の空白の次から行末まで）、`replacement` は変異を適用した**その行の全文**（短縮しない）。変異の `id` は標本の順の連番。`description` に `` `+` → `-` `` のような要約。`testFiles` は下見で通った試験の id・名前・場所（ファイルが分からなければ `""`）。
- **failures.jsonl**: 変異ごと・落ちた試験ごとに 1 行。`error` は試験の出力のうち失敗文（見出し・要約の行を除く）の全文、4000 字まで。作業の写しの絶対 path は消す。
- **project.json**: cwd・走者・道具の版・使った command・標本・除外・上限・下見の時間・status の件数。**prune.log**: 下見の出力と、変異ごとの 1 行（`CompileError`・`RuntimeError`・`Timeout` は出力の先頭 3000 字付き）。

### kind（狙い／前提）の判定

- **Go**: 出力に `panic:`・`fatal error:`・`goroutine N [` があれば前提。無くて `*_test.go:行:` の失敗文（`t.Error*`・`t.Fatal*`）か testify の `Error Trace: …_test.go:行` があれば狙い。それ以外（製品側の行・記録なし）は前提。
- **Rust**: panic の位置が試験コード（`tests/`、`#[cfg(test)]` の項目、`#[test]` の関数）で、本文が `assertion …` なら狙い。試験コードでも `unwrap`/`expect`（`called Option::unwrap() on a None value` 等）・`index out of bounds`・`attempt to …` は前提。製品コードの panic・位置が読めない物は前提。新旧の panic 書式（`panicked at path:l:c:\nmsg` と `panicked at 'msg', path:l:c`）を読む。
- 同じ変異で 3 本以上が同じ失敗文で落ちた物を前提に落とすのは本体（アダプタはやらない）。

### 限界

- Go の `t.Fatal` が setup の失敗（`err != nil` で `t.Fatalf("open: %v", err)`）を知らせる場合も、字句からは狙いと見分けがつかず「狙い」になる。同じ変異で 3 本以上が落ちれば本体が前提に落とす。
- Go のログ（`log.Printf` 等）は、並列に走る別の試験の出力に混ざって帰属する事がある。
- Rust は `--workspace` を使うので、cwd が workspace の member でも workspace 全体の試験が流れる。cwd の外の crate のソースは変異しない。写しは workspace の根ごと作る。
- Rust の試験ファイルの対応は字句での近似（`#[path]`・マクロが作る試験は拾えず、その試験は場所が `""`）。doc テストは流さない。
- go.work の複数 module は `use` ごとに `go test ./dir/...` を並べるだけで、module をまたぐ依存の `replace` は写しに含めない（cwd の外を指す `replace ../x` は動かない）。
- Windows 実機は未確認（`taskkill`・`\` 区切りの path を読む作りにはしてある）。fox では OL-RemoteWindow で確かめる。

### 実測（OL-RemoteWindow `transport/`、Go、Linux、go 1.27.2、commit 90f7efd）

`testgate prune --runner go --cwd transport`（既定の sample 200、jobs 4）。

| seed | 流した時間 | 変異 | Killed | Timeout | Survived | CompileError | RuntimeError | 試験 | 候補 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 自動 | 2 分 14 秒 | 578 件から 200 件 | 133 | 3 | 54 | 4 | 6（panic で落ちた物。今は Killed として拾う） | 30 本 | 17（冗長 7、前提のみ 10） |
| `ol1` | 2 分 24 秒 | 578 件から 200 件 | 120 | 8 | 62 | 10 | 0 | 30 本 | 17（冗長 7、前提のみ 10） |

下見 1.7 秒、変異 1 件の上限 17 秒。

## fixtures（刈り込み）

- `fixtures/prune-go/` — module `example.com/prunefix`。製品 3 ファイル（`calc.go`・`stats.go`・`run.go`）、試験 `TestAdd`・`TestAddAgain`（同じ変異を殺す）・`TestClamp`（subtest）・`TestMean`・`TestMeanEmpty`（空判定が壊れると 0 除算の panic）・`TestIsPositive`・`TestFirstSetup`・`TestCounter`・`TestRun`（goroutine の panic でプロセスごと落ちる）。狙いと前提の両方が出る。
- `fixtures/prune-rust/` — crate `prunefix`。`src/lib.rs`（`#[cfg(test)] mod tests`）と `tests/api.rs`。`if !xs.is_empty()` の `!` を外すと統合試験の `unwrap` が panic する（前提）。
