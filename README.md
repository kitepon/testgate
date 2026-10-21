# testgate — テストの関所

AIハーネス（Claude Code・Codex・Cursor・Grok）のコマンド実行フックに入り、テスト実行を記録し、段階1以降は変更に関わる分だけに絞る。設計は`docs/design.md`、アダプタの契約は `docs/adapter-contract.md`。

## 段階1（v0.2.0 から既定）

`testgate hook <harness>` は、アダプタが扱えるテストコマンド（複合でない、`time`/`timeout` の包みが無い）を `node <入口> run --cwd <cwd> -- <元のコマンド>` に包み直して返す。席はその包んだコマンドを実行し、関所（`run`）がアダプタで変更に関わる分だけに絞って流し、合計行を落とし、長い出力を刈って返す。包んだ分は RTK の書き換えを通らない（関所の出力はもう短い）。

- 包めない時（テストでない、複合、アダプタが無い、Windows の PowerShell 以外のハーネス）は段階0と同じ: 記録して `rtk hook <harness>` へ中継する。
- `TESTGATE_PHASE=0` で段階0（記録だけ）へ戻せる。`current` を v0.1.11 へ付け替えても戻る。
- 子プロセスの起動は shell を通さない。Windows では実行ファイルを `PATH`・`PATHEXT` で探し、`.exe` は直接起こす。`.cmd`/`.bat`（npm・npx など）だけ `cmd.exe /d /s /c` に引数を引用して渡す（`--filter` の `|` や空白を含む道が壊れない）。
- 前置きの環境変数（`TESTGATE_FULL=1 npm test`）は包んだ後も先頭に残るので効く。PowerShell は `& 'node' ...` の形で包む（Claude の tool_name=PowerShell の時だけ）。
- 全部通った記録が無く、変更も無い（commit 直後など）時、または変更が未追跡の資料などコードでない物だけでアダプタが「関わるテストが無い」と言う時は、一度全部流して「最後に全部通った commit」の基準を作る。失敗したら基準は作らず、通るまで同じ条件で全部流す。この全部流しには時間上限を掛けない。上限（`TESTGATE_FULL_LIMIT_SEC`、既定 180 秒）が付くのは `TESTGATE_FULL=1` とアダプタが選んだ full だけ。アダプタが判断できなかった passthrough にも掛けない。
- `run` 側の select の待ち時間は `TESTGATE_SELECT_TIMEOUT_MS`（既定 30 秒。段階0の影の判断は 5 秒）。
- 記録: hook が `phase:1, event:'rewrite'`（元のコマンドと包んだコマンド）、`run` が `phase:1, event:'run'`（mode、理由、所要 ms、件数、終了コード）を1行ずつ。

## 段階2（v0.3.0 から）: 刈り込みの候補 `testgate prune`

ミューテーションテスト（Stryker）で「消してよい試験の候補」を出す。消すのは担当。候補には「殺す変異」と「同じ変異を殺す残す試験の名前」を付ける。

```
testgate prune [--cwd DIR] [--sample N] [--seed S] [--out FILE] [--tests GLOB]... [--exclude GLOB]... [--mutate GLOB]... [--jobs N] [--no-preflight] [--runner node-test|jest|vitest|dotnet|pytest|cargo|go]
testgate prune --merge-only NAME [--cwd DIR]   # Stryker を流さず、記録を合算し直す（v0.3.19）
```

- 対象は JavaScript / TypeScript（node --test は専用の走者で試験1本単位、Jest・Vitest は Stryker 標準の走者。Jest・Vitest は未検証）。Python・Rust・Go・.NET は刈り込みアダプタ（v0.3.13 から差し込み口。docs/prune-adapter-contract.md。`adapters/<dir>/prune.mjs` が mutation.json と failures.jsonl を書き、本体が候補・合算・記録を出す。実装は各言語の担当）。swift・gradle は対象外。
- `package.json` の `test` script から、node の引数（`--import` など）・試験ファイル・build の要否を読む。`npm run X` は scripts の X へ展開し（3段まで）、`tsx --test` は node --test に `--import tsx` を付けた物として読む。vitest と node --test が混ざる script は node --test の段を使う。ファイル指定無しの `node --test` は流さない。package.json や test script が無い時は `--runner node-test --tests GLOB` で指定する（v0.3.4 から）。tsconfig と `build` script があれば src の `.ts` を変異して build し、無ければ `src` `lib` `bin` の `.js/.mjs/.cjs` を変異する。試験が `--experimental-strip-types` で src の `.ts` を直接読む形（yui）は build せず、src の `.ts` を変異して注入する（v0.3.5 から）。
- `--sample N`（既定 200、0 で全部）: 変異を seed 付きの乱択で N 件に絞る。1変異ごとに全試験を流すので、時間は「試験1回の時間 × N」。
- 候補の決め方: 「自分しか殺さない変異」を持つ試験は必ず残し、残りは未検出の変異を一番多く殺す順に残す（貪欲な最小被覆）。残らない試験が「冗長」、変異を1つも殺さなかった試験が「検出0」。skip の試験は出さない。検出0 は標本に入らなかった所を守っている事があるので、冗長より弱い根拠。
- 道具（Stryker 一式 約120MB）は本体に入れず、初回に `~/.local/share/testgate/prune-tools/`（`$TESTGATE_PRUNE_TOOLS` か `$XDG_DATA_HOME` で変更）へ npm で導入する。記録は `~/.local/state/testgate/prune/<名前>/<日時>/`（candidates.txt / candidates.json / mutation.json / stryker.log）。`log.jsonl` にも `event: "prune"` を1行残す。
- 下見（v0.3.3 から）: Stryker は初回の試験が1本でも落ちると止まるので、先に sandbox と同じ形の写し（.git 無し、node_modules は link）で試験を一度流し、落ちた試験ファイルを除外に足してから流す（`.git` や外の状態を読む試験が機械的に外れる。Aiterm と Throughline の product-ci-plan.test など）。除外した物は stderr と candidates.json の `preflightExcluded` に出る。`--no-preflight` で飛ばせる。試験ファイル自体が読み込みで落ちた時（import 失敗・構文エラー・トップレベルの例外）は、走者がそのファイル 1 本の失敗（`<file> > (file)`、本文はそのファイルの stderr の例外）として報告するので、下見はそのファイルを除外に足せ、Stryker の初回試験の記録（stryker.log）にもファイル名が残る（v0.3.10 から）。 写しは cwd から上へ辿って `node_modules` の有る各階層を同じ相対位置に link するので、npm workspaces の package（`node_modules` は根に hoist）を `--cwd` にしても依存が解決できる（v0.3.10 から。Stryker の sandbox は cwd の下にできるので元から親へ辿れる）。 下見は計装の無い写しで流すので、製品ソースを文字列として読んで断言する試験（`node:fs` を import していない事を正規表現で見る等）は Stryker の計装（instrument と `.active-mutant` の注入ヘッダ）で初めて落ち、Stryker の初回試験で止まる。その時は初回試験で落ちた試験ファイルを除外に足して Stryker を一度だけ流し直す（v0.3.11 から。2 回目も落ちたら失敗で止まる）。除外した物は stderr と candidates.json の `dryRunExcluded`、candidates.txt の冒頭の注記に出る。
- 候補の読み方（v0.3.2 から、エレグの注文）: 「冗長」「残す」はこの標本での検出の重なり・被覆集合の事で、入力条件・分岐・断言まで代替できるかは担当が決める。そのために候補の変異ごとに、変異ID・file:始-終の位置・演算子・完全な replacement（短縮 label は識別子にしない）と、その試験が落ちた断言／例外の1行目（走者が `failures.jsonl` に残す）を添える。試験の大半（max(10, 20%) 本より多く）が同時に落ちる変異は「広域」（共通の起動処理の失敗）として冗長の根拠にせず、それしか検出しない試験は「広域のみ」と出す。記録の candidates.json には commit・platform・標本の位置・除外した試験ファイル・変異したファイル一覧も入れる。生存した変異は未到達の OS 分岐や等価変異を含み得るので「試験の穴」と確定しない。 v0.3.10 からは殺し（変異を試験が落とした事）を「狙い」と「前提」に分ける: 失敗が AssertionError で stack の最初の frame がその試験ファイルなら狙い、TypeError 等の例外・最初の frame が製品コードや helper の断言・同じ変異で 3 本以上が同じ形（失敗文から数値・path・引用を消した物）で落ちた断言・記録の無い物（不明）は前提。「冗長」「残す」は狙いの殺しだけで決め、殺しが全部前提の試験は「前提のみ」（検出0 と同じ弱さ。採否は求めない）として別に数える。Timeout の変異は killedBy が無いので「Killed N・Timeout N」と分けて数え、被覆の計算に入れずに末尾へ一覧する。候補の各変異には変異位置を囲む関数名と変異行の元コード（候補集計時の cwd から読む）、生存の一覧には「同じファイルの同じ関数で殺された変異が有るか」を添える（有: 未検証の可能性、無: 試験が届いていない可能性。確定ではない）。
- 合算（v0.3.1 から）: 同じ名前の過去の記録（`~/.local/state/testgate/prune/<名前>/*/mutation.json`）が2回分以上あれば、試験は id、変異は元コードの hash・始終の位置・演算子・完全な replacement で束ねて killedBy を和集合にし、合算後の候補を `candidates-merged.txt / .json` にも書く。1回の標本では「検出0」が標本に入らなかった所を守る試験で膨らむので、月次で seed を変えて積み上げ、合算の候補を担当へ出す。v0.3.19 から: Stryker の番号の試験 id は回ごとに振り直されるので、回ごとに名前（`file > name`）へ置き換えてから束ねる（それまでは試験が増えると殺しが別の試験に付いた）。変異の元コードと関数名はその回の source から出す。Killed があるのに failures.jsonl の無い回は、殺しが全部「不明」になり独占が隠れるので合算から外し、`skipped` と候補の注記に出す。`--merge-only NAME` は合算だけをやり直し、いちばん新しい回のフォルダへ書く。
- 変異は環境変数で届くが、試験が子プロセスへ自前の env を渡す時は届かない。そこで sandbox の製品コードの先頭に「env が無ければリポジトリ直下の `.active-mutant` を読む」ヘッダを注入し、試験の起動時にその file へ変異番号を書く。この file は走者1つで使うので、Stryker の並列は 1、並列は試験ファイル単位（`--jobs`、既定は node --test の既定）で取る。
- 試験が終わっても子プロセス（hook など）が居残って node --test が終わらない事がある。走者は初回に分かった試験が全部報告されたら1秒待って process group を止め、結果を返す。

## 段階0（v0.1.x、`TESTGATE_PHASE=0`）

`testgate hook <harness>` は、stdin の hook 入力をそのまま `rtk hook <harness>` へ渡し、出力と終了コードを中継する。違いは、テスト実行だったら `~/.local/share/testgate/log.jsonl` に一行記録すること。RTK が無ければ何も書き換えずに通す。

```
echo '{"tool_name":"Bash","tool_input":{"command":"pytest -q"}}' | node bin/testgate.mjs hook claude
node bin/testgate.mjs inspect "cd app && npm test"
```

記録の列: ts, host, bot, harness, tool, id（道具呼び出しの id）, session（会話の id）, transcript（会話記録の path。Claude のみ）, cwd, runner, lang, compound, command（前置きの環境変数の値は `***` に消す）, phase, shadow（影の判断）。置き場は `~/.local/state/testgate/log.jsonl`（`TESTGATE_LOG` か `XDG_STATE_HOME` で変更可）。

所要秒と成否は段階0では hook を足さず、会話記録（Claude の transcript、Codex の rollout）を id で突き合わせて後から出す（トロニーの判断、2026-10-13）。`testgate post` は実装してあるが、段階0では登録しない。

## 試験

```
npm test
```

## 置き方（配布）

- 版ごとのフォルダに置き、`current` の付け替えで切り替える。差し替え中の半端な状態を動いている席が踏まないため。
  - BellTeam コンテナ: `/srv/bellteam/shared/tools/testgate/<tag>/` と `/srv/bellteam/shared/tools/testgate/current` → 登録するコマンドは `node /srv/bellteam/shared/tools/testgate/current/bin/testgate.mjs hook <harness>`
  - 端末（rabbit・Mac・fox）: `~/.local/lib/testgate/<tag>/` と `current`（Windows は `%USERPROFILE%\.local\lib\testgate\`）。ドリリーの RTK 配布手順に同乗。
- 依存なしなので `npm install` も setup.sh も要らない。`git clone --branch <tag> --depth 1` か tarball の展開だけ。
- 戻し方: `current` を前の版へ付け替える。登録の文字列は変えなくてよい。

## RTK と並べる時の注意

- Claude の設定から `rtk hook claude` の文字列が消えると、RTK が1日1回「No hook installed — run `rtk init -g`」と出す。`RTK_SUPPRESS_HOOK_WARNING=1` で止まる（コンテナはトロニーが入れる。端末はドリリーの配布に含める）。
- 関所の項目だけがある所へ `rtk init -g --hook-only --auto-patch` を流すと、`rtk hook claude` が2つ目の項目として足され、二重に書き換えが走る。関所ごしの登録では `rtk init` を呼ばない。
- Grok だけ、空の入力・JSON でない入力・極端に長いコマンドの3通りで終了コードが BellTeam の grok-hook.mjs（1）と関所（0）で違う。どちらも元のコマンドは通るので直さない。

## 異常系の約束（受入条件）

- 正常系: stdout と終了コードは `rtk hook <harness>` と完全に同じ。deny/ask の JSON もそのまま中継する（トロニーの確認: 4 CLI × 26 通りで stdout 一致、2026-10-13）。
- hook として呼ばれた時（`testgate hook …`）は、知らない名前や内部の失敗でも exit 2 を返さない。1 か 0 で、元のコマンドを通す。
- rtk が無い（ENOENT）: 何も書き換えず exit 0。stderr に一行。
- rtk hook の timeout やその他の spawn エラー: 何も書き換えず exit 1。stderr に理由。**exit 2 は使わない**（Claude では 2 がブロックになる）。
- 入力先頭の BOM は除去して判定する。
- ログの書き込みに失敗しても hook は通す（stderr に出すだけ）。

## 影の判断（段階0）

`adapters/<id>/adapter.mjs` が置いてあれば、段階0でも「段階1ならどう選んだか」を記録に残す（`shadow` 欄: adapter, mode, reason, argv, changedCount, base）。コマンドは変えない。

## 段階1の入口

- `testgate run [--cwd DIR] -- <command...>`: アダプタで選んだコマンドを関所が実行し、生出力から件数を読み、合計行を落として返す。全部流しは `TESTGATE_FULL=1` の時だけで、`TESTGATE_FULL_LIMIT_SEC`（既定 180）を超えると止める。通った全部流しは「最後に全部通った commit」として記録し、次回の差分の基準になる。
- `testgate decide "<command>"`: 実行せずに判断だけ表示する（開発用）。
- `testgate post <harness>`: 実行後の hook。同じ tool_use_id の事前記録と突き合わせて所要秒と大まかな件数を足す。
