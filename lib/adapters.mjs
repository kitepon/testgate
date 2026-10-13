// adapters/<id>/adapter.mjs を全部読み、契約の口を揃えて返す。
import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'

const defaultDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'adapters')

export async function loadAdapters(dir = process.env.TESTGATE_ADAPTERS || defaultDir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'adapter.mjs')
    if (!existsSync(file)) continue
    try {
      const mod = await import(pathToFileURL(file).href)
      if (typeof mod.detect === 'function' && typeof mod.select === 'function') out.push({ id: mod.id ?? name, dir: join(dir, name), ...mod })
    } catch (error) {
      process.stderr.write(`testgate: adapter ${name} failed to load: ${error.message}\n`)
    }
  }
  return out
}

export function findAdapter(adapters, argv, ctx) {
  for (const a of adapters) {
    try { if (a.detect(argv, ctx)) return a } catch { /* 壊れたアダプタは無視 */ }
  }
  return null
}

// アダプタ契約の出力を安全側へ寄せる
export async function runSelect(adapter, args) {
  const timeout = new Promise(resolve => setTimeout(() => resolve({ argv: args.argv, mode: 'passthrough', reason: `${adapter.id}: select が5秒で返らなかった` }), 5000))
  try {
    const r = await Promise.race([adapter.select(args), timeout])
    if (!r || !['subset', 'full', 'none', 'passthrough'].includes(r.mode) || !Array.isArray(r.argv)) return { argv: args.argv, mode: 'passthrough', reason: `${adapter.id}: select の返り値が契約外` }
    return r
  } catch (error) {
    return { argv: args.argv, mode: 'passthrough', reason: `${adapter.id}: select が失敗: ${error.message}` }
  }
}
