// 用真实 Cordis 组合挂载 lib/index.js，确认 plugin 能在 registry 中正常激活，
// 且 26 个工具 + 2 个技能都出现在 ctx 上。失败会以非零退出码结束。
import { Context } from '@deepseek-ai/cordis'
import * as envi from '../lib/index.js'
import { Service } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'

const tools = new Map()
const skills = new Map()

class Tools extends Service {
  constructor(ctx) { super(ctx, 'tools', { immediate: true }) }
  register(t) {
    if (tools.has(t.name)) throw new Error('duplicate ' + t.name)
    tools.set(t.name, t)
    return () => tools.delete(t.name)
  }
}
class Skills extends Service {
  constructor(ctx) { super(ctx, 'skills', { immediate: true }) }
  register(s) { skills.set(s.name, s); return () => skills.delete(s.name) }
}

const ctx = new Context()
ctx.plugin(Tools)
ctx.plugin(Skills)
ctx.plugin(envi, {})

await new Promise((r) => setTimeout(r, 500))
const names = [...tools.keys()]
console.log('activated tools:', names.length)
console.log(names.join(', '))
console.log('skills:', [...skills.keys()].join(', '))
if (names.length !== 26) { console.error(`FAIL: expected 26 tools, got ${names.length}`); process.exit(1) }
if (!skills.has('envi')) { console.error('FAIL: envi skill missing'); process.exit(1) }
await ctx.dispose?.()
console.log('OK')
