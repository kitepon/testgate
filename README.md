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
