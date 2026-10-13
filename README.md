# testgate — テストの関所

AIハーネス（Claude Code・Codex・Cursor・Grok）のコマンド実行フックに入り、テスト実行を記録し、段階1以降は変更に関わる分だけに絞る。設計は`docs/design.md`、アダプタの契約は `docs/adapter-contract.md`。

## 段階0（今）

`testgate hook <harness>` は、stdin の hook 入力をそのまま `rtk hook <harness>` へ渡し、出力と終了コードを中継する。違いは、テスト実行だったら `~/.local/share/testgate/log.jsonl` に一行記録すること。RTK が無ければ何も書き換えずに通す。

```
echo '{"tool_name":"Bash","tool_input":{"command":"pytest -q"}}' | node bin/testgate.mjs hook claude
node bin/testgate.mjs inspect "cd app && npm test"
```

記録の列: ts, host, bot, harness, tool, cwd, runner, lang, compound, command, phase。

## 試験

```
npm test
```

## 異常系の約束（受入条件）

- 正常系: stdout と終了コードは `rtk hook <harness>` と完全に同じ。deny/ask の JSON もそのまま中継する。
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
