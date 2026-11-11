// 复刻 DSH loader：(1) 解析条目 specifier；(2) 动态 import；(3) ctx.plugin(module)。
import { Context, Service } from '@deepseek-ai/cordis'
import { pathToFileURL } from 'node:url'

async function loadEntry(spec) {
  // DSH 的 loader 把相对/绝对路径转成 file:// URL：目录导入必须落到 package.json main。
  const url = /^[a-z]+:/i.test(spec) ? spec : pathToFileURL(spec).href
  return import(url)
}

const entries = [
  'file:///D:/workplace/dsh-envi/index.js',               // 根转发入口（Cordis 需要 default 也可）
  'file:///D:/workplace/dsh-envi/lib/index.js',           // 显式入口
  'D:/workplace/dsh-envi',                                // 裸绝对路径
]

for (const spec of entries) {
  const tools = new Map()
  class Tools extends Service {
    constructor(c) { super(c, 'tools', { immediate: true }); this.m = tools }
    register(t) { tools.set(t.name, t); return () => tools.delete(t.name) }
  }
  const ctx = new Context()
  ctx.plugin(Tools)
  try {
    const mod = await loadEntry(spec)
    await ctx.plugin(mod, {})
    await new Promise((r) => setTimeout(r, 300))
    console.log(`OK   ${spec} -> ${tools.size} tools`)
  } catch (e) {
    console.log(`FAIL ${spec} -> ${e.code ?? ''} ${e.message.slice(0, 90)}`)
  }
  await ctx.dispose?.()
}
