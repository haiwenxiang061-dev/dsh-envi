// 端到端：用真实 apply 注册的工具调用本机 ENVI，验证插件并非只有空壳。
import { Context, Service } from '@deepseek-ai/cordis'
import * as envi from '../lib/index.js'

const tools = new Map()
class Tools extends Service {
  constructor(ctx) { super(ctx, 'tools', { immediate: true }) }
  register(t) { tools.set(t.name, t); return () => tools.delete(t.name) }
}
const ctx = new Context()
ctx.plugin(Tools)
ctx.plugin(envi, {})
await new Promise((r) => setTimeout(r, 400))

const tool = tools.get('envi_info')
const res = await tool.execute({})
const value = typeof res === 'string' ? JSON.parse(res) : res
const text = value?.data ?? value
console.log(JSON.stringify(text, null, 2).slice(0, 1200))
await ctx.dispose?.()
