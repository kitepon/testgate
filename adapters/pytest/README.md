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

---

# 刈り込み（`prune.mjs`）

関所の `testgate prune --runner pytest` のためのアダプタ。契約: 関所の `docs/prune-adapter-contract.md`（v0.1）。段階1の `adapter.mjs` とは別ファイル。外部依存なしの Node ESM で、Python 側の部品は `py/` に置く。

- 試験: `node --test test/*.test.mjs`（prune の試験は `test/prune.test.mjs`）。道具（下）か pytest 入りの python が無い席では、実物を流す試験だけ skip する。kind の判定・結果ファイルの組み立て・対象ファイルの選び方は道具無しで通る。
- 取り込み: `prune.mjs` と `py/` を `adapters/pytest/` へ。`fixtures/prune/`、`test/prune.test.mjs` も同じ。

## 道具と流れ

- **変異の道具は cosmic-ray 8.7.0**（変異の列挙と適用だけに使う）。試験は変異ごとに `py/prune_driver.py` が pytest を全部流し、`py/testgate_prune_plugin.py`（pytest プラグイン）が試験ごとの結果を JSONL に残す。
  - mutmut 3 は最初の失敗で止め、記録も試験ごとではない。cosmic-ray の `exec` は変異ごとの出力が 1 つの文字列にしか残らず、落ちた試験を全部は取れない。契約の `killedBy`（変異ごとに落ちた試験を全部）を満たすため、cosmic-ray の演算子と列挙だけを使い、実行を自前にした。cosmic-ray の内部 API（`commands.init._all_work_items`、`mutating.use_mutation`）を使うので版を固定している。
- 道具は初回に `~/.local/share/testgate/prune-tools/pytest/`（`$TESTGATE_PRUNE_TOOLS` で変更）の venv へ `pip install cosmic-ray==8.7.0` で入れる。要るのはネットワークと、venv の使える python 3.9 以上（`TESTGATE_TOOLS_PYTHON` で指定できる）。導入の有無と版は `log` に出る。本体には入れない。
- 試験を流す python は `TESTGATE_PYTHON` > `<cwd>/.venv` > `<cwd>/venv` > `python3` > `python` の順で、pytest が import できる最初の物。
- 流れ: ①作業の写し（.git・仮想環境・キャッシュ・`__pycache__` を除く。worker ごと）→ ②基準（変異なしで全試験を流し、試験の一覧と、既に落ちる試験を取る）→ ③cosmic-ray で変異を全部列挙し、seed で `sample` 件を選ぶ → ④変異を 1 件ずつ写しに適用して pytest を全部流す → ⑤`mutation.json`・`failures.jsonl`・`project.json` を書く。元のリポジトリには何も書かない。

## 書く物の対応

| 契約 | 中身 |
| --- | --- |
| 試験の id | pytest の nodeid（`tests/test_calc.py::test_add`、パラメータ付きは `[...]` まで） |
| `killedBy` | その変異で落ちた試験の nodeid を全部（setup・teardown の失敗も、重複は 1 つ）。収集の失敗（import 失敗など）だけで落ちた変異は `Killed`、`killedBy` は空 |
| `status` | `Killed`／`Survived`／`Timeout`（変異 1 件の上限を超えた。`killedBy` 空）／`RuntimeError`（試験が 1 本も走らない、pytest が異常終了。候補の集計から外れる） |
| `location` | cosmic-ray の位置（行 1 始まり、桁 0 始まり、終わりは含まない）の桁を +1 した物 |
| `replacement` | 変異の範囲を置き換えた後の完全なコード（`a + b` の `+` なら `-`。短縮しない） |
| `functionName`（契約外の任意欄） | 変異位置を囲む関数名（cosmic-ray の値）。本体の `enclosingFunction` は波括弧の言語向けなので、Python では「関数 不明」になる。本体が読めば使える |
| `failures.jsonl` の `error` | 1 行目は `型: 本文`（pytest の書き換え後の断言文）、続けて例外の発生位置から外へ向かう frame を `   at path:line` で並べる。4000 字まで |
| `kind` | 下 |

### kind（狙い／前提）

pytest が表示する最後の frame（例外の発生位置）で判定する。

- **狙い** = 例外が `AssertionError`（`pytest.fail`・`pytest.raises` の `DID NOT RAISE` の `Failed` も同じ扱い）で、call の段階、発生位置が試験ファイル（収集された試験ファイル、または `test_*.py`／`*_test.py`／`conftest.py`）。
- **前提** = それ以外。製品コードや helper（`tests/helpers.py` など試験ファイルでない物）の中の断言・例外、setup・teardown（fixture）の失敗、収集・import の失敗、試験 1 本の上限超過。

### 基準で落ちる試験

変異なしで落ちる試験（上限超過を含む）と収集に失敗するファイルは、`--deselect`／`--ignore` で除いて流し、`dryRunExcluded` と `notes` に出す。skip された試験は試験の一覧に入れない（何も殺せないので「検出0」で消す候補に出てしまうため）。

## 受け付ける指定

| 本体の引数 | 扱い |
| --- | --- |
| `--mutate GLOB` | 変異の対象ファイル。無ければ、`tests`・`test`・`docs`・`doc`・仮想環境・`build`・`dist`・`*.egg-info` を除いた全 `.py`（`conftest.py`・`setup.py`・`test_*.py`・`*_test.py` も除く） |
| `--tests GLOB` | pytest に渡す試験のパス。無ければ pytest の既定（設定の `testpaths`、無ければ cwd） |
| `--exclude GLOB` | nodeid・ファイルの path・試験名のどれかに一致した試験を流さない。候補にも出ない。実際に除いた nodeid が `excluded` に出る |
| `--timeout-sec` | 変異 1 件の上限。全試験にかかる時間の 4 倍 + 5 秒（10 秒以上）を目安に、指定より短ければそれを使う。全試験が指定の 2/3 以上かかる時は、全体の 2 倍 + 10 秒へ延ばして `notes` に書く |
| `--test-timeout-sec` | 試験 1 本（setup・call・teardown それぞれ）の上限。SIGALRM で止めて失敗（前提）にする。Windows では効かない |
| `--jobs N` | 並列数。作業の写しを N 個作る。既定 1。試験が DB やポートを共有する場合は上げない |
| `--sample N`／`--seed S` | cosmic-ray が列挙した変異の全部（演算子の置換ごとに 1 件）から、seed で決定的に N 件。`positions` は選んだ変異の位置の数 |
| `--keep-sandbox` | 作業の写しを `<runDir>/sandbox/` に残す |

pytest へは `--tb=short --maxfail=1000000000`（`addopts` の `-x` などを上書き）、`-p no:randomly`、`PYTHONDONTWRITEBYTECODE=1` を付ける（同サイズ・同秒の書き換えで古い `.pyc` が使われるのを防ぐ）。作業の写しの根（と `src/`）を `PYTHONPATH` の先頭に置くので、editable install のプロジェクトでも変異した写しが import される（src 配置で実測した）。

## 実測（fixtures の小さな package）

`fixtures/prune/`（製品 `pkg/calc.py`・`pkg/report.py`、試験 8 本。狙い・前提の両方が出る）を `testgate prune --runner pytest --cwd fixtures/prune` で流した結果: 変異 41 件（全部）を約 8 秒（道具の導入済み）、Killed 39・Timeout 0・生存 2、候補 5 本（冗長 3、前提のみ 2）。`candidates.txt` が出る。

- 前提の例: `test_add_strings`（文字列に `-` を適用した製品コードの `TypeError`）、`test_total_helper`（`tests/helpers.py` の断言）。

## うまく動かない時

- **Killed が 0 件** の時は `notes` に出る。製品コードが作業の写しから import されていない（`PYTHONPATH` より前に解決される別の場所に入っている）か、試験が変異に届いていない。
- **`addopts` に `--testmon`、`--lf`、`--ff`** などの選択系が入っていると、変異ごとの試験が選択される。刈り込みの時は外す。
- **pytest-xdist**（`-n`）は結果を controller で書くので動く想定だが、並列の試験の選択結果は検証していない。
- cosmic-ray の既定の演算子は 200 種類を超え、算術・比較の演算子は置換先ごとに別の変異になる（`a + b` の `+` だけで 11 件）。`--sample` で絞る。
- parso が読めない新しい構文のファイルは、そのファイルだけ変異の対象から外し、`notes` に書く。
