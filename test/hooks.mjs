// 让测试与生产一致：`@deepseek-ai/*` 从 app.asar 内部解析。
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const ROOT = 'D:/1/resources/app.asar'

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(`${ROOT}/package.json`).href })
    }
    return nextResolve(specifier, context)
  },
})
