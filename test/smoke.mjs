// 用假 ctx 驱动真实 apply，验证 26 个工具 + 技能 + 命令全部注册，并且没有重复注册。
import { readFileSync } from 'node:fs'
const tools = new Map()
const skills = new Map()
const effects = []
const sections = []
const shellEnvs = []
const logger = { warn: (...a) => console.log('[warn]', ...a), error: (...a) => console.log('[error]', ...a) }
const services = {
  tools: {
    register(t) {
      if (tools.has(t.name)) throw new Error('duplicate tool ' + t.name)
      tools.set(t.name, t)
      return () => tools.delete(t.name)
    },
  },
  skills: { register(s) { skills.set(s.name, s); return () => skills.delete(s.name) } },
  systemPrompt: { section(s) { sections.push(s.name); return () => {} } },
  shellEnv: { register(e) { shellEnvs.push(e); return () => {} } },
}
const ctx = {
  tools: services.tools,
  get: (k) => services[k],
  get logger() { return logger },
  effect(fn, label) {
    const d = fn()
    effects.push({ label, d })
    return () => { if (typeof d === 'function') d() }
  },
  on() { return () => {} },
}
const mod = await import('../lib/index.js')
mod.apply(ctx, {})
await new Promise((r) => setTimeout(r, 200))
console.log('工具数:', tools.size)
console.log('工具列表:', [...tools.keys()].join(', '))
console.log('技能:', [...skills.keys()], '调用策略:', JSON.stringify(skills.get('envi').invocation))
console.log('系统提示段:', sections, '| shellEnv:', shellEnvs.length)
// 校验每个工具契约完备（name/description/parameters/execute/render）
const bad = [...tools.values()].filter((t) => !t.name || !t.description || !t.parameters || typeof t.execute !== 'function' || typeof t.output?.render !== 'function')
console.log('契约不全的工具:', bad.map((t) => t.name))
const ok = skills.get('envi').content.includes('taskengine')
console.log('技能正文含 taskengine:', ok, '长度', skills.get('envi').content.length)
// 复用同一 ctx 二次 apply —— 应当报重复，说明上游必须只加载一次（由 Cordis 保证）
try { mod.apply(ctx, {}); console.log('二次 apply: 未报错（工具已被覆盖）') } catch (e) { console.log('二次 apply 报错（预期）:', e.message) }
process.exit(0)
