// .NET prune: Stryker.NET enumerates mutations; isolated source replacements + TRX collect ALL failures.
// No npm dependencies. Outputs and classification follow docs/prune-adapter-contract.md.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const id = 'dotnet'
export const runners = ['dotnet test']
export const STRYKER_VERSION = '5.0.0'
// Pin and enumerate every Stryker 5.0 mutator but do not execute any in Stryker itself.
const MUTATORS = ['Statement', 'Arithmetic', 'Block', 'Equality', 'Boolean', 'Logical', 'Assignment', 'Unary', 'Update', 'Checked', 'Linq', 'String', 'Bitwise', 'Initializer', 'Regex', 'NullCoalescing', 'Math', 'StringMethod', 'Conditional', 'CollectionExpression']
const ignoredDir = /^(?:\.git|\.vs|\.idea|node_modules|vendor|target|bin|obj|\.venv|StrykerOutput|\.stryker-tmp|TestResults)$/i
const slash = p => p.split(path.sep).join('/')
const hash = s => createHash('sha256').update(s).digest('hex')
const read = f => readFileSync(f, 'utf8')
const json = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n')
function walk(dir) {
  const files = []
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) { if (!ignoredDir.test(ent.name)) files.push(...walk(path.join(dir, ent.name))) }
    else if (ent.isFile()) files.push(path.join(dir, ent.name))
  }
  return files.sort()
}
function projects(cwd) { return walk(cwd).filter(f => f.endsWith('.csproj')) }
function isTest(p) { return /<IsTestProject>\s*true\s*<|PackageReference\s+Include=["'](?:Microsoft\.NET\.Test\.Sdk|xunit|NUnit|MSTest\.TestFramework)["']/i.test(read(p)) }
export async function detect(cwd) {
  const git = spawnSync('git', ['-C', cwd, 'ls-files', '-z', '--', '*.csproj'], { encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024 * 1024 })
  if (git.status === 0) return git.stdout.split('\0').filter(Boolean).some(n => existsSync(path.join(cwd, n)) && isTest(path.join(cwd, n)))
  const deadline = Date.now() + 800
  const scan = dir => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (Date.now() > deadline) return false
      const f = path.join(dir, ent.name)
      if (ent.isFile() && ent.name.endsWith('.csproj') && isTest(f)) return true
      if (ent.isDirectory() && !ignoredDir.test(ent.name) && scan(f)) return true
    }
    return false
  }
  return scan(cwd)
}
export async function name(cwd) { return path.basename(path.resolve(cwd)) }
export function toolDir(env = process.env) {
  return path.join(env.TESTGATE_PRUNE_TOOLS || path.join(env.XDG_DATA_HOME || path.join(env.HOME || homedir(), '.local', 'share'), 'testgate', 'prune-tools'), 'dotnet', STRYKER_VERSION)
}
export function toolsReady(env = process.env) {
  return spawnSync('dotnet', ['--version'], { env, stdio: 'ignore' }).status === 0 && existsSync(path.join(toolDir(env), process.platform === 'win32' ? 'dotnet-stryker.exe' : 'dotnet-stryker'))
}

/** Small glob matcher, independent of Node's optional glob APIs (Node >=20). Paths always use /. */
export function matches(value, pattern) {
  value = value.replace(/\\/g, '/'); pattern = pattern.replace(/\\/g, '/')
  let r = '^'
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*' && pattern[i + 1] === '*') {
      i++; if (pattern[i + 1] === '/') { i++; r += '(?:.*/)?' } else r += '.*'
    } else if (c === '*') r += '[^/]*'
    else if (c === '?') r += '[^/]'
    else r += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(r + '$').test(value)
}
const any = (v, pats) => pats.some(p => matches(v, p))
function accepts(file, pats) {
  const yes = pats.filter(p => !p.startsWith('!')), no = pats.filter(p => p.startsWith('!')).map(p => p.slice(1))
  return (!yes.length || any(file, yes)) && !any(file, no)
}
function inside(root, f) { const r = path.relative(root, f); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r) }

/** Kill the complete process tree on timeout, including dotnet testhost and MSBuild children. */
export function runCommand(argv, { cwd, env = process.env, logFile, timeoutMs = 0 } = {}) {
  return new Promise(resolve => {
    const start = Date.now(), detached = process.platform !== 'win32'
    if (logFile) appendFileSync(logFile, '\n$ ' + JSON.stringify(argv) + '\n')
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', timedOut = false, error
    const take = d => { const s = d.toString(); if (logFile) appendFileSync(logFile, s); if (output.length < 16 * 1024 * 1024) output += s }
    child.stdout.on('data', take); child.stderr.on('data', take)
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }, timeoutMs) : null
    child.on('error', e => { error = e.message })
    child.on('close', status => { if (timer) clearTimeout(timer); resolve({ status: status ?? 127, output, timedOut, error, durationMs: Date.now() - start }) })
  })
}

function decode(s) {
  return s.replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi, (_, h, n, k) => h || n ? String.fromCodePoint(parseInt(h || n, h ? 16 : 10)) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[k.toLowerCase()])
}
// TRX is generated by VSTest, not arbitrary XML: no DTD resolution or external entities.
export function parseXml(s) {
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new Error('DTD is not supported in TRX')
  const root = { tag: '', attrs: {}, children: [], text: '' }, stack = [root]
  for (const t of s.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/g) || []) {
    if (t.startsWith('<!--') || t.startsWith('<?')) continue
    if (t.startsWith('<![CDATA[')) { stack.at(-1).text += t.slice(9, -3); continue }
    if (t.startsWith('</')) { if (stack.length === 1) throw new Error('Invalid TRX closing tag'); stack.pop(); continue }
    if (t.startsWith('<')) {
      const tag = /^<([^\s/>]+)/.exec(t)?.[1]?.split(':').at(-1)
      if (!tag) throw new Error('Invalid TRX tag')
      const node = { tag, attrs: {}, children: [], text: '' }
      for (const m of t.matchAll(/([^\s=<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) node.attrs[m[1]] = decode(m[2] ?? m[3])
      stack.at(-1).children.push(node); if (!t.endsWith('/>')) stack.push(node)
    } else stack.at(-1).text += decode(t)
  }
  if (stack.length !== 1) throw new Error('Truncated TRX')
  return root
}
function descendants(n, tag) { return [...(n.tag === tag ? [n] : []), ...n.children.flatMap(c => descendants(c, tag))] }
function text(n) { return n ? n.text + n.children.map(text).join('') : '' }
export function parseTrx(xml) {
  const root = parseXml(xml), definitions = new Map()
  for (const t of descendants(root, 'UnitTest')) {
    const m = descendants(t, 'TestMethod')[0]
    if (!m) continue
    const cls = (m.attrs.className || '').split(',')[0]
    const method = (m.attrs.name || '').replace(/\(.*$/, '')
    if (!cls || !method) throw new Error('TRX contains a test without a fully qualified name')
    definitions.set(t.attrs.id, { id: cls + '.' + method, name: cls + '.' + method, className: cls, displayName: t.attrs.name || cls + '.' + method })
  }
  return descendants(root, 'UnitTestResult').map(r => {
    const def = definitions.get(r.attrs.testId)
    if (!def) throw new Error('TRX result has no test definition: ' + r.attrs.testId)
    const msg = text(descendants(r, 'Message')[0]), stack = text(descendants(r, 'StackTrace')[0])
    return { ...def, outcome: r.attrs.outcome, message: msg, stack, error: [msg, stack].filter(Boolean).join('\n').slice(0, 4000) }
  })
}
/** Canonical assertion messages compensate for TRX omitting xUnit's exception type. Ambiguous failures stay prerequisite. */
export function failureKind({ message = '', stack = '', className = '' }) {
  const assertion = /\bXunit\.Sdk\.\w*Exception\b|\bNUnit\.Framework\.AssertionException\b|\bMicrosoft\.VisualStudio\.TestTools\.UnitTesting\.AssertFailedException\b|^Assert\.[A-Za-z]+\(\) Failure\b|^Assert\.[A-Za-z]+ failed\./m.test(message)
  const frame = /\bat\s+([^\s(]+)\s*\(/.exec(stack)?.[1]
  return assertion && !!className && !!frame && frame.startsWith(className + '.') ? '狙い' : '前提'
}
export function applyMutation(source, mutant) {
  const pos = p => {
    if (!Number.isInteger(p.line) || !Number.isInteger(p.column) || p.line < 1 || p.column < 1) throw new Error('Invalid mutation location')
    let offset = 0
    for (let i = 1; i < p.line; i++) { const n = source.indexOf('\n', offset); if (n < 0) throw new Error('Mutation line exceeds source'); offset = n + 1 }
    const lineEnd = source.indexOf('\n', offset), end = lineEnd < 0 ? source.length : lineEnd
    offset += p.column - 1
    if (offset > end) throw new Error('Mutation column exceeds source')
    return offset
  }
  const a = pos(mutant.location.start), b = pos(mutant.location.end)
  if (a > b || typeof mutant.replacement !== 'string') throw new Error('Invalid mutation replacement')
  return source.slice(0, a) + mutant.replacement + source.slice(b)
}
export function sampleMutants(items, count, seed) {
  return [...items].sort((a, b) => {
    const key = x => hash(seed + '\0' + x.file + '\0' + JSON.stringify(x.mutant.location) + '\0' + x.mutant.mutatorName + '\0' + x.mutant.replacement + '\0' + hash(x.source))
    return key(a).localeCompare(key(b)) || a.file.localeCompare(b.file)
  }).slice(0, count > 0 ? count : undefined)
}

async function msbuild(project, ctx) {
  const r = await runCommand(['dotnet', 'msbuild', project, '-nologo', '-getItem:Compile,ProjectReference'], ctx)
  if (r.status !== 0) throw new Error('Cannot evaluate ' + project + ': ' + r.output.slice(-1500))
  let data
  try { data = JSON.parse(r.output.slice(r.output.indexOf('{'))) } catch { throw new Error('MSBuild did not return item JSON: ' + project) }
  return { project, sources: (data.Items?.Compile || []).map(v => path.resolve(path.dirname(project), v.FullPath || v.Identity)), refs: (data.Items?.ProjectReference || []).map(v => path.resolve(path.dirname(project), v.FullPath || v.Identity)) }
}
function testClasses(file) {
  const s = read(file), ns = /\bnamespace\s+([\w.]+)\s*[;{]/.exec(s)?.[1] || ''
  return [...s.matchAll(/\b(?:class|struct)\s+([A-Za-z_]\w*)/g)].map(m => ns ? ns + '.' + m[1] : m[1])
}
function testFileOf(test, target) { return target.sources.find(f => existsSync(f) && testClasses(f).includes(test.className)) || '' }
function copyRepository(cwd, dest) {
  const g = spawnSync('git', ['-C', cwd, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const tracked = g.status === 0 ? g.stdout.split('\0').filter(Boolean) : []
  const names = tracked.length ? tracked : walk(cwd).map(f => path.relative(cwd, f))
  for (const n of names) {
    if (n.split(/[\\/]/).some(p => ignoredDir.test(p))) continue
    const from = path.resolve(cwd, n), to = path.resolve(dest, n)
    if (!inside(cwd, from) || !inside(dest, to)) throw new Error('Repository file escapes sandbox')
    if (!existsSync(from) || !statSync(from).isFile()) continue
    mkdirSync(path.dirname(to), { recursive: true }); copyFileSync(from, to)
  }
}
async function ensureTools(ctx, log) {
  const dir = toolDir(ctx.env), exe = path.join(dir, process.platform === 'win32' ? 'dotnet-stryker.exe' : 'dotnet-stryker')
  if (!existsSync(exe)) {
    mkdirSync(dir, { recursive: true }); log(`testgate prune: Stryker.NET ${STRYKER_VERSION} を ${dir} へ導入`)
    const r = await runCommand(['dotnet', 'tool', 'install', 'dotnet-stryker', '--version', STRYKER_VERSION, '--tool-path', dir], { ...ctx, timeoutMs: 300000 })
    if (r.status !== 0) throw new Error('Stryker.NET install failed: ' + r.output.slice(-2000))
  }
  const ver = await runCommand(['dotnet', 'tool', 'list', '--tool-path', dir], { ...ctx, timeoutMs: 30000 })
  if (ver.status !== 0 || !new RegExp('dotnet-stryker\\s+' + STRYKER_VERSION.replace(/\./g, '\\.') + '(?:\\s|$)').test(ver.output)) throw new Error('Cannot verify Stryker.NET ' + STRYKER_VERSION + ': ' + ver.output)
  log(`testgate prune: Stryker.NET ${STRYKER_VERSION} (${exe})`)
  return exe
}
function filterFor(ids) { return [...new Set(ids)].sort().map(t => 'FullyQualifiedName=' + t).join('|') }
function trxIn(dir) { return existsSync(dir) ? walk(dir).filter(f => f.endsWith('.trx')) : [] }
async function testRun(target, resultDir, ctx, filter, timeout, perTestTimeout) {
  mkdirSync(resultDir, { recursive: true })
  const argv = ['dotnet', 'test', target.project, '--logger', 'trx;LogFileName=results.trx', '--results-directory', resultDir]
  if (filter) {
    // Runsettings avoids Windows' command-line limit for thousands of fully qualified test IDs.
    const settings = path.join(resultDir, 'tests.runsettings')
    const escaped = filter.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    writeFileSync(settings, '<RunSettings><RunConfiguration><TestCaseFilter>' + escaped + '</TestCaseFilter></RunConfiguration></RunSettings>')
    argv.push('--settings', settings)
  }
  if (perTestTimeout > 0) argv.push('--blame-hang', '--blame-hang-timeout', perTestTimeout + 'ms', '--blame-hang-dump-type', 'none')
  const r = await runCommand(argv, { ...ctx, timeoutMs: timeout })
  const files = trxIn(resultDir)
  const results = files.flatMap(f => parseTrx(read(f)))
  return { ...r, results, trx: files }
}

export async function prune({ cwd, runDir, logFile, sample = 200, seed = 'testgate', mutate = [], tests = [], exclude = [], timeoutMs = 60000, testTimeoutMs = 60000, jobs, keepSandbox = false, env = process.env, log = () => {} }) {
  cwd = path.resolve(cwd); mkdirSync(runDir, { recursive: true })
  const root = keepSandbox ? path.join(runDir, 'sandbox') : mkdtempSync(path.join(tmpdir(), 'tg-dotnet-prune-')), sandbox = path.join(root, 'repo')
  const notes = ['Stryker.NETで列挙し、標本ごとに元ソースを置換して全対象試験をTRX付きで実行（早期中断なし）。', '.NETの狙い判定は断言例外型または定型断言文と、最初のstack frameが当該試験クラスであることを使用。', 'coverage計装は使わない。未被覆と生存は区別できないため、全試験成功はSurvived。Theoryのデータ行は完全修飾メソッド名で束ねる。']
  const excluded = new Set(), preflightExcluded = new Set()
  if (jobs && jobs !== 1) notes.push('ソース置換を混ぜないため変異の実行は直列。--jobsは同時変異数を増やさない。')
  try {
    mkdirSync(sandbox, { recursive: true }); copyRepository(cwd, sandbox)
    const ctx = { cwd: sandbox, env: { ...env, MSBUILDDISABLENODEREUSE: '1', DOTNET_CLI_USE_MSBUILD_SERVER: '0', UseSharedCompilation: 'false' }, logFile, timeoutMs: 300000 }
    const exe = await ensureTools(ctx, log)
    const allProjects = projects(sandbox), testProjects = allProjects.filter(isTest)
    const targets = []
    for (const project of testProjects) {
      const t = await msbuild(project, ctx), rel = slash(path.relative(sandbox, project))
      const chosenFiles = t.sources.filter(f => existsSync(f) && accepts(slash(path.relative(sandbox, f)), tests) && !any(slash(path.relative(sandbox, f)), exclude))
      if (tests.length && !any(rel, tests) && !chosenFiles.length) continue
      const whole = !tests.length || any(rel, tests)
      const classes = chosenFiles.flatMap(testClasses)
      const sourceExcludes = t.sources.filter(f => existsSync(f) && any(slash(path.relative(sandbox, f)), exclude)).flatMap(testClasses)
      t.initialFilter = [whole ? '' : classes.map(c => 'FullyQualifiedName~' + c).join('|'), ...sourceExcludes.map(c => 'FullyQualifiedName!~' + c)].filter(Boolean).map(x => '(' + x + ')').join('&')
      targets.push(t)
    }
    if (!targets.length) throw new Error('No test csproj matches --tests (use test project or C# source globs)')
    const report = { schemaVersion: '1', thresholds: { high: 80, low: 60 }, files: {}, testFiles: {} }
    const allTests = new Map()
    for (const [i, t] of targets.entries()) {
      log(`testgate prune: 初回試験 ${slash(path.relative(sandbox, t.project))}`)
      const base = await testRun(t, path.join(root, 'baseline', String(i)), ctx, t.initialFilter, 600000, testTimeoutMs)
      if (base.timedOut || !base.results.length) throw new Error('Initial test run did not complete: ' + base.output.slice(-2000))
      t.ids = new Set()
      for (const r of base.results) {
        const f = testFileOf(r, t), rel = f ? slash(path.relative(sandbox, f)) : ''
        if (any(r.id, exclude) || (rel && any(rel, exclude))) { excluded.add(r.id); continue }
        if (r.outcome !== 'Passed') { preflightExcluded.add(r.id); continue }
        t.ids.add(r.id); allTests.set(r.id, { ...r, file: rel })
      }
      // A failing Theory case excludes its whole method, including passing data rows.
      for (const id of preflightExcluded) { t.ids.delete(id); allTests.delete(id) }
      if (!t.ids.size) throw new Error('No passing baseline tests remain in ' + t.project)
    }
    for (const t of allTests.values()) {
      const f = report.testFiles[t.file] ||= { tests: [] }
      f.tests.push({ id: t.id, name: t.name })
    }
    const cache = new Map(targets.map(t => [t.project, t]))
    async function meta(p) { if (!cache.has(p)) cache.set(p, await msbuild(p, ctx)); return cache.get(p) }
    async function dependencySet(p, seen = new Set()) {
      for (const ref of (await meta(p)).refs) if (inside(sandbox, ref) && !seen.has(ref)) { seen.add(ref); await dependencySet(ref, seen) }
      return seen
    }
    for (const t of targets) t.dependencies = await dependencySet(t.project)
    const products = [...new Set(targets.flatMap(t => [...t.dependencies]))].filter(p => !isTest(p)).sort()
    const enumerated = new Map()
    for (const [index, project] of products.entries()) {
      const p = await meta(project)
      const sources = p.sources.filter(f => inside(sandbox, f) && existsSync(f) && !/[\\/](bin|obj)[\\/]|\.g\.cs$|\.generated\.cs$/i.test(f) && accepts(slash(path.relative(sandbox, f)), mutate))
      if (!sources.length) continue
      const relevant = targets.filter(t => t.dependencies.has(project)), output = path.join(root, 'enumerate', String(index))
      const cfg = { 'stryker-config': { project: path.basename(project), 'test-projects': relevant.map(t => t.project), reporters: ['json'], 'coverage-analysis': 'off', 'disable-bail': true, 'ignore-mutations': MUTATORS, mutate: sources.map(f => slash(path.relative(path.dirname(project), f))), 'test-case-filter': filterFor(relevant.flatMap(t => [...t.ids])), concurrency: 1 } }
      const cfgFile = path.join(root, `stryker-${index}.json`); json(cfgFile, cfg)
      log(`testgate prune: 変異の列挙 ${slash(path.relative(sandbox, project))}`)
      const result = await runCommand([exe, '--config-file', cfgFile, '--output', output], { ...ctx, cwd: path.dirname(project), timeoutMs: 600000 })
      const reports = existsSync(output) ? walk(output).filter(f => /mutation-report\.json$/.test(f)) : []
      if (result.status !== 0 || reports.length !== 1) throw new Error('Stryker enumeration failed: ' + result.output.slice(-2500))
      const raw = JSON.parse(read(reports[0])); json(path.join(runDir, `enumeration-${index}.json`), raw)
      for (const [file, v] of Object.entries(raw.files || {})) {
        const actual = path.isAbsolute(file) ? file : path.resolve(raw.projectRoot || path.dirname(project), file)
        if (!sources.includes(actual) || !v.source) continue
        const rel = slash(path.relative(sandbox, actual))
        for (const m of v.mutants || []) {
          const entry = { file: rel, source: v.source, mutant: m }
          const key = rel + JSON.stringify(m.location) + m.mutatorName + m.replacement
          enumerated.set(key, entry)
        }
      }
    }
    if (!enumerated.size) throw new Error('No eligible source mutations were enumerated; no deletion candidates can be justified')
    const chosen = sampleMutants([...enumerated.values()], sample, seed)
    const sampled = { total: enumerated.size, sampled: chosen.length, positions: new Set(chosen.map(e => e.file + JSON.stringify(e.mutant.location))).size }
    writeFileSync(path.join(runDir, 'failures.jsonl'), '')
    log(`testgate prune: ${sampled.total}変異から${sampled.sampled}変異を実行（seed ${seed}）`)
    for (const [index, entry] of chosen.entries()) {
      const { file, source } = entry, f = path.join(sandbox, file)
      const mutant = { ...entry.mutant, id: String(index), status: 'Survived', killedBy: [] }
      delete mutant.statusReason; delete mutant.coveredBy
      const v = report.files[file] ||= { language: 'cs', source, mutants: [] }; v.mutants.push(mutant)
      const started = Date.now(), failures = new Map()
      log(`testgate prune: 変異${index + 1}/${chosen.length} ${file}:${mutant.location.start.line}`)
      try {
        writeFileSync(f, applyMutation(source, mutant))
        for (const [j, target] of targets.entries()) {
          const remaining = timeoutMs - (Date.now() - started)
          if (remaining <= 0) { mutant.status = 'Timeout'; break }
          const r = await testRun(target, path.join(root, 'results', String(index), String(j)), ctx, filterFor([...target.ids]), remaining, testTimeoutMs)
          if (r.timedOut) { mutant.status = 'Timeout'; break }
          if (!r.results.length) { mutant.status = /\berror\s+(?:CS|MSB|NETSDK)\d+/i.test(r.output) ? 'CompileError' : 'RuntimeError'; break }
          const present = new Set(r.results.map(t => t.id))
          if ([...target.ids].some(id => !present.has(id)) || r.results.some(t => !['Passed', 'Failed'].includes(t.outcome))) { mutant.status = 'RuntimeError'; break }
          for (const failure of r.results.filter(t => t.outcome === 'Failed')) {
            const prev = failures.get(failure.id)
            failures.set(failure.id, prev ? { ...failure, error: (prev.error + '\n' + failure.error).slice(0, 4000), kind: prev.kind === '前提' ? '前提' : failureKind(failure) } : { ...failure, kind: failureKind(failure) })
          }
          if (r.status !== 0 && !r.results.some(t => t.outcome === 'Failed')) { mutant.status = 'RuntimeError'; break }
        }
        if (!['Timeout', 'CompileError', 'RuntimeError'].includes(mutant.status)) {
          mutant.status = failures.size ? 'Killed' : 'Survived'
          mutant.killedBy = [...failures.keys()].sort()
          for (const [id, failure] of failures) appendFileSync(path.join(runDir, 'failures.jsonl'), JSON.stringify({ mutant: mutant.id, test: id, name: id, error: failure.error, kind: failure.kind }) + '\n')
        }
        mutant.duration = Date.now() - started
      } finally { writeFileSync(f, source) }
    }
    if (preflightExcluded.size) notes.push('初回に失敗またはskipされた試験は候補から除外: ' + [...preflightExcluded].join(', '))
    json(path.join(runDir, 'project.json'), { cwd, runner: 'dotnet test', tools: { 'dotnet-stryker': STRYKER_VERSION }, strategy: 'enumerate-then-materialize-all-tests-trx', seed, sampled, mutate, tests, excluded: [...excluded], preflightExcluded: [...preflightExcluded], targets: targets.map(t => ({ project: slash(path.relative(sandbox, t.project)), tests: [...t.ids] })), keepSandbox: keepSandbox ? root : null, notes })
    json(path.join(runDir, 'mutation.json'), report)
    return { status: 0, runner: 'dotnet test', sampled, excluded: [...excluded], preflightExcluded: [...preflightExcluded], notes }
  } catch (e) {
    appendFileSync(logFile, '\n' + (e.stack || e.message) + '\n'); log('testgate prune: .NET: ' + e.message)
    return { status: 1, runner: 'dotnet test', notes: [...notes, String(e.message)], excluded: [...excluded], preflightExcluded: [...preflightExcluded] }
  } finally {
    if (keepSandbox) log('testgate prune: sandbox保持 ' + root)
    else rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
