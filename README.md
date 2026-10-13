# testgate — テストの関所

AIハーネス（Claude Code・Codex・Cursor・Grok）のコマンド実行フックに入り、テスト実行を記録し、段階1以降は変更に関わる分だけに絞る。設計は`docs/design.md`、アダプタの契約は `docs/adapter-contract.md`。

## 段階0（今）

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
