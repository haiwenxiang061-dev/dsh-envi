// 写盘链路：subset 裁剪 + band math，验证 OUTPUT 参数与 overwrite 门禁。
import { Context, Service } from '@deepseek-ai/cordis'
import { existsSync, rmSync } from 'node:fs'
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
const out = 'D:/workplace/_envi_test/subset.dat'
for (const f of [out, out + '.hdr']) if (existsSync(f)) rmSync(f)

const r = await call('envi_subset', {
  inputPath: img, outputPath: out,
  samples: { first: 1, last: 200 }, lines: { first: 1, last: 150 },
  writeAllowed: true,
})
console.log('envi_subset:', JSON.stringify(r).slice(0, 400))
console.log('输出存在:', existsSync(out), '| hdr:', existsSync(out + '.hdr'))

// 不带 writeAllowed 的写操作应当被拒
const denied = await call('envi_subset', { inputPath: img, outputPath: 'D:/workplace/_envi_test/x.dat', writeAllowed: false })
console.log('无授权写:', JSON.stringify(denied).slice(0, 220))
await ctx.dispose?.()
