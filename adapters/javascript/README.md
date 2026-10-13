# testgate JavaScript アダプタ

テストの関所（testgate）の言語アダプタ。Jest、Vitest、`node --test` を受け持つ。契約は `testgate-adapter-contract.md` v0.4。担当はエーテル（bot-2a505f98）。

- `id = 'javascript'`、`runners = ['jest', 'vitest', 'node --test']`
- 外部依存なしの Node ESM。試験は `node --test test/*.test.mjs`。

## 中身

| 物 | 役目 |
| --- | --- |
| `adapter.mjs` | アダプタ本体。`detect`、`select`、`parseOutput`、`stripCounts` |
| `test/*.test.mjs` | 試験。`test/helpers.mjs` は共通の道具 |
| `fixtures/node-repo`、`jest-repo`、`vitest-repo` | ランナーごとの小さなリポジトリ。tax と price のテストはつながっていて、slug のテストは独立 |
| `fixtures/outputs/` | 実ランナーの出力のサンプル（成功・失敗・読み込みの失敗） |
| `fixtures/capture-outputs.mjs` | `outputs/` を取り直す |
| `fixtures/verify-runners.mjs` | `select` が返した argv を実ランナーで流して、関わるテストだけが流れることを確かめる |

`capture-outputs.mjs` と `verify-runners.mjs` は Jest と Vitest が入った `node_modules` を引数で受け取る。試験からは呼ばれず、アダプタ本体も依存しない。

## 対応する呼び方

直接の呼び出し。

- `node --test`、`node --test <glob>`、`node --test <ディレクトリ>`。node のオプション（`--import`、`--test-reporter` など）はそのまま残す。
- `jest`、`npx jest`、`pnpm exec jest`、`pnpm jest`、`yarn jest`、`yarn run jest`、`bunx jest`、`npm exec jest`、`./node_modules/.bin/jest`、`node node_modules/jest/bin/jest.js`
- `vitest`、`npx vitest run`（`run` 無しも）、`pnpm exec vitest`、`pnpm dlx vitest`、`yarn vitest`、`bunx vitest`、`node node_modules/vitest/vitest.mjs`
- 先頭に付く物: `NAME=value` の代入、`env`、`cross-env`、`rtk jest`、`rtk vitest`、`rtk test <コマンド>`、`rtk npx …`

パッケージスクリプト経由。`package.json` の script が上のランナーを一つだけ単純に呼んでいる時に拾う。script の名前は `test` に限らない。

- `npm test`、`npm t`、`npm run <名前>`、`pnpm test`、`pnpm run <名前>`、`yarn test`、`yarn run <名前>`、`bun run <名前>`、`node --run <名前>`
- Jest と Vitest は、元のコマンドの後ろへ選択のオプションを足す（npm と `node --run` は `--` を挟む）。
- `node --test` はファイルの一覧を差し替える必要があるので、`node --test <選んだファイル>` へ書き換える。

## 対応していない呼び方

| 呼び方 | 扱い | 理由 |
| --- | --- | --- |
| `bun test`、`deno test`、`mocha`、`ava`、`tap`、`playwright test` | `detect` が false | 受け持ちのランナーではない |
| `tsx --test`、`ts-node` 経由 | `detect` が false | 実物で確かめていない |
| `npm --prefix <dir> test`、`npm test -w <pkg>`、`pnpm -r test`、`pnpm --filter <pkg> test`、`yarn workspace <pkg> test` | `detect` が false | どの package.json の script か、アダプタからは決められない |
| `npx -c "jest"` | `detect` が false | コマンド文字列の中までは読まない |
| `nx test`、`turbo run test` | `detect` が false | 自前の affected 選択を持つ別の道具 |
| script が複合（`&&`、`|`、リダイレクトなど）、`pretest`/`posttest` がある、script が別の script を呼ぶ | `detect` は true、`select` は `passthrough` | 契約どおり |
| `node --test` を呼ぶ script で、追加の引数がある・script が環境変数を設定している・package.json と違う場所から打った | `passthrough` | 直接の呼び出しへ書き換えると動きが変わる |
| 監視モード（`--watch`、`vitest watch`、`vitest --ui`） | `passthrough` | ランナー自身が変更を追う |

## mode の決め方

上から順に見て、最初に当たった物で決まる。

| 場面 | mode | argv |
| --- | --- | --- |
| `full: true` | `full` | 元のまま |
| `changed` が空 | `none` | — |
| 複合の script、pre/post、監視モード | `passthrough` | 元のまま |
| 範囲を絞るオプションがある（`-t`、`--testNamePattern`、`--test-name-pattern`、`--test-only`、`--onlyChanged`、`--changedSince`、`--changed`、`--findRelatedTests`、`--shard`、`--project` など） | `passthrough` | 元のまま |
| ファイルの名指し（Jest と Vitest は位置引数があれば全部。`node --test` は glob でもディレクトリでもない引数） | `passthrough` | 元のまま |
| 全体に効くファイルが変わった（`package.json`、ロックファイル、`tsconfig*.json`、`.npmrc`、`jest.config.*`、`babel.config.*`、`vitest.config.*`、`vite.config.*`、`node_modules/` の下など） | `full` | 元のまま |
| coverage 付き（`--coverage`、`--experimental-test-coverage`） | `full` | 元のまま |
| Jest・Vitest で、変更が文書だけ（`.md`、`.txt` など） | `none` | — |
| Jest・Vitest で、git リポジトリの外 | `passthrough` | 元のまま |
| Jest | `subset` | `--changedSince=<base>`、base が無ければ `--onlyChanged` を足す |
| Vitest | `subset` | `--changed=<base>`、base が無ければ `--changed` を足す |
| `node --test` で、`--import` などで先に読み込むファイルに変更が及ぶ | `full` | 元のまま |
| `node --test` で、関わるテストが無い | `none` | — |
| `node --test` で、候補の全部が関わる | `full` | 元のまま |
| `node --test` | `subset` | glob やディレクトリを、選んだファイルの並びへ差し替える |

Jest と Vitest は、関わるテストが一つも無くても `subset` を返す。選ぶのはランナー自身で、アダプタは流す前に結果を知らない。その時ランナーは何も流さず終了コード 0 で終わる（Jest 30.5、Vitest 1.6・3.2・5.0 で確かめた）。

## node --test の解決器

候補のテストファイルを出し、そこから参照をたどって依存の表を作り、変更ファイルから逆向きにたどって関わるテストを選ぶ。表は呼ばれるたびにソースから作り直す。保存はしないので「初回だけ全部」は起きない。BellTeam 本体（テストファイル約 60）で 30 ミリ秒ほど。

候補の出し方は node に合わせてある。引数なしは既定の名前規則（`*.test.js`、`*-test.js`、`*_test.js`、`test-*.js`、`test.js`、`test/` の下。`.mjs`・`.cjs` と、型の除去に対応した Node では `.ts` も）。ディレクトリ指定はその下に同じ規則を当てる。glob は `*`、`**`、`?`、`[]`、`{}` を自前で展開する。

拾う参照。

- `import … from`、`export … from`、副作用だけの `import`、文字列の `import()`、`require()`、`require.resolve()`、`import.meta.resolve()`
- 相対パスと絶対パス。拡張子の省略、ディレクトリの `index`、`package.json` の `main`、TypeScript の `./x.js` → `x.ts`
- `package.json` の `imports`（`#内部名`）
- `new URL('相対パス', import.meta.url)`。ディレクトリを指していれば、その下のどのファイルの変更にも当たる
- `join(__dirname, 'a', 'b')`、`resolve(import.meta.dirname, '../a')` のように、全部が文字列の物
- パスの形をした文字列（`'scripts/build.mjs'` など）で、自分の場所・パッケージのルート・リポジトリのルートのどれかから見て実在のファイルを指す物
- 消えたファイル。消える前の経路を参照していたテストを選ぶ

拾わない物。

- パッケージ名の import。`node_modules` の中は追わない。パッケージの変更はロックファイルの変更として `full` になる。
- 文字列でない `import(x)` と `require(x)`。何を読むか分からないので、どのテストからも静的にたどれない変更ファイルがあった時に、こういう読み込みを持つテストを足す。
- 組み立てたパス（`join(root, 'web', name)`）や、自分を含むディレクトリへの参照（`new URL('..', import.meta.url)`）から先。
- TypeScript の `paths` の別名、カスタムローダーによる解決。
- 環境変数や外部サービスなど、ファイルでない依存。

コメントと文字列は取り除かずに正規表現で拾う。コメントの中の import も辺になり、余分に選ぶ側へ倒れる。

## 出力の読み取り

`parseOutput` が読む形。

| ランナー | 形 | 読める物 |
| --- | --- | --- |
| Jest | 生の出力（色つき、エージェント用の短い形） | passed、failed、skipped、errors、durationMs、failures |
| Vitest | 生の出力（同上） | 同上 |
| node --test | spec と TAP | 同上 |
| Jest | `rtk jest` の短縮後 | passed、failed、skipped、failures |
| node --test | `rtk test` の短縮後 | 末尾 5 行に残った分だけ |
| Vitest | `rtk vitest` の短縮後 | 何も読めない（下の「未解決」） |

- `skipped` には todo も入れる。`node --test` の cancelled は `failed` に入れる。
- `errors` は読み込めなかったテストファイルの数で、`failed` にも数える。Jest は「Test suite failed to run」、Vitest は「Failed Suites」と「Unhandled Errors」、`node --test` はファイル自体が失敗した物。
- `node --test` の dot と junit のレポーターは集計が無いので、件数は返さない。

`stripCounts` が落とす行。

- Jest: `Tests:`、`Test Suites:`、`Snapshots:`
- Vitest: `Test Files`、`Tests`。ファイルごとの行の `(3 tests | 1 skipped)` は失敗の数だけ残す
- node --test: `ℹ tests` から `ℹ todo` まで（TAP は `#`）と、TAP の計画行 `1..N`
- rtk: `PASS (6) FAIL (0) skipped (1)`

所要時間の行、失敗の詳細、例外、通ったテストの名前の行は残す。

## 確かめ方

```sh
node --test test/*.test.mjs                        # 試験
node fixtures/verify-runners.mjs <node_modules>    # 実ランナーで選択を確かめる（Jest・Vitest・git が要る）
node fixtures/capture-outputs.mjs <node_modules>   # outputs/ を取り直す（rtk があれば短縮後も）
```

`fixtures/outputs/` を取ったのは Node 26.11、Jest 30.5.2、Vitest 5.0.4、rtk 0.51.0。

## 未解決

- rtk 0.51 は Vitest 5 の出力を読めない。`rtk vitest` の出力は `[RTK:PASSTHROUGH] vitest parser: All parsing tiers failed` だけになり、件数も失敗の詳細も残らない。アダプタでは補えない。
- `rtk jest` は読み込めなかったテストファイルを集計から落とす。`errors` は取れず、`failed` も一つ少なく出る。
- `rtk test node --test` は出力の末尾 5 行だけを残す。失敗した時は件数が読めない。
- `node --test` の解決器は、組み立てたパスで読むファイルの変更を取りこぼす。上の「拾わない物」のとおり。
- Jest と Vitest の選び方はランナー任せ。`fs.readFile` で読むだけのファイルの変更は、どちらのランナーも追わない。
- Jest の位置引数は、`"test": "jest src"` のようにプロジェクト全体を指す書き方でも名指しとして `passthrough` にする。
- 契約 v0.4 の「守ること」に、ディレクトリのパスも `passthrough` と読める行が残っている（「人が範囲を絞っている時は触らない」の括弧）。このアダプタは v0.3 の規則に従い、`node --test <ディレクトリ>` を選択の対象にしている。
- Windows の実機では流していない。パスの区切りは両方を受けるように書いてある。
