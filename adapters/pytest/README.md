# testgate アダプタ: pytest

契約 v0.3（`/srv/bellteam/bots/bot-47fad91c/docs/testgate-adapter-contract.md`）に沿った、pytest 用の言語アダプタ。外部依存なしの Node ESM。担当: マナ。

- 試験: `node --test test/*.test.mjs`
- 取り込み: ディレクトリごと `adapters/python/` へ移す。`id` は `pytest`。

## 対応する呼び方

先頭に `NAME=value` の環境変数指定が付いていてもよい（`TESTMON_DATAFILE` はここも見る）。

| 呼び方 | 例 |
| --- | --- |
| pytest 直接 | `pytest`、`py.test`、`.venv/bin/pytest`、`C:\proj\.venv\Scripts\pytest.exe` |
| python -m | `python -m pytest`、`python3.13 -m pytest`、`py -3 -m pytest` |
| uv run | `uv run pytest`、`uv run --with x pytest`、`uv run python -m pytest` |
| poetry run | `poetry run pytest`、`poetry run python -m pytest` |

## 選び方（select）

選択は pytest-testmon に任せる。アダプタは `--testmon` を pytest 本体の直後へ差し込むだけで、テストは実行しない。

| 状況 | mode | argv |
| --- | --- | --- |
| `full: true` | `full` | 元のまま |
| `changed` が空（失敗が残っていても） | `none` | 無視される |
| 変更が md / rst / adoc だけ | `none` | 無視される |
| `-k`、`-m`、`--lf`、`--sw`、`--pyargs`、テストのファイル名指し、`file::test` | `passthrough` | 元のまま |
| `--testmon*`、`--no-testmon`、`-p no:testmon`、`-p no:cacheprovider` を人が指定 | `passthrough` | 元のまま |
| `pytest --help` が使えない・5秒超過・`--testmon` が無い | `passthrough` | 元のまま。reason に導入方法 |
| `conftest.py`、`pytest.ini` / `tox.ini` / `setup.cfg` / `pyproject.toml`、`requirements*.txt`、`Pipfile(.lock)`、`poetry.lock`、`uv.lock`、`pdm.lock` が変更に含まれる | `full` | `--testmon-noselect` を足す |
| データファイル（cwd の `.testmondata`、`TESTMON_DATAFILE` で変更可）が無い。初回 | `full` | `--testmon` を足す |
| 上のどれでもない | `subset` | `--testmon` を足す |

- ディレクトリ、glob、`.`、引数なしが選択の対象。ディレクトリでも glob でもないパスは名指しのファイルと見て `passthrough`。glob は展開前の文字列のまま argv に残す（展開は関所のシェル側）。
- 全体に効くファイルは testmon が追跡しない（設定ファイルは実測で追跡されなかった）ので、`--testmon-noselect`（全部流しつつ依存の表を更新する）で選択を止める。
- testmon が入っているかは、argv の pytest と同じ実行環境で `<runner> --help` を呼び、`--testmon` を探して判定する（5秒の timeout）。勝手に `pip install` しない。代替の選択（`--lf`、名前一致）は入れない。
- `-p no:cacheprovider` と `--testmon` は両立しない（testmon が `KeyError: 'lf'` で落ちる）ので、人が付けていれば `passthrough` にする。
- `.testmondata` は cwd に作られる。リポジトリの `.gitignore` に足すこと。

## 結果の読み取り

- `parseOutput`: pytest の要約行（`=== 1 failed, 3 passed in 0.02s ===`、`-q` の素の形、色コード付き、`(0:01:01)` 付き）と rtk 短縮後（`Pytest: 3 passed, 1 failed in 0.02s` と `N. [FAIL] name`）の両方を読む。`failed` は落ちた物の合計で、収集エラー（`1 error`）も含む。`errors` はその内訳（契約 v0.4 の任意欄）。`failures` は `FAILED path::test` / `ERROR path`、rtk の `[FAIL]`、要約の無い形の見出しの順に探し、50件まで。数が取れなければ `undefined`。
- `stripCounts`: 要約行、`collected N items`、testmon の `unchanged files: N` 行、進捗の `[ 50%]` と通過の点、`-v` の PASSED 行を落とす。失敗の詳細と例外、`FAILED ...` の行は残す。

## 試験の前提

- `fixtures/repo/` は小さな実リポジトリ（`calc` ← `report`、独立した `solo`）。`fixtures/samples/` は実出力（生・rtk 短縮後・testmon の各形）。
- 実際に pytest を動かす試験は、testmon 入りの python を `TESTGATE_PYTHON`、プロジェクトの `.venv`、`python3`、`python` の順に探し、無ければ skip する。
- `select` の `probe` 引数は試験用の差し込み口。関所は渡さない。

## 対応していない呼び方

| 呼び方 | 理由 |
| --- | --- |
| `tox`、`nox`、`make test`、`hatch run`、`pdm run`、`pipenv run`、`uvx pytest` | 中身のコマンドをアダプタが知らない。`uv run` と `poetry run` だけ契約の範囲 |
| `coverage run -m pytest`、`python -m unittest` | 別のランナー経由。pytest として判定しない |
| `pytest-xdist` の `-n` など | 解釈はするが、並列の選択結果は検証していない |
| `pyproject.toml` の `addopts` に `-k` などが入っている場合 | argv に出ないので見えない。pytest の設定を読まない |

## 既知の限界

- **.py 以外のデータファイル（json など）の変更は testmon が追跡しない。** testmon 2.2 で実測した（`pkg/settings.json` を読むテストがあっても、json だけ変えると「no tests ran」）。アダプタ側では補わない。データを読むテストの確認は `TESTGATE_FULL=1` で行う。試験 `実測: testmon 2.2 は .py 以外…` がこの事実を確かめている。
- 変更が md / rst / adoc だけなら `none` にする。テストが文書を読む構成は稀と見て、取りこぼしの方向は関所の段階0の記録で見る。
- `pyproject.toml` や `pytest.ini` の `addopts` に `-k` などが入っていても argv には出ないので見えない。pytest 自身が絞るので、結果として流れる範囲は正しい。
- 実際の pytest を動かす試験は、testmon 入りの python が無い席では skip する。`TESTGATE_PYTHON` に python のパスを指定する（配布の段階で各席へ伝える）。
