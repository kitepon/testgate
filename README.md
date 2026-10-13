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
