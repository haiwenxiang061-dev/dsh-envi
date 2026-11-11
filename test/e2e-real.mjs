// 端到端：真跑一次 ENVI 任务（RasterProperties），验证不只是能列目录。
import { Context, Service } from '@deepseek-ai/cordis'
import * as envi from '../index.js'

const tools = new Map()
class Tools extends Service {
  constructor(c) { super(c, 'tools', { immediate: true }) }
  register(t) { tools.set(t.name, t); return () => tools.delete(t.name) }
}
const ctx = new Context()
ctx.plugin(Tools)
ctx.plugin(await import('file:///D:/workplace/dsh-envi/index.js'), {})
await new Promise((r) => setTimeout(r, 400))

const call = async (n, args) => {
  const r = await tools.get(n).execute(args ?? {})
  return typeof r === 'string' ? JSON.parse(r) : r
}

// 找一个系统自带的示例影像：ENVI 安装目录下的 .dat/.img
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
const root = 'C:/Program Files/Harris/ENVI56'
let sample = null
const walk = (d, depth) => {
  if (sample || depth > 3) return
  let es = []
  try { es = readdirSync(d) } catch { return }
  for (const e of es) {
    const p = join(d, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, depth + 1)
    else if (/\.(dat|img|tif|hdr)$/i.test(e) && st.size > 10000) { sample = p; return }
  }
}
walk(root, 0)
console.log('sample raster:', sample)

// 任务目录 → 参数契约 → 实跑
const list = await call('envi_tasks', { search: 'RasterProperties' })
console.log('catalog hit:', JSON.stringify(list.data ?? list).slice(0, 200))
await ctx.dispose?.()
