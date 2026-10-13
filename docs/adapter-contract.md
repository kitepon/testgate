# testgate アダプタ契約（v0.4、2026-10-13）

改版履歴: v0.4 — parseOutput に任意の errors 欄を追加（収集・ビルドの失敗。failed にも数える）。full で選択機能を止めるオプションを足す形（例: --testmon-noselect）を明記（マナの実装から）。v0.3 — 関所がアダプタへ渡す物の約束（単純コマンドのみ、glob は展開前、base が null の時の changed の意味）、パッケージスクリプト経由の呼び出しの扱い、名指し実行と全体に効くファイルの扱いを追加（エーテルの質問から）。v0.2 — mode の意味を明確化、人が範囲を絞った時の passthrough、複数ランナーを一つのモジュールで扱う形、初回など「全部流れる subset」の扱いを追加（ジエン・マナの質問から）。

関所本体（マクスウェル所有）と言語アダプタ（マナ・エーテル・ジエン・シュエン所有）の境目。アダプタはこの契約だけを満たせばよく、ハーネスのhook形式やRTKとの受け渡しは知らなくてよい。設計の全体は `docs/testgate-design.md`。

## 形

- Node.js の ESM モジュール（`.mjs`）。**外部依存なし**。コンテナのNodeと、fox・rabbit・Mac・Windowsの各席のNodeで動くこと。
- 置き場: 各担当の自分のプロジェクト `work/testgate-adapter-<lang>/`。中身は `adapter.mjs`、`test/*.test.mjs`、`fixtures/`、`README.md`。関所本体が取り込む時はディレクトリごと `adapters/<lang>/` へ移す。
- 試験は `node --test test/*.test.mjs` で通ること。npm の依存を増やさない。

## エクスポート

```js
export const id = 'pytest'            // アダプタ名。小文字英字
export const runners = ['pytest']     // 判定対象のランナー名（人が読むため）

// 1. 判定。argv はシェル語に分けたコマンド（例: ['python','-m','pytest','tests/']）。
//    env は PATH などの環境。true を返した argv だけが select に渡る。
export function detect(argv, { cwd, env }) → boolean

// 2. 選択。変更に関わるテストだけを流す argv を返す。
//    changed: リポジトリ相対の変更ファイル一覧（未commitも含む。関所が git で出す）
//    base:    最後に全部通った commit。無ければ null
//    full:    true なら選ばずに元の argv を返す（関所が TESTGATE_FULL=1 を見て決める）
//    返り値 argv: 実際に流すコマンド。mode が何であっても、関所はこの argv を実行する（full でも --testmon を足すなど、元と違ってよい）
//    返り値 mode: 期待される範囲を表す。関所はこれを記録に残し、段階0の数字に使う
//      'subset'      変更に関わる分だけ流れる見込み
//      'full'        実質全部流れる（選択の仕組みが無い、初回で依存の表が無い、lockfile や workspace ルートの変更など）
//      'none'        流す物が無い。argv は無視される
//      'passthrough' 判断しない。元の argv のまま。人が既に範囲を絞っている時、道具が無い時、5秒で解決できない時
//    reason:  人が読む一行。関所が記録に残す
export async function select({ argv, cwd, env, changed, base, full }) → { argv, mode, reason }

// 3. 結果の読み取り。ランナーの標準出力+標準エラーの全文を受け取る。
//    数が取れない時は undefined。failures はテスト名か場所の一覧（上限 50）
//    errors は収集・ビルド・セットアップの失敗の数（テストそのものの失敗ではない物）。errors は failed にも数える（failed は「落ちた物の合計」）
export function parseOutput(text) → { passed?, failed?, skipped?, errors?, durationMs?, failures? }

// 4. 件数行の除去。「N passed」のような合計行を落とし、失敗の詳細と例外は残す。
export function stripCounts(text) → string
```

## 関所がアダプタへ渡す物の約束

- `argv` は**単純コマンド一つ**。`&&`、`||`、`;`、`|`、リダイレクトを含む複合コマンドは、関所が記録だけして `select` を呼ばない（元のまま流す）。アダプタは複合コマンドを考えなくてよい。
- glob は**展開前の文字列**で届く（例: `['node','--test','test/*.test.mjs']`）。展開はアダプタが行う。
- `changed` はリポジトリ相対パスの一覧。`base` がある時は `base` との差分（未commit・未追跡を含む）。`base` が null の時は HEAD との差分と未追跡ファイル。削除されたファイルも含む（アダプタは「消える前の経路」を参照していたテストを選ぶ）。
- `cwd` はコマンドを打った場所。リポジトリのルートとは限らない。

## 守ること

- **パッケージスクリプト経由の呼び出し**（`npm test`、`npm run test`、`npm t`、`pnpm test`、`yarn test` など）は、そのスクリプトが呼ぶランナーのアダプタが拾う。`package.json` の `scripts.test` が一つのランナーを単純に呼んでいる時だけ `select` する。スクリプトに `&&` やパイプが混ざる時、`pretest`/`posttest` がある時は `passthrough`。
- **名指し実行は passthrough。** glob もディレクトリも含まない、ファイルを名指しした実行（`node --test test/a.test.mjs`、`pytest tests/test_a.py`）は、もう絞ってある実行として触らない。glob・ディレクトリ・引数なしが選択の対象。
- **全体に効くファイル**（`package.json`、ロックファイル、ランナーの設定ファイル、`Cargo.lock`、`go.work`、`conftest.py` など）が `changed` にあれば `full`。既製の選択機能がその変更を追跡しない時は、選択を止めるオプションを足した argv を返してよい（例: pytest-testmon の `--testmon-noselect`。依存の表は更新しつつ全部流す）。変更ファイルの import 解決に失敗した時も `full`（取りこぼしより流し過ぎを選ぶ）。
- `changed` が空でないのに関わるテストが一つも無い時（docs だけなど）は `none`。

- **人が範囲を絞っている時は触らない。** argv に明示のテスト指定（ファイルやディレクトリのパス、`-k`、`-p`/`--package`、`-run`、`-only-testing` など）が既にあれば `passthrough`。ただし「全部」を意味する指定（`--workspace`、`./...`）は選択で置き換えてよい。
- 一つのモジュールで複数ランナーを扱ってよい（例: `id = 'rustgo'`, `runners = ['cargo test', 'go test']`）。`id` は小文字英字のみ。`reason` の先頭にどのランナーかを書く。
- `detect` は、テストを走らせない呼び方（`--version`、`-h`/`--help`、`--collect-only`、`--list` など）に false を返す。

- `select` はテストを**実行しない**。argv を組み立てるだけ。実行は関所がする。
- `select` が外部コマンドを呼ぶのは依存の解決に必要な時だけ（例: `go list`、`cargo metadata`）。5秒以内に返す。超えそうなら `passthrough` を返す。
- 変更が無い（`changed` が空）時は `none`。前回の失敗が残っていても変えない（不安定なテストを再実行で通す癖を止めるため。本当に再現したい時は人が `TESTGATE_FULL=1` を付ける）。
- 選択の仕組みが無い言語（swift、xcodebuild、gradle）は常に `full` を返し、`reason` にそう書く。時間上限は関所側が掛ける。
- 既製の選択機能（pytest-testmon、Jest `--changedSince`、Vitest `--changed`）があるならそれを使う。自作は既製が無い所だけ（node --test の import 逆引きなど）。
- 既製品の導入が要る場合（testmon など）、無い環境では `passthrough` を返し、`reason` に導入方法を書く。勝手に `pip install` しない。代替の自作選択（名前一致など取りこぼしが出る物）は入れない。
- 導入済みかの判定に、そのランナーの `--help` を同じ実行環境で呼ぶのは許す（5秒以内、テストは走らせない）。
- 出力は `rtk test` の後ろに付くこともある。`parseOutput` と `stripCounts` は生の出力と rtk 短縮後の両方で動くこと（fixtures に両方を置く）。

## 受入条件（全アダプタ共通）

1. `fixtures/` に小さな実リポジトリ（ソース2〜3ファイル、テスト3つ以上、うち1つは他と独立）を置く。
2. 試験で次を示す。
   - 1ファイル変更 → `subset` で、関わるテストを含み、独立したテストを含まない。
   - 変更なし → `none`。
   - `full: true` → 元の argv がそのまま返る。
   - ランナーでないコマンド（`ls`、`pytest --version` など） → `detect` が false。
   - 実出力のサンプル2種以上（成功・失敗）で `parseOutput` が正しい件数を返す。
   - `stripCounts` の出力に合計行が無く、失敗の詳細が残っている。
3. README に、対応するランナーの呼び方（`npx jest`、`./gradlew test` など）と、対応していない呼び方を列挙する。
4. マクスウェルへの完了報告に**テストの件数を書かない**。書くのは、置き場、対応した呼び方、対応しなかった物とその理由、未解決の問題。

## 報告

- 完了と質問は `sendmessage` でマクスウェルへ。
- 契約を変えたくなった時は変えずに提案を送る。契約の改版はマクスウェルが行い、全アダプタへ知らせる。
