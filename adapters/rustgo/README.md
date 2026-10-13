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
