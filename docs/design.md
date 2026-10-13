# テストの関所（testgate）設計書

2026-10-13 起草。発端はクオの相談「どの席もプロダクトも、開発が進むごとに大量のテストをするようになって無駄に時間がかかる。何百件のテストを終えたと自慢げに報告してくる。CIもだ」。

## 1. 問題

- Botは小さな変更のたびにテストを全部流す。待つのが苦ではなく、全部流すのが一番安全に見えるから。
- 報告に「N件通過」を書く。件数は費用であって成果ではない。
- 言葉で規範を課しても半分しか守れない。作業中に規範は忘れられ、楽で安全な「全部流す」へ戻る。
- だから仕組みで縛る。テストを直接叩けないようにして、共通の入口が「関わる分だけ」を選ぶ。

## 2. 世の中の定番（調査 2026-10-13）

| 系統 | 代表 | うちでの使い方 |
| --- | --- | --- |
| 回帰テスト選択（RTS） | Ekstazi（ISSTA 2015）、STARTS（FSE 2016）、pytest-testmon、Jest `--changedSince`、Vitest `--changed`、Nx/Turborepo affected、Bazel | 主軸。言語ごとの既製品を関所から呼ぶ |
| 予測型選択 | Facebook（ICSE 2019、費用半減・不具合の99.9%を捕捉）、Develocity PTS、Launchable | 学習に2週間と大量の履歴が要る。うちの規模では過剰。採らない |
| テストの刈り込み | ミューテーションテスト（PIT、Stryker、mutmut）で検出力を保ちつつ7割の大きさへ（Jehan & Wotawa 2023） | 月1回、マクスウェルが人手で刈る時の判定に使う |
| 価値の測り方 | Facebook/Googleは件数でなく「見逃した不具合の率」と「費用」で測る | 報告の件数を禁じ、関所の記録で費用を測る |

## 3. 現状の構造（読んだ範囲）

- 全席のBash（Claude）/ Shell（Cursor）/ run_terminal_command（Grok）/ Bash（Codex）には、すでに **RTK** の PreToolUse hook が入っている。`rtk hook <harness>` が `rtk rewrite` でコマンドを書き換える（`pytest`→`rtk pytest` など）。
- RTKの登録はBellTeamの `src/rtk-hooks.mjs`（トロニー所有）が起動時に行う。仕様はドリリーの `docs/rtk-bellteam-registration.md`。
- RTKは3OS（Linux・macOS・Windows）×4ハーネスへドリリーが配る。**全席・全マシンへ届く唯一の層**。関所はこの層に乗せる。
- Claude Codeの複数PreToolUse hookは並列に走り、`updatedInput` が複数返った時の合成は仕様に無い。だから関所を**別hookとして足さない**。RTKのhookの手前に関所を置き、関所がRTKを呼ぶ（直列化）。
- Codexは新しいhook定義に信頼hashが要る。コマンド文字列が変われば `hooks/list` → `config/batchWrite` の再信頼が要る（既にBellTeamが同じ処理を持つ）。
- `rtk hook check "npm test"` は書き換え無し。`node --test` も無し。関所はRTKが知らないテストコマンドも拾う必要がある。
- コンテナ内の作業コピーは少ない。実体はfox・rabbit・Mac・Windowsの席にある（Aitermの試験はfoxで約12分）。コンテナだけに効く仕組みでは意味が薄い。

## 4. 方針

関所 `testgate` を共通ツールとして作り、各ハーネスのhookコマンドを `rtk hook X` から `testgate hook X` へ替える。関所は

1. コマンドがテスト実行かを判定する（pytest / python -m pytest / npm test / npx jest|vitest / node --test / cargo test / go test / swift test / xcodebuild test / gradlew test / dotnet test / ctest）。
2. テストでなければ、そのまま `rtk rewrite` に渡して結果を返す（今と同じ）。
3. テストなら段階に応じて記録・書き換えをしてから、RTKへ渡す。

### 段階0：観測（まず2週間）

振る舞いを変えない。記録だけ取る。

**実装（2026-10-13 試作済み、`work/testgate/`）**: `testgate hook <harness>` は stdin の hook 入力をそのまま `rtk hook <harness>` へ渡し、stdout と終了コードを中継する。RTK 単体と出力が一致することを試験で確かめている（claude・cursor・codex）。RTK が無い時は何も書き換えずに通す。違いは、テスト実行だった時に `~/.local/share/testgate/log.jsonl` へ一行足すことだけ。複合コマンド（`cd x && npm test`）も記録はする。判定表は `lib/detect.mjs` で、アダプタが揃ったら各アダプタの `detect` に置き換える。

- 記録項目: 時刻、Bot ID、ハーネス、マシン、cwd、リポジトリ、元コマンド、全部流しか部分か、所要秒、終了コード、出力から拾った件数（passed/failed）。
- 置き場: `~/.local/share/testgate/log.jsonl`（RTKと同じ流儀。マシンごと）。コンテナ分は `/home/bell` で永続。
- 所要秒はPreToolUse単独では取れない。PostToolUse hookで `tool_use_id` を突き合わせるか、関所がコマンド自体を `testgate run -- <cmd>` で包んで計時する。包む方が全ハーネスで揃う。
- **評価の規則（ドリリーの指摘、2026-10-13）**: RTK が短縮して消した件数は、成功や 0 件で補わず「取得不能」として扱う。「全部流しの失敗が影の選択範囲の外だった回数」は、失敗テストを識別できた記録（生出力か会話記録から失敗名が取れた物）に限って出し、母数も同じ記録だけにする。取得不能の件数は別に数えて示す。
- 2週間後に出す数字: 席ごとの全部流しの回数/日、テストに使った分/日、全部流しで初めて落ちたテストのうち変更ファイルと無関係だった割合（=部分実行で見逃したであろう数）。この最後の値がほぼゼロなら段階1へ進む根拠になる。

### 段階1：関所

**実行の形（2026-10-13 決定、シュエンの指摘から）**: 段階1では関所がテストコマンドを自分で実行する（`testgate run`）。生の出力を取って `parseOutput` と `stripCounts` に渡し、その後で rtk に短縮させる。rtk test は swift・xcodebuild・gradle を知らず末尾5行に切るため、短縮後からは件数が取れない。段階0（記録だけ）では短縮後しか見えないので件数は欠けるが、段階0に件数は要らない。

**抜け道の扱い**: `gradle build` のように check 経由でテストも流すコマンドは、detect を true にし、select は mode='full' で argv を変えない。書き換えて build の意味を変えない。記録に「全部流れた」と残すのが目的。

- 作業中のテストは「関わる分だけ」に書き換える。言語ごとのアダプタ:
  - Python: pytest-testmon（`--testmon`）。venvへの導入は関所が初回に促す。無ければ `--lf` と変更ファイル名一致で代替。
  - Jest / Vitest: `--changedSince <base>` / `--changed <base>`。
  - node --test: 変更ファイルからimportを逆引きして対象テストファイルを選ぶ（小さな解決器を自作。BellTeam本体がこれ）。
  - cargo: 変更crateとその依存先だけ `-p`。
  - go: 変更packageと `go list -deps` の逆依存。
  - swift / xcodebuild / gradle: 良いRTSが無い。全部流しを許すが時間上限だけ掛ける。
- `<base>` は HEAD ではなく「最後に全部流して通ったcommit」。関所が記録する。未commitの変更も含めて差分を取る。
- 全部流しは `TESTGATE_FULL=1` を付けた時だけ通す。push直前・リリース時の用途。CIは別に動くので、ローカルの全部流しとCIの二重は無くす。
- 全部流しの時間上限（既定180秒、リポジトリごとに `.testgate.toml` で変更可）。超えたら失敗にして「速くするか消すか分けろ」と返す。
- 出力の「N passed」行を落とす。件数が無ければ自慢できない。失敗の詳細は残す（rtk test の方針と同じ）。

### 段階2：刈り込み

- 月1回、マクスウェルがミューテーションテストで重複テストを見つけて消す提案を各担当へ出す。自動では消さない。

## 5. 所有と配布

| 物 | 置き場 | 所有 |
| --- | --- | --- |
| 関所本体（Node、依存なし） | `/srv/bellteam/shared/tools/testgate/` と GitHub（kitepon配下、名前は未定） | マクスウェル |
| BellTeamコンテナへの登録（`rtk hook X`→`testgate hook X`、Codex再信頼） | BellTeam `src/rtk-hooks.mjs` | トロニー（依頼） |
| fox・rabbit・Mac・Windowsへの配布 | RTKの配布手順に同乗 | ドリリー（依頼） |
| 試験場 | BellTeam（node --test、コンテナ内）と Aiterm（foxで12分） | トロニー・エレグ（相談） |

## 6. 開発モデルの割り振り（クオと相談中）

難しさは頭ではなく手数と影響範囲。hookが壊れると全席のBashが止まる。

- 関所の芯（判定・RTKへの委譲・記録・各ハーネスのhook形式）とその試験: 小さいが影響が全席。Fable（マクスウェル）。
- 言語アダプタ（6種）: 独立していて試験しやすく、量が多い。安い席（GPT-6-Astra）で可。マクスウェルが設計書と受入条件を渡し、結果を審査する。

## 7. 未決

- 段階0の計時を「包む」方式にするか PostToolUse 方式にするか（Cursor・Grokの PostToolUse 対応を確認してから）。
- fox・rabbit・Mac・Windowsの席のhook設定を誰が書き換えているか（RTK配布と同じ経路か）。ドリリーに確認。
- 関所の名前とリポジトリ名。
- RTKが `filters.toml` などでコマンド書き換えを拡張できるなら、関所をRTKの設定として乗せられるかもしれない。未確認。
