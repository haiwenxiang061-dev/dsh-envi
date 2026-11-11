import { Context, Service } from '@deepseek-ai/cordis'
import * as envi from '../lib/index.js'
const tools = new Map()
class Tools extends Service {
  constructor(ctx) { super(ctx, 'tools', { immediate: true }) }
  register(t) { tools.set(t.name, t); return () => tools.delete(t.name) }
}
const ctx = new Context(); ctx.plugin(Tools); ctx.plugin(envi, {})
await new Promise((r) => setTimeout(r, 400))
const res = await tools.get('envi_tasks').execute({})
const v = typeof res === 'string' ? JSON.parse(res) : res
const d = v?.data ?? v
console.log('totalTasks:', d.total, '| 类别数:', Array.isArray(d.categories) ? d.categories.length : Object.keys(d.categories ?? {}).length)
console.log(JSON.stringify(d.categories ?? d).slice(0, 300))
await ctx.dispose?.()
