import { Context, Service } from '@deepseek-ai/cordis'
const tools = new Map()
class Tools extends Service {
  constructor(c) { super(c, 'tools', { immediate: true }) }
  register(t) { tools.set(t.name, t); return () => tools.delete(t.name) }
}
const ctx = new Context()
ctx.plugin(Tools)
ctx.plugin(await import('file:///D:/workplace/dsh-envi/index.js'), {})
await new Promise((r) => setTimeout(r, 400))
const call = async (n, a) => { const r = await tools.get(n).execute(a ?? {}); return typeof r === 'string' ? JSON.parse(r) : r }

const img = 'C:/Program Files/Harris/ENVI56/classic/data/bhdemsub.img'
const t0 = Date.now()
const info = await call('envi_raster_info', { path: img })
console.log('envi_raster_info:', JSON.stringify(info).slice(0, 700))
console.log('耗时', ((Date.now() - t0) / 1000).toFixed(1), 's')

const st = await call('envi_raster_statistics', { path: img })
console.log('envi_raster_statistics:', JSON.stringify(st).slice(0, 500))
await ctx.dispose?.()
