# 現行本体の機能図とデータフロー（v0.3.31）

旧design.mdの段階計画・旧担当表は履歴。現在は段階1を維持、段階2はOwner停止中。設計/版/受入の統括はシラツル、adapter内部は各言語担当、配布はドリリー、BellTeam登録はトロニー。

| 接点 | 入力→出力・所有 | 状態/失敗 |
| --- | --- | --- |
| bin/testgate.mjs hook | harness event→extract/analyze→shellPlan→rewrite/hookOutput→harness | analyze(lib/analyze.mjs)は複合を引用符・$(...)・here-docの外だけで分けて本物のテストだけ段階0に数える。shellPlan(lib/shell.mjs)がOS・harness・toolごとの包み方を決める: 非Windowsはposix複合とposix単一、WindowsはClaudeのBash(Git Bash、CLAUDE_CODE_GIT_BASH_PATH→標準の置き場、無ければ包まない)だけposix複合と単一、PowerShellとCodexはpwshの単一、他は通す。対象外はRTKへ、対応外は素通り。hookはexit2を返さない |
| lib/gate.mjs decide | argv/cwd/env＋Git差分＋lastFullPass→adapter選択結果 | Git失敗はpassthrough。adapter.selectを先に呼び、passthrough（名指し・絞り込み済み・複合）はそのまま返して基準作成に読み替えない。その後、基準無しで変更0件またはnoneの時だけfull（establish）で基準作成。select timeoutの元処理取消までは保証しない |
| lib/adapters.mjs | detect/select公開契約→mode/argv/reason | adapter内部の選択と結果読取は各言語担当。契約はadapter-contract.md |
| lib/run.mjs execCapture | 選択argv＋cwd/env→status/output/duration/timedOut | 子プロセス出力はメモリのみ。意図したfullは時間制限、establish/passthroughは同制限なし。SIGTERM後5秒でSIGKILL |
| bin runGateの結果 | testedState(実行前)→execCapture→testedState(実行後)→adapter.parseOutput/stripCounts→表示＋appendLog | parse失敗は元出力へ。full成功時だけrecordFullPass。run行(phase1)にtestedCommit・treeHash(HEAD＋未commitの指紋、不明はnull)・treeStable(実行前後で同じか、不明はnull)・establish・baselineRecordedを残す。`--cwd`は絶対パスへ直してadapterへ渡す。元のシェル構文はfallbackArgv(非Windowsは/bin/sh、WindowsはGit Bash)で流す |
| lib/log.mjs / lib/git.mjs | 記録行→log.jsonl、root→state.jsonのlastFullPass、cwd→testedState(HEAD、`git diff HEAD --binary`と未追跡ファイルの内容hash。未追跡2000件/64MBを超えるとtreeHashはnull。.gitignoreされた物は含まない)。recordFullPassは書けた時だけtrue | logは無制限append・失敗stderr。stateは最後の成功commitをrootごと上書き。別fileでatomic一体更新ではない |
| 保存/試験 | 通常本体は依存/build生成なし。test/tmp.mjs→worker一時dir | worker exitで自己生成dir回収。SIGKILLの回収保証なし。pruneは停止中、起動しない |

データフロー: harness入力→hook判定→run包み→元shellの実行時cwd→runGate→decide（Git＋state→adapter.select→passthroughならそのまま、基準無しの変更0件/noneだけestablish full）→execCapture→adapter結果読取→表示＋log。full成功→state（passthroughの成功はstateを更新しない。baselineRecordedで、どのrunがstateを書いたか分かる）。run行→外部週次collector（testedCommit・treeHash・treeStable・establish・baselineRecordedをnullable追加フィールドとして出す。schemaVersion 3のまま）→集計側のpairing（同host・同repo・同adapter・同版・同treeHash・両方treeStable=true・S=subset成功→後のF=full の組。n<30は「未評価」とn件を出す）。phase0はRTK中継＋影の判断/log、post補助はreadRecentからidを照合。log→外部週次collector→評価報告。通常実行は作業コピー/backupを作らない。

保存と一時検証のライフサイクル正本は統括席docs/testgate-storage-lifecycle-20261106.md。単純rotate/compactは週次の欠測と並行append喪失を起こし得るため、90日保持案は未実装。ここに図があることを新配備/刈り込み再開許可としない。

pathの優先順はTESTGATE_LOG→XDG_STATE_HOME/testgate/log.jsonl→(HOMEまたはhomedir)/.local/state/testgate/log.jsonl。state.jsonはlogPathの隣。同じHOMEやoverrideを使う複数Bot/processが同じwriter先へ接続し得るため各席専有と見なさない。readRecent(200)→postのid突合せもreaderであり、週次collectorだけの互換性で回収を決めない。不正日付/途中行/未収集/必要証拠は容量だけで捨てない。
