/**
 * dsh-envi — operate ENVI from DeepSeek Harness.
 *
 * ## The one fact everything here rests on
 *
 * ENVI 5.6 ships IDL 8.8 as a runtime VM: `idl.exe -e`, batch `.pro` files, and
 * `idlrt.exe -e` all fail to execute code on this machine (docs/probe-findings.md).
 * What DOES work, verified end to end, is ENVI's own task engine:
 *
 *     taskengine.exe ENVI
 *     stdin  -> {"schema":"envitask","taskName":"...","inputParameters":{...}}
 *     stdout -> {"outputParameters":{...}}
 *
 * It runs headless, opens no window, raises no dialog, and returns real
 * processed data. That is the execution channel.
 *
 * ## What "all ENVI functionality" means concretely
 *
 * The engine exposes ENVI's own task catalog: 302 tasks across 30 categories,
 * covering atmospheric correction, classification, pan sharpening, terrain,
 * deep learning, radiometry, mosaics, spectral tools and more. Rather than
 * hard-coding a tool per menu item -- which would rot the moment ENVI changes --
 * the plugin exposes:
 *
 *   - `envi_tasks`    list the live catalog, filtered by category
 *   - `envi_task_info` the exact parameter contract of any task
 *   - `envi_task_run`  run any task with any parameters
 *
 * plus a few high-level tools for the jobs a user is most likely to ask for,
 * so the model does not have to get dehydrated raster hashes right by hand.
 *
 * Capability discovery is delegated to ENVI itself, so the coverage is whatever
 * the installed ENVI supports -- not a stale list maintained here.
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describeInstallation, discoverEnvi } from './lib/discovery.js'
import { JobStore } from './lib/jobs.js'
import { describeAudit, gateRun, inspectSnippet } from './lib/safety.js'
import {
  CLASSIFICATION_CLEANUP,
  CLASSIFICATION_TO_VECTOR,
  SPECTRAL_ANALYZERS,
  classifierInputsFromStatistics,
  resolveClassifier,
} from './lib/classify.js'
import {
  describeExistingOutput,
  exists,
  inspectOutputPath,
  prepareOutput,
  withPathLock,
} from './lib/output.js'
import {
  normalizeDimensions,
  normalizePixelScale,
  normalizeResampling,
  normalizeSubRect,
  toRasterArray,
} from './lib/raster-ops.js'
import {
  buildPolygonRegionXml,
  buildRegionXml,
  buildRoiXml,
  geometryFromHeader,
  normalizeColor,
  normalizePoints,
  pixelsToMap,
  rectangularGrid,
  spatialRefFromHeader,
} from './lib/roi.js'
import {
  explainEngineFailure,
  pruneScratch,
  rasterParameter,
  runTask,
  scratchDir,
  toLosslessJson,
  toPosix,
  vectorParameter,
} from './lib/task-engine.js'

export const name = 'dsh-envi'
// Array form: this Cordis build resolves `inject` as a name list. The object
// form `{ required, optional }` is read as a service->config map, which makes
// the Loader wait forever on services literally named "required"/"optional".
// `systemPrompt` and `shellEnv` are read through `ctx.get`, so listing them here
// would turn optional access into a hard dependency.
export const inject = ['tools']

const DEFAULTS = {
  installDir: '',
  idlDir: '',
  taskTimeoutMs: 900000,
  catalogCacheMs: 60000,
  // Engine logs are written here. Defaults to F:\workspace on Windows because
  // the system temp folder usually lives on the smaller C: drive.
  scratchDir: '',
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const jobs = new JobStore()
  let catalogCache

  /**
   * Where engine logs go.
   *
   * F:\workspace on Windows: the system temp folder sits on C:, which is the
   * drive that fills up. An explicit config value always wins.
   */
  const scratchRoot = (() => {
    if (typeof config.scratchDir === 'string' && config.scratchDir.trim() !== '') return config.scratchDir.trim()
    return process.platform === 'win32' ? 'F:\\workspace' : undefined
  })()

  // A killed run leaves its log directory behind; sweep those on startup.
  if (scratchRoot !== undefined) void pruneScratch(scratchRoot).catch(() => 0)

  const installation = () =>
    discoverEnvi({ installDir: config.installDir, idlDir: config.idlDir, env: process.env })

  /**
   * Resolve the engine every call: a mid-session install or repair is then
   * visible without restarting the plugin.
   */
  const engine = () => {
    const info = installation()
    if (info.found !== true || typeof info.taskEngine !== 'string') {
      return { ok: false, info }
    }
    return { ok: true, enginePath: info.taskEngine, info }
  }

  /** Run one task, normalising every failure mode into one shape. */
  const invoke = async ({ taskName, input, compile = false, timeoutMs, overwrite = false, signal }) => {
    const resolved = engine()
    if (!resolved.ok) {
      return {
        status: 'unavailable',
        reason: '没有找到 ENVI 的任务引擎（taskengine.exe）。请在插件配置里设置 installDir。',
        installation: describeInstallation(resolved.info),
      }
    }
    // Validate the output path even when nothing is being overwritten: an illegal
    // filename makes ENVI fail with a bare "Task execution failed", which reads
    // like a processing bug rather than a bad file name.
    const outputTarget = outputUriOf(input)
    if (outputTarget !== undefined) {
      const problem = inspectOutputPath(outputTarget)
      if (problem !== '') return { status: 'refused', reason: problem }
    }
    // Check every file-backed input before paying ~6s for an engine start. The
    // engine does report this, but only after hydration wraps it in a message
    // that reads like a format problem.
    const missing = await findMissingInput(input)
    if (missing !== undefined) {
      return { status: 'failed', reason: `文件不存在：${missing}`, missingInput: missing }
    }
    // Two callers writing the same path must not interleave delete-and-write.
    // Different paths stay fully concurrent, which the measured numbers support:
    // 6 mixed tasks finish in about half the serial time with identical bytes.
    const runLocked = () => executeTask()
    return outputTarget === undefined
      ? runLocked()
      : withPathLock(outputTarget, runLocked)

    async function executeTask() {
      // ENVI refuses to overwrite an existing dataset, so clear it up front. Doing
      // this here means every writer gets the behaviour without repeating it.
      if (overwrite === true && outputTarget !== undefined) {
        const prepared = await prepareOutput(outputTarget, { overwrite: true })
        if (prepared.ok !== true) return { status: 'refused', reason: prepared.reason }
      }
      const logDir = await scratchDir('dsh-envi-log', scratchRoot)
      const logPath = join(logDir, 'engine.log')
      try {
        const outcome = await runTask({
          engine: 'envi',
          enginePath: resolved.enginePath,
          taskName,
          input,
          compile,
          timeoutMs: timeoutMs ?? config.taskTimeoutMs,
          logPath,
          // ENVI drops ENVITemp*.epo packages into its working directory. Without
          // this the engine inherits ours and litters the source tree / user's cwd.
          cwd: logDir,
          // Without this, envi_job_kill only flipped a status string while the
          // engine kept running and holding its licence seat.
          signal,
        })
        let log
        try {
          log = await readFile(logPath, 'utf8')
        } catch {
          log = ''
        }
        const result = {
          status: outcome.ok ? 'ok' : 'failed',
          taskName,
          elapsedMs: outcome.elapsedMs,
          result: outcome.result,
          reason: outcome.ok ? undefined : outcome.failure,
          engineStderr: outcome.diagnostics === '' ? undefined : outcome.diagnostics.slice(0, 4000),
          idlLog: /error|failed|% /i.test(log) ? log.slice(-4000) : undefined,
        }
        // ENVI will not overwrite an existing dataset; translate that one failure
        // so a repeated call reads as a conflict instead of a corrupt file. The
        // full sentence lives in stderr -- `reason` is only its first line -- so
        // both are checked.
        if (!outcome.ok) {
          const outputPath = outputUriOf(input)
          const explained = outputPath === undefined
            ? undefined
            : describeExistingOutput(
              `${result.reason ?? ''}\n${result.engineStderr ?? ''}`,
              outputPath,
            )
          if (explained !== undefined) result.reason = explained
        }
        // Every ENVI call funnels through here, so this is the one place that
        // guarantees the whole tool surface returns lossless JSON. Statistics
        // over a masked or single-pixel subset yield NaN/Infinity, and the tool
        // boundary rejects those outright without saying which field.
        return toLosslessJson(result)
      } finally {
        // The log has been read into the result; the directory is pure scratch.
        await rm(logDir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  /**
   * The live task catalog, cached briefly so listing is cheap.
   *
   * `category` goes to ENVI as FILTER_TAGS rather than being filtered locally:
   * QueryTaskCatalog documents FILTER_TAGS as "only tasks that have all tags set
   * in this array are returned, case-insensitive", so ENVI already answers it.
   * Upstream accepted a `category` argument and never used it, so every filtered
   * call returned the whole 295-task catalog.
   *
   * Each tag costs its own engine round trip (~6s), so results are cached per tag.
   */
  const catalog = async ({ force = false, category } = {}) => {
    const tag = typeof category === 'string' && category.trim() !== '' ? category.trim() : undefined
    const cacheKey = tag === undefined ? '' : tag.toLowerCase()
    const cached = catalogCache?.get(cacheKey)
    if (!force && cached !== undefined && Date.now() - cached.at < config.catalogCacheMs) {
      return cached.value
    }
    const outcome = await invoke({
      taskName: 'QueryTaskCatalog',
      input: tag === undefined ? {} : { FILTER_TAGS: [tag] },
      timeoutMs: 180000,
    })
    if (outcome.status !== 'ok') {
      catalogCache?.delete(cacheKey)
      return { error: outcome.reason ?? '无法取得任务目录', detail: outcome }
    }
    const value = {
      tasks: Array.isArray(outcome.result?.TASKS) ? outcome.result.TASKS : [],
      tags: Array.isArray(outcome.result?.UNIQUE_TAGS) ? outcome.result.UNIQUE_TAGS : [],
    }
    if (catalogCache === undefined) catalogCache = new Map()
    catalogCache.set(cacheKey, { at: Date.now(), value })
    return value
  }

  // ---------------------------------------------------------------------
  // 安装与环境
  // ---------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'envi_info',
    description:
      'Report the ENVI/IDL installation, the task-engine path used for execution, and whether it is usable. Call this first when something cannot reach ENVI.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      const info = installation()
      const resolved = engine()
      return {
        ...describeInstallation(info),
        usable: resolved.ok,
        channel: 'taskengine.exe ENVI',
        channelNote:
          'ENVI 自带的是 IDL 运行时虚拟机：idl.exe -e、批处理 .pro、idlrt -e 都不会执行代码。唯一能无人值守执行的是 ENVI 自己的任务引擎（stdin JSON → stdout JSON），它不开窗口、不弹对话框。',
        config: {
          installDir: config.installDir || '(自动探测)',
          taskTimeoutMs: config.taskTimeoutMs,
        },
      }
    },
  }))

  /**
   * Band count of a raster, read through RasterProperties.
   *
   * Returns undefined when the query fails, so callers must treat "unknown" as
   * "do not pre-judge" rather than as a rejection.
   */
  const rasterBandCount = async (path) => {
    if (path.trim() === '') return undefined
    const outcome = await invoke({
      taskName: 'RasterProperties',
      input: { INPUT_RASTER: rasterParameter(path) },
      timeoutMs: config.taskTimeoutMs,
    })
    if (outcome.status !== 'ok') return undefined
    const bands = Number(outcome.result?.NBANDS)
    return Number.isFinite(bands) ? bands : undefined
  }

  // ---------------------------------------------------------------------
  // 能力发现：目录交给 ENVI 自己回答
  // ---------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'envi_tasks',
    description:
      'List ENVI processing tasks available on this machine (the live catalog, 300+ tasks). Filter by category tag (e.g. "Classification", "Terrain", "Deep Learning") or a name substring. Use this to find the right task before calling envi_task_run.',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Category tag to filter by, e.g. Terrain.' },
        search: { type: 'string', description: 'Case-insensitive substring of the task name.' },
        refresh: { type: 'boolean', description: 'Bypass the short-lived catalog cache.' },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const category = typeof args?.category === 'string' ? args.category : undefined
      const cataloged = await catalog({ force: args?.refresh === true, category })
      if (cataloged.error !== undefined) return { status: 'failed', reason: cataloged.error }
      const search = typeof args?.search === 'string' ? args.search.toLowerCase() : ''
      let tasks = cataloged.tasks
      if (search !== '') tasks = tasks.filter((task) => task.toLowerCase().includes(search))
      return {
        status: 'ok',
        // With a category filter `total` is that category's size, so the caller can
        // tell "21 of 21" from "21 of 295" without a second call.
        total: cataloged.tasks.length,
        shown: tasks.length,
        filteredBy: category ?? null,
        categories: cataloged.tags,
        tasks,
        next: '用 envi_task_info 查某个任务的确切参数，再用 envi_task_run 执行。',
      }
    },
  }))

  /**
   * Raw parameter contract of one task, with parameters keyed by name.
   *
   * `envi_task_info` reshapes this for display; internal callers that need one
   * specific parameter (like the spectral-index list) use this instead so the
   * shape is predictable.
   */
  const taskDefinition = async (taskName) => {
    const outcome = await invoke({
      taskName: 'QueryTask',
      input: { TASK_NAME: taskName },
      timeoutMs: 180000,
    })
    if (outcome.status !== 'ok') return undefined
    const definition = outcome.result?.DEFINITION ?? {}
    return { ...definition, parameters: definition.PARAMETERS ?? {} }
  }

  ctx.tools.register(defineTool({
    name: 'envi_task_info',
    description:
      'Return the exact parameter contract of one ENVI task: every input and output parameter, its type, whether it is required, and its default. Always call this before envi_task_run when the parameters are not obvious.',
    parameters: {
      type: 'object',
      properties: { taskName: { type: 'string', description: 'Exact task name from envi_tasks.' } },
      required: ['taskName'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const taskName = String(args?.taskName ?? '').trim()
      if (taskName === '') throw new Error('taskName 不能为空')
      const outcome = await invoke({
        taskName: 'QueryTask',
        input: { TASK_NAME: taskName },
        timeoutMs: 180000,
      })
      if (outcome.status !== 'ok') return { status: 'failed', reason: outcome.reason }
      const definition = outcome.result?.DEFINITION ?? {}
      const parameters = definition.PARAMETERS ?? {}
      const inputs = []
      const outputs = []
      const choices = {}
      for (const [key, spec] of Object.entries(parameters)) {
        // Never assign `undefined` as a property value: it survives into the
        // object, JSON.stringify silently drops the key, and the tool boundary
        // sees a different key count before and after serializing -- which it
        // reports as "value is not lossless JSON" without naming the field.
        // `DEFAULT: null` is common (every OUTPUT parameter), so building the
        // entry conditionally is the difference between working and unreadable.
        const entry = {
          name: key,
          type: spec.TYPE,
          required: spec.REQUIRED === true,
        }
        if (spec.DEFAULT !== null && spec.DEFAULT !== undefined) entry.default = spec.DEFAULT
        if (spec.DESCRIPTION !== undefined) entry.description = spec.DESCRIPTION
        if (Array.isArray(spec.CHOICE_LIST) && spec.CHOICE_LIST.length > 0) {
          choices[key] = spec.CHOICE_LIST
          entry.choices = spec.CHOICE_LIST
        }
        if (String(spec.DIRECTION).toUpperCase() === 'OUTPUT') outputs.push(entry)
        else inputs.push(entry)
      }
      return {
        status: 'ok',
        taskName: definition.NAME ?? taskName,
        displayName: definition.DISPLAY_NAME,
        description: definition.DESCRIPTION,
        categories: definition.TAGS,
        inputs,
        outputs,
        choices,
        hints: [
          '栅格参数必须写成 {FACTORY:"URLRaster", URL:"C:/path/file.dat"}，裸路径会 hydration 失败。',
          '要落盘输出的任务通常有 *_URI 参数（如 OUTPUT_RASTER_URI / OUTPUT_REPORT_URI）。',
          '布尔参数用 true/false，字符串参数直接写字符串。',
        ],
      }
    },
  }))

  // ---------------------------------------------------------------------
  // 通用执行：任何任务
  // ---------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'envi_task_run',
    description:
      'Run any ENVI task with explicit parameters. This reaches every ENVI capability the install supports. Raster inputs must use the dehydrated form {"FACTORY":"URLRaster","URL":"..."}; the pathInputs/outputs helpers accept bare paths. Audited: tasks that write output require writeAllowed=true; dryRun only audits.',
    parameters: {
      type: 'object',
      properties: {
        taskName: { type: 'string', description: 'Exact task name, e.g. SpectralIndex.' },
        parameters: {
          type: 'object',
          additionalProperties: true,
          description: 'Parameters keyed by the exact names from envi_task_info.',
        },
        rasterInputs: {
          type: 'object',
          additionalProperties: true,
          description: 'Convenience: parameter name -> file path, wrapped as URLRaster automatically.',
        },
        outputs: {
          type: 'object',
          additionalProperties: true,
          description: 'Convenience: URI parameter name -> output file path (posix-normalised).',
        },
        writeAllowed: {
          type: 'boolean',
          description: 'Required when the task writes files (has any *_URI output, or writes in place).',
        },
        dryRun: { type: 'boolean', description: 'Only validate and show what would run.' },
        overwrite: {
          type: 'boolean',
          description: 'Delete an existing output (and its .hdr) before writing. Default false.',
        },
        timeoutSeconds: { type: 'number', description: 'Default 900, max 86400.' },
      },
      required: ['taskName'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const taskName = String(args?.taskName ?? '').trim()
      if (taskName === '') throw new Error('taskName 不能为空')

      const input = {}
      for (const [key, value] of Object.entries(args?.parameters ?? {})) input[key] = value
      for (const [key, value] of Object.entries(args?.rasterInputs ?? {})) {
        input[key] = rasterParameter(String(value))
      }
      for (const [key, value] of Object.entries(args?.outputs ?? {})) input[key] = toPosix(String(value))

      const writes = Object.keys(input).some((key) => /_URI$|OUTPUT|_URI_/i.test(key))
      const audit = inspectSnippet(`${taskName} ${JSON.stringify(input)}`)
      if (args?.dryRun === true) {
        return {
          status: 'dry-run',
          taskName,
          inputParameters: input,
          audit: { mayWrite: writes || audit.mayWrite, writeHints: audit.writeHints, forbidden: audit.forbidden },
          report: describeAudit(audit),
        }
      }
      if (audit.forbidden.length > 0) {
        return { status: 'refused', reason: describeAudit(audit) }
      }
      if (writes && args?.writeAllowed !== true) {
        return {
          status: 'refused',
          reason:
            '这个任务会写文件（含 *_URI 输出参数），需要在同一次调用里显式 writeAllowed=true 才会执行。写入不可逆。',
          inputParameters: input,
        }
      }
      const timeoutSeconds = Math.min(86400, Math.max(5, Number(args?.timeoutSeconds) || 900))
      return invoke({
        taskName,
        input,
        timeoutMs: timeoutSeconds * 1000,
        overwrite: args?.overwrite === true,
      })
    },
  }))

  // ---------------------------------------------------------------------
  // 常用封装：把最容易写错的部分固定下来
  // ---------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'envi_raster_info',
    description:
      'Report a raster\'s properties (bands, size, data type, projection, metadata) via the RasterProperties task. Read-only.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Raster path.' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = String(args?.path ?? '')
      if (path.trim() === '') throw new Error('path 不能为空')
      return invoke({
        taskName: 'RasterProperties',
        input: { INPUT_RASTER: rasterParameter(path) },
        timeoutMs: 300000,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_raster_statistics',
    description:
      'Compute per-band statistics (min, max, mean, stddev, pixel count) for a raster. Read-only and fast.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Raster path.' },
        covariance: { type: 'boolean', description: 'Also compute the covariance matrix. Slower.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const path = String(args?.path ?? '')
      if (path.trim() === '') throw new Error('path 不能为空')
      return invoke({
        taskName: 'RasterStatistics',
        input: {
          INPUT_RASTER: rasterParameter(path),
          COMPUTE_COVARIANCE: args?.covariance === true,
        },
        timeoutMs: 600000,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_spectral_index',
    description:
      'Compute a spectral index (NDVI, EVI, SAVI and the rest of ENVI\'s built-in list) from a raster and save it. Writes an output raster, so writeAllowed is required.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Input raster.' },
        index: {
          type: 'string',
          description: 'Index name, e.g. "Normalized Difference Vegetation Index". Use envi_spectral_indexes to list valid names.',
        },
        outputPath: { type: 'string', description: 'Output raster path.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to actually write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPath', 'index', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      const index = String(args?.index ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || index.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / index / outputPath 都不能为空')
      }
      if (args?.writeAllowed !== true) {
        return {
          status: 'refused',
          reason: '这个调用会写出新影像，需要 writeAllowed=true。写入不可逆。',
        }
      }
      return invoke({
        taskName: 'SpectralIndex',
        input: {
          INPUT_RASTER: rasterParameter(inputPath),
          INDEX: index,
          OUTPUT_RASTER_URI: toPosix(outputPath),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_spectral_indexes',
    description: 'List every spectral index ENVI supports for the SpectralIndex task.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      // There is no standalone "list indices" task: the catalog lives in the
      // CHOICE_LIST of SpectralIndex's INDEX parameter. QuerySpectralIndices does
      // not exist, and SpectralIndices *applies* indices to a raster, so the
      // contract is the only cheap source.
      const definition = await taskDefinition('SpectralIndex')
      const choices = definition?.parameters?.INDEX?.CHOICE_LIST
      if (!Array.isArray(choices)) {
        return { status: 'failed', reason: 'SpectralIndex 没有返回 INDEX 的取值清单。' }
      }
      return { status: 'ok', total: choices.length, indexes: choices }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_subset',
    description:
      'Write a spatial and/or spectral subset of a raster. Spatial cropping uses SUB_RECT [x1,y1,x2,y2] (0-based, inclusive); `samples`/`lines` 1-based ranges are converted for you. Writes an output dataset, so writeAllowed is required.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Input raster.' },
        outputPath: { type: 'string', description: 'Output dataset path.' },
        bands: { type: 'array', items: { type: 'number' }, description: '1-based bands to keep. Omit for all.' },
        subRect: {
          type: 'array',
          items: { type: 'number' },
          description: '[x1, y1, x2, y2] in 0-based inclusive pixel coordinates.',
        },
        samples: {
          type: 'object',
          properties: { first: { type: 'number' }, last: { type: 'number' } },
          description: '1-based inclusive column range.',
          additionalProperties: false,
        },
        lines: {
          type: 'object',
          properties: { first: { type: 'number' }, last: { type: 'number' } },
          description: '1-based inclusive row range.',
          additionalProperties: false,
        },
        writeAllowed: { type: 'boolean', description: 'Must be true to actually write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '这个调用会写出新影像，需要 writeAllowed=true。' }
      }
      const parameters = {
        INPUT_RASTER: rasterParameter(inputPath),
        OUTPUT_RASTER_URI: toPosix(outputPath),
      }

      const bands = Array.isArray(args?.bands) ? args.bands.map(Number).filter(Number.isFinite) : []
      if (bands.length > 0) {
        // SubsetRaster takes 0-based band indices.
        parameters.BANDS = bands.map((band) => Math.max(0, band - 1))
      }

      // SubsetRaster accepts SUB_RECT only. An earlier version of this tool sent
      // SAMPLE_START/LINE_START, which the engine rejected with
      // "No parameter or property name matches SAMPLE_START" -- measured, so the
      // 1-based convenience ranges are converted here instead of forwarded.
      let rect = Array.isArray(args?.subRect) ? args.subRect : undefined
      if (rect === undefined) {
        const s1 = Number(args?.samples?.first)
        const s2 = Number(args?.samples?.last)
        const l1 = Number(args?.lines?.first)
        const l2 = Number(args?.lines?.last)
        if ([s1, s2, l1, l2].some(Number.isFinite)) {
          const x1 = Number.isFinite(s1) ? Math.max(0, s1 - 1) : 0
          const y1 = Number.isFinite(l1) ? Math.max(0, l1 - 1) : 0
          const x2 = Number.isFinite(s2) ? Math.max(0, s2 - 1) : 2 ** 31 - 2
          const y2 = Number.isFinite(l2) ? Math.max(0, l2 - 1) : 2 ** 31 - 2
          rect = [x1, y1, x2, y2]
        }
      }
      if (rect !== undefined) {
        const checked = normalizeSubRect(rect)
        if (!checked.ok) return { status: 'refused', reason: checked.reason }
        parameters.SUB_RECT = checked.rect
      }

      return invoke({
        taskName: 'SubsetRaster',
        input: parameters,
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_mosaic',
    description:
      'Combine several rasters into one mosaic, or stack them into one multi-band layer stack. Pass two or more input paths. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        inputPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two or more raster paths. Order matters for layer stacks.',
        },
        outputPath: { type: 'string', description: 'Output dataset path.' },
        mode: {
          type: 'string',
          description: '"mosaic" (spatially combine) or "stack" (build a band stack). Default mosaic.',
        },
        resampling: { type: 'string', description: 'nearest | bilinear | cubic. Default nearest.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPaths', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const paths = toRasterArray(args?.inputPaths)
      if (paths.length < 2) {
        return { status: 'refused', reason: '至少要两个输入影像。' }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '镶嵌/堆叠会写输出栅格，需要 writeAllowed=true。' }
      }
      const mode = String(args?.mode ?? 'mosaic').toLowerCase()
      if (mode !== 'mosaic' && mode !== 'stack') {
        return { status: 'refused', reason: 'mode 只能是 mosaic 或 stack。' }
      }
      // ENVIRASTERARRAY dehydrates as a plain array of raster hashes -- verified.
      const taskName = mode === 'stack' ? 'BuildLayerStack' : 'BuildMosaicRaster'
      const resampling = normalizeResampling(args?.resampling, {
        allowCubicConvolution: mode === 'stack',
      })
      if (resampling === undefined) {
        return { status: 'refused', reason: 'resampling 只能是 nearest / bilinear / cubic。' }
      }
      const outcome = await invoke({
        taskName,
        input: {
          INPUT_RASTERS: paths,
          RESAMPLING: resampling,
          OUTPUT_RASTER_URI: toPosix(String(args?.outputPath ?? '')),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') {
        outcome.summary = { mode, inputCount: paths.length, resampling }
      } else if (mode === 'stack' && /does not overlap/i.test(outcome.reason ?? '')) {
        // BuildLayerStack needs every input on one grid. Saying so beats leaving
        // the raw engine message, which reads like a corrupt file.
        outcome.summary = {
          mode,
          hint: '图层堆叠要求所有输入影像位于同一空间范围；位置不同的影像请用 mode="mosaic"，或先各自裁剪到同一子区。',
        }
      }
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_resample',
    description:
      'Resample a raster to new pixel dimensions or to a new pixel size. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Input raster.' },
        outputPath: { type: 'string', description: 'Output dataset path.' },
        dimensions: {
          type: 'array',
          items: { type: 'number' },
          description: '[columns, rows] for the output raster.',
        },
        pixelScale: {
          type: 'array',
          items: { type: 'number' },
          description: '[xSize, ySize] in map units, for a pixel-size resample instead of dimensions.',
        },
        resampling: { type: 'string', description: 'nearest | bilinear | cubic. Default nearest.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      const wantsDimensions = Array.isArray(args?.dimensions)
      const wantsScale = Array.isArray(args?.pixelScale)
      if (wantsDimensions === wantsScale) {
        return { status: 'refused', reason: 'dimensions 和 pixelScale 必须给且只给一个。' }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '重采样会写输出栅格，需要 writeAllowed=true。' }
      }
      const resampling = normalizeResampling(args?.resampling)
      if (resampling === undefined) {
        return { status: 'refused', reason: 'resampling 只能是 nearest / bilinear / cubic。' }
      }
      const base = {
        INPUT_RASTER: rasterParameter(inputPath),
        RESAMPLING: resampling,
        OUTPUT_RASTER_URI: toPosix(outputPath),
      }
      if (wantsDimensions) {
        const checked = normalizeDimensions(args.dimensions)
        if (!checked.ok) return { status: 'refused', reason: checked.reason }
        return invoke({
          taskName: 'DimensionsResampleRaster',
          input: { ...base, DIMENSIONS: checked.dimensions },
          timeoutMs: config.taskTimeoutMs,
          overwrite: args?.overwrite === true,
        })
      }
      const checked = normalizePixelScale(args.pixelScale)
      if (!checked.ok) return { status: 'refused', reason: checked.reason }
      return invoke({
        taskName: 'PixelScaleResampleRaster',
        input: { ...base, PIXEL_SCALE: checked.pixelScale },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_reproject',
    description:
      'Reproject a raster or vector to a new coordinate system, given as WKT or an EPSG code. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Input raster or vector.' },
        outputPath: { type: 'string', description: 'Output dataset path.' },
        wkt: { type: 'string', description: 'Target coordinate system as WKT.' },
        epsg: { type: 'number', description: 'Target coordinate system as an EPSG code (alternative to wkt).' },
        isVector: { type: 'boolean', description: 'Set true when inputPath is a vector. Default false.' },
        resampling: { type: 'string', description: 'nearest | bilinear | cubic. Default nearest.' },
        transform: {
          type: 'string',
          description:
            'Geometry transform: polynomial | triangulation | rigorous. Default polynomial, the only one that leaves pixels untouched when the target CRS equals the source CRS (measured on this scene: triangulation rewrote 39.9% of pixels, rigorous 58.7%, polynomial 0%).',
        },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      const wkt = String(args?.wkt ?? '').trim()
      const epsg = Number(args?.epsg)
      if (wkt === '' && !Number.isFinite(epsg)) {
        return { status: 'refused', reason: '需要 wkt 或 epsg 指定目标坐标系。' }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '重投影会写输出，需要 writeAllowed=true。' }
      }
      const isVector = args?.isVector === true
      // ENVICOORDSYS dehydrates two ways, both measured against ReprojectRaster:
      //   {"FACTORY":"CoordSys","COORD_SYS_STR":"<wkt>"}  -> works
      //   {"FACTORY":"CoordSys","COORD_SYS_CODE":32613}   -> works
      // A bare string, an "EPSG:32613" string, and the ENVICoordSys factory are all
      // rejected with "Invalid Coordinate System String", so the code is never
      // packed into the WKT slot.
      const coordSys = wkt === ''
        ? { FACTORY: 'CoordSys', COORD_SYS_CODE: Math.trunc(epsg) }
        : { FACTORY: 'CoordSys', COORD_SYS_STR: wkt }
      const input = {
        COORD_SYS: coordSys,
        ...(isVector
          ? { INPUT_VECTOR: vectorParameter(inputPath) }
          : { INPUT_RASTER: rasterParameter(inputPath) }),
        [isVector ? 'OUTPUT_VECTOR_URI' : 'OUTPUT_RASTER_URI']: toPosix(outputPath),
      }
      if (!isVector) {
        input.RESAMPLING = normalizeResampling(args?.resampling) ?? 'Nearest Neighbor'
        // The task default is Triangulation, which resamples even when the target
        // CRS already matches the source and silently rewrites ~40% of pixels.
        // Polynomial is the identity in that case, so it is the safer default.
        const transform = String(args?.transform ?? 'polynomial').toLowerCase()
        const named = { polynomial: 'Polynomial', triangulation: 'Triangulation', rigorous: 'Rigorous' }[transform]
        if (named === undefined) {
          return { status: 'refused', reason: 'transform 只能是 polynomial / triangulation / rigorous。' }
        }
        input.TRANSFORM = named
      }
      return invoke({
        taskName: isVector ? 'ReprojectVector' : 'ReprojectRaster',
        input,
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_vector_to_roi',
    description:
      'Convert vector features (shapefile etc.) into an ENVI ROI file, so vector boundaries can drive ROI statistics and classification. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Input vector path (.shp).' },
        outputPath: { type: 'string', description: 'Output ROI path; .xml is enforced.' },
        attributeName: {
          type: 'string',
          description: 'Optional attribute whose distinct values become separate ROIs.',
        },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the ROI file.' },
        overwrite: { type: 'boolean', description: 'Delete an existing ROI before writing. Default false.' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      let outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '这个调用会写出 ROI 文件，需要 writeAllowed=true。' }
      }
      // ENVI reads a ROI only when the file is named .xml; .roi is rejected with
      // "Unknown dataset". Verified by copy test.
      if (!/\.xml$/i.test(outputPath)) {
        outputPath = outputPath.replace(/\.[^./\\]*$/, '') + '.xml'
      }
      const attributeName = String(args?.attributeName ?? '').trim()
      const outcome = await invoke({
        taskName: attributeName === '' ? 'VectorRecordsToROI' : 'VectorAttributeToROIs',
        input: {
          INPUT_VECTOR: vectorParameter(inputPath),
          ...(attributeName === '' ? {} : { ATTRIBUTE_NAME: attributeName }),
          OUTPUT_ROI_URI: toPosix(outputPath),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') outcome.roiPath = outputPath
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_band_math',
    description:
      'Create a derived raster from a band-math expression over chosen bands (ratios, thresholds, custom indices). Writes an output raster, so writeAllowed is required.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Input raster.' },
        expression: {
          type: 'string',
          description: 'IDL expression over b1..bN in the order given by bands (1-based), e.g. (float(b4)-b3)/(float(b4)+b3).',
        },
        bands: {
          type: 'array',
          items: { type: 'number' },
          description:
            '1-based band numbers mapped to b1..bN in the expression. Bands are selected into a stack first, so bands [3,4] makes b1=band 3 and b2=band 4.',
        },
        outputPath: { type: 'string', description: 'Output raster path.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to actually write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPath', 'expression', 'bands', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const bands = Array.isArray(args?.bands) ? args.bands.map(Number).filter(Number.isFinite) : []
      if (bands.length === 0) throw new Error('bands 不能为空')
      const inputPath = String(args?.inputPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '这个调用会写出新影像，需要 writeAllowed=true。' }
      }
      // PixelwiseBandMathRaster has no band-selection parameter: the expression
      // indexes the source bands directly as b1..bN, so only INPUT_RASTER,
      // EXPRESSION and the output URI are sent. An earlier version passed
      // BAND_INDEXES and failed with "No parameter or property name matches".
      let expression = String(args?.expression ?? '').trim()
      if (expression === '') throw new Error('expression 不能为空')
      // The caller may write B4 (uppercase, as in ENVI's own docs); the engine's
      // variable names are lower case.
      expression = expression.replace(/\bB(\d+)\b/gi, (_match, index) => `b${index}`)

      // `bands` used to be validated and then ignored, so bands:[3,4] silently
      // operated on bands 1 and 2 -- a wrong answer that looked like a right one.
      // PixelwiseBandMathRaster cannot subset, so the selection goes through
      // SubsetRaster first. Its BANDS is 0-based (verified by reading pixel
      // values: [0] returns band 1), while this tool takes 1-based numbers.
      const ascending = bands.every((band, index) => Math.trunc(band) === index + 1)
      let sourcePath = inputPath
      let scratch
      if (!ascending) {
        scratch = await scratchDir('dsh-envi-bm', scratchRoot)
        sourcePath = join(scratch, 'stack.dat')
        const stack = await invoke({
          taskName: 'SubsetRaster',
          input: {
            INPUT_RASTER: rasterParameter(inputPath),
            BANDS: bands.map((band) => Math.max(0, Math.trunc(band) - 1)),
            OUTPUT_RASTER_URI: toPosix(sourcePath),
          },
          timeoutMs: config.taskTimeoutMs,
          overwrite: true,
        })
        if (stack.status !== 'ok') {
          await rm(scratch, { recursive: true, force: true }).catch(() => {})
          return { ...stack, stage: 'select-bands' }
        }
      }
      try {
        return await invoke({
          taskName: 'PixelwiseBandMathRaster',
          input: {
            INPUT_RASTER: rasterParameter(sourcePath),
            EXPRESSION: expression,
            OUTPUT_RASTER_URI: toPosix(outputPath),
          },
          timeoutMs: config.taskTimeoutMs,
          overwrite: args?.overwrite === true,
        })
      } finally {
        if (scratch !== undefined) await rm(scratch, { recursive: true, force: true }).catch(() => {})
      }
    },
  }))

  // ---------------------------------------------------------------------
  // ROI：把"选样本点"变成可程序化的一步
  // ---------------------------------------------------------------------
  //
  // The engine is headless, so there is no mouse to click with. What "let the AI
  // pick sample points" can mean concretely is: the model decides the pixel
  // coordinates (or the spectral rule), the plugin writes a valid ENVI ROI, and
  // ENVI reads it back for statistics or training. Verified end to end.
  //
  // Two hard requirements are encoded in lib/roi.js: the geometry must be
  // <PixelDef> with a packed <SpatialRef>, and the file must end in .xml -- the
  // legacy .roi extension makes ENVI report "Unknown dataset".

  /** Read an ENVI header sidecar for the raster being sampled. */
  const readHeader = async (rasterPath) => {
    const base = String(rasterPath).replace(/\.(dat|img|tif|tiff|bsq|bil|bip)$/i, '')
    for (const candidate of [`${base}.hdr`, `${rasterPath}.hdr`]) {
      try {
        return await readFile(candidate, 'utf8')
      } catch {
        // try the next naming convention
      }
    }
    return undefined
  }

  ctx.tools.register(defineTool({
    name: 'envi_roi_create',
    description:
      'Create an ENVI ROI from explicit pixel coordinates and save it as .xml, ready for statistics or classifier training. This is how sample points get selected without a mouse: you supply the rows/columns (or let an analysis choose them), ENVI reads the ROI back. Requires writeAllowed because it writes the .xml.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: {
          type: 'string',
          description: 'Raster the ROI belongs to. Its .hdr supplies the coordinate system.',
        },
        points: {
          type: 'array',
          description:
            'Scatter mode: sample points. Objects {row, column} (or {line, sample} / {x, y}), or [row, column] pairs.',
          items: {
            oneOf: [
              { type: 'object', additionalProperties: true },
              { type: 'array', items: { type: 'number' } },
            ],
          },
        },
        vertices: {
          type: 'array',
          description:
            'Polygon mode: region outline as {row, column} corners (at least 3). The ring is closed automatically. Use this to sample a whole area rather than individual pixels.',
          items: {
            oneOf: [
              { type: 'object', additionalProperties: true },
              { type: 'array', items: { type: 'number' } },
            ],
          },
        },
        rectangle: {
          type: 'object',
          description:
            'Rectangle mode: take a grid of points inside a box. {row, column, rows, columns, step?} using 0-based top-left corner. Convenient for a dense sample block.',
          additionalProperties: true,
        },
        outputPath: {
          type: 'string',
          description: 'Destination .xml path. A .roi extension is rewritten to .xml because ENVI cannot read .roi.',
        },
        name: { type: 'string', description: 'ROI name. Default "Samples".' },
        color: {
          type: 'array',
          items: { type: 'number' },
          description: 'RGB 0-255. Default red [255,0,0].',
        },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the ROI file.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['rasterPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rasterPath = String(args?.rasterPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (rasterPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('rasterPath / outputPath 都不能为空')
      }

      // Exactly one geometry mode must be chosen, otherwise the caller's intent
      // is ambiguous and guessing would silently sample the wrong place.
      const modes = [
        Array.isArray(args?.points) && args.points.length > 0 ? 'points' : undefined,
        Array.isArray(args?.vertices) && args.vertices.length > 0 ? 'vertices' : undefined,
        args?.rectangle !== undefined && args.rectangle !== null ? 'rectangle' : undefined,
      ].filter((mode) => mode !== undefined)
      if (modes.length === 0) {
        return {
          status: 'refused',
          reason: '要给 points（散点）、vertices（多边形顶点）或 rectangle（矩形网格）三者之一。',
        }
      }
      if (modes.length > 1) {
        return {
          status: 'refused',
          reason: `points / vertices / rectangle 只能给一个，现在给了 ${modes.join(' + ')}。`,
        }
      }
      const mode = modes[0]

      let points
      if (mode === 'rectangle') {
        const box = args.rectangle
        points = rectangularGrid({
          row: box?.row ?? box?.top,
          column: box?.column ?? box?.left,
          rows: box?.rows ?? box?.height,
          columns: box?.columns ?? box?.width,
          step: box?.step ?? 1,
        })
      } else if (mode === 'vertices') {
        points = normalizePoints(args.vertices)
      } else {
        points = normalizePoints(args.points)
      }

      if (points.length === 0) {
        return {
          status: 'refused',
          reason: '没有可用的坐标。每点写成 {row, column} 或 [row, column]，行列都不能为负。',
        }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '创建 ROI 会写 .xml 文件，需要 writeAllowed=true。' }
      }
      // ENVI reads only .xml for the RegionsOfInterest format.
      const target = outputPath.replace(/\.roi$/i, '.xml')
      const header = await readHeader(rasterPath)
      if (header === undefined) {
        return {
          status: 'failed',
          reason: `找不到 ${rasterPath} 的 .hdr 头文件，无法取坐标系。像素 ROI 必须有 SpatialRef，否则 ENVI 匹配不到影像。`,
        }
      }
      const spatialRef = spatialRefFromHeader(header)
      if (spatialRef === undefined) {
        return {
          status: 'failed',
          reason: '这个栅格的头文件里没有可用的地图信息（map info），无法构造 ROI 的空间参考。',
        }
      }

      const region = mode === 'vertices'
        ? buildPolygonRegionXml({
          name: args?.name ?? 'Region',
          color: args?.color,
          projection: geometryFromHeader(header)?.projection,
          mapVertices: pixelsToMap(points, geometryFromHeader(header) ?? {}),
        })
        : buildRegionXml({
          name: args?.name ?? 'Samples',
          color: args?.color,
          spatialRef,
          coordinates: points,
        })

      await writeFile(target, buildRoiXml([region]), 'utf8')
      return {
        status: 'ok',
        roiPath: toPosix(target),
        mode,
        pointCount: points.length,
        bounds: boundsOf(points),
        note: '用 envi_roi_statistics 看光谱统计，或拿去 envi_classify_train 训练分类器。',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_roi_statistics',
    description:
      'Load an ROI file and report per-band statistics for its pixels (min/max/mean/stddev, pixel count per region). This is the fastest way to sanity-check that chosen sample points land where you expect.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: { type: 'string', description: 'Raster the ROI refers to.' },
        roiPath: { type: 'string', description: 'ROI file (.xml). A .roi path is tried as .xml too.' },
      },
      required: ['rasterPath', 'roiPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const roiPath = String(args?.roiPath ?? '')
      const rasterPath = String(args?.rasterPath ?? '')
      if (roiPath.trim() === '' || rasterPath.trim() === '') {
        throw new Error('rasterPath / roiPath 都不能为空')
      }
      const outcome = await invoke({
        taskName: 'ROIStatistics',
        input: {
          INPUT_RASTER: rasterParameter(rasterPath),
          INPUT_ROI: { FACTORY: 'URLROI', URL: toPosix(roiPath) },
        },
        timeoutMs: config.taskTimeoutMs,
      })
      if (outcome.status === 'ok') {
        outcome.summary = summarizeRoi(outcome.result)
      }
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_roi_samples',
    description:
      'Extract the training examples stored in an ROI (ENVI Examples). Note the output is ENVI\'s own serialised examples object, not a raster or CSV -- it is meant to be fed back into ENVI, and its contents cannot be read without IDL. Use envi_roi_statistics when you want the numbers. Writes the examples file, so writeAllowed is required.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: { type: 'string', description: 'Source raster.' },
        roiPath: { type: 'string', description: 'ROI file (.xml).' },
        outputPath: { type: 'string', description: 'Where to write the examples file.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the examples.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['rasterPath', 'roiPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '提取样本会写文件，需要 writeAllowed=true。' }
      }
      // Measured on ENVI 5.6 (bhdemsub.img vs bhtmref.img, identical point ROIs):
      // ExtractExamplesFromRaster fails on a single-band INT DEM with
      // "Mismatched dimensions between class values and examples", while the same
      // call on a multi-band raster succeeds. ENVI builds class values from the
      // raster's band dimension here, so a 1-band raster collapses it. Rejecting up
      // front turns a confusing engine error into an actionable message.
      const rasterPath = String(args?.rasterPath ?? '')
      const roiPath = String(args?.roiPath ?? '')
      const bandCount = await rasterBandCount(rasterPath)
      if (bandCount === 1) {
        return {
          status: 'refused',
          reason:
            'ENVI 的 ExtractExamplesFromRaster 在单波段影像上会失败（实测报 "Mismatched dimensions between class values and examples"），本机可用做法是：'
            + '改用 envi_roi_statistics 看该 ROI 的逐波段均值/方差，或先把影像堆成多波段（envi_mosaic mode=stack）再提取样本。',
          hint: 'single-band-examples-unsupported',
          bands: bandCount,
        }
      }
      // Measured on ENVI 5.6: a PixelDef ROI works, but a ThresholdDef ROI is
      // rejected with "The ROIs do not intersect the raster" even when the threshold
      // was computed from the same raster. ENVI resolves a threshold region lazily
      // against its own <Source> raster, so the ROI never materialises as pixels.
      const outcome = await invoke({
        taskName: 'ExtractExamplesFromRaster',
        input: {
          INPUT_RASTER: rasterParameter(rasterPath),
          INPUT_ROIS: { FACTORY: 'URLROI', URL: toPosix(roiPath) },
          OUTPUT_EXAMPLES_URI: toPosix(String(args?.outputPath ?? '')),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'failed' && /do not intersect the raster/i.test(String(outcome.reason ?? ''))) {
        let isThreshold = false
        try {
          isThreshold = /<ThresholdDef>/i.test(await readFile(roiPath, 'utf8'))
        } catch {
          // 读不到 ROI 原文就别改判，保留引擎原话
        }
        if (isThreshold) {
          return {
            ...outcome,
            reason:
              '这个 ROI 是阈值型（<ThresholdDef>），ENVI 的 ExtractExamplesFromRaster 只认像素型（<PixelDef>）ROI，'
              + '所以报 "The ROIs do not intersect the raster"。改用 envi_roi_create 按行列出采样点，'
              + '或用 envi_roi_statistics 直接看阈值区域的统计量。',
            hint: 'threshold-roi-unsupported-by-examples',
          }
        }
      }
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_roi_from_threshold',
    description:
      'Build an ROI from a pixel-value range on one band (e.g. everything brighter than 800). Cheaper than clicking points when the class is spectrally obvious. Writes a ROI file, so writeAllowed is required.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: { type: 'string', description: 'Source raster.' },
        outputPath: { type: 'string', description: 'Output ROI path; .xml is enforced.' },
        band: { type: 'number', description: '1-based band to threshold. Default 1.' },
        min: { type: 'number', description: 'Lower bound (inclusive). Omit for no lower limit.' },
        max: { type: 'number', description: 'Upper bound (inclusive). Omit for no upper limit.' },
        name: { type: 'string', description: 'ROI region name. Default "threshold".' },
        color: {
          type: 'array',
          items: { type: 'number' },
          description: 'RGB 0-255 for the region. Default red.',
        },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the ROI file.' },
        overwrite: { type: 'boolean', description: 'Delete an existing ROI before writing. Default false.' },
      },
      required: ['rasterPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rasterPath = String(args?.rasterPath ?? '')
      let outputPath = String(args?.outputPath ?? '')
      if (rasterPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('rasterPath / outputPath 都不能为空')
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '这个调用会写出 ROI 文件，需要 writeAllowed=true。' }
      }
      const band = Math.trunc(Number(args?.band ?? 1))
      if (!Number.isFinite(band) || band < 1) {
        return { status: 'refused', reason: 'band 必须是从 1 开始的波段号。' }
      }
      const lower = Number(args?.min)
      const upper = Number(args?.max)
      if (!Number.isFinite(lower) && !Number.isFinite(upper)) {
        return { status: 'refused', reason: 'min 和 max 至少给一个。' }
      }
      // Measured: THRESHOLD must validate as [3, *] -- exactly three elements.
      // That is [min, max, bandIndex] for ONE region, so a multi-region call
      // ("Must provide the same number of ROI names and threshold values") is not
      // possible here; call once per region. The band index is 0-based, and an
      // out-of-range index is what produced the old "Invalid band specified".
      const low = Number.isFinite(lower) ? lower : -1e38
      const high = Number.isFinite(upper) ? upper : 1e38
      const threshold = [low, high, band - 1]
      if (!/\.xml$/i.test(outputPath)) {
        outputPath = outputPath.replace(/\.[^./\\]*$/, '') + '.xml'
      }
      const name = String(args?.name ?? 'threshold').trim() || 'threshold'
      const color = normalizeColor(args?.color)
      const outcome = await invoke({
        taskName: 'ImageThresholdToROI',
        input: {
          INPUT_RASTER: rasterParameter(rasterPath),
          ROI_NAME: [name],
          ROI_COLOR: [color],
          THRESHOLD: threshold,
          OUTPUT_ROI_URI: toPosix(outputPath),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') {
        outcome.roiPath = outputPath
        outcome.summary = { band, min: threshold[0], max: threshold[1], name }
      } else if (/Invalid band specified/i.test(outcome.engineStderr ?? outcome.reason ?? '')) {
        outcome.reason = `波段 ${band} 超出影像范围。先跑 envi_raster_info 看波段数。`
      }
      return outcome
    },
  }))

  // ---------------------------------------------------------------------
  // 大气校正 / 辐射定标
  // ---------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'envi_atmospheric_correction',
    description:
      'Apply atmospheric correction to a radiance/brightness raster: QUAC (empirical, needs no metadata), IAR (internal average relative), or dark subtraction. RadiometricCalibration needs per-band gain/offset and TOA/radiance conversion.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: { type: 'string', description: 'Input raster (usually radiance).' },
        outputPath: { type: 'string', description: 'Output raster path.' },
        method: {
          type: 'string',
          description: 'quac | iar | dark-subtraction | radiometric-calibration. Default quac.',
        },
        sensor: {
          type: 'string',
          description: 'QUAC sensor profile, e.g. "Generic / Unknown Sensor", "AVIRIS". Default generic.',
        },
        calibrationType: {
          type: 'string',
          description: 'For radiometric-calibration: Radiance | Top-of-Atmosphere Reflectance | Brightness Temperature.',
        },
        darkValues: {
          type: 'array',
          items: { type: 'number' },
          description: 'For dark-subtraction: one dark level per band (required by that task).',
        },
        gain: { type: 'array', items: { type: 'number' }, description: 'For radiometric-calibration: per-band gain.' },
        offset: { type: 'array', items: { type: 'number' }, description: 'For radiometric-calibration: per-band offset.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['rasterPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rasterPath = String(args?.rasterPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (rasterPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('rasterPath / outputPath 都不能为空')
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '大气校正会写输出栅格，需要 writeAllowed=true。' }
      }
      const method = String(args?.method ?? 'quac').toLowerCase()
      const base = {
        INPUT_RASTER: rasterParameter(rasterPath),
        OUTPUT_RASTER_URI: toPosix(outputPath),
      }
      const run = (taskName, extra) => invoke({
        taskName,
        input: { ...base, ...extra },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })

      if (method === 'quac') {
        const sensor = String(args?.sensor ?? 'Generic / Unknown Sensor')
        const outcome = await run('QUAC', { SENSOR: sensor })
        if (outcome.status === 'ok') outcome.summary = { method, sensor }
        return outcome
      }
      if (method === 'iar') {
        const outcome = await run('IARReflectanceCorrection', {})
        if (outcome.status === 'ok') outcome.summary = { method }
        return outcome
      }
      if (method === 'dark-subtraction') {
        const values = Array.isArray(args?.darkValues) ? args.darkValues.map(Number) : []
        if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
          return {
            status: 'refused',
            reason: 'dark-subtraction 需要 darkValues：每个波段一个暗电平（数字数组）。',
          }
        }
        const outcome = await run('DarkSubtractionCorrection', { VALUES: values })
        if (outcome.status === 'ok') outcome.summary = { method, bands: values.length }
        return outcome
      }
      if (method === 'radiometric-calibration') {
        // RadiometricCalibration rejects a run without coefficients:
        // "Calibration requires gain and offset for each band." Say that up front
        // instead of letting the engine fail.
        const gain = Array.isArray(args?.gain) ? args.gain.map(Number) : []
        const offset = Array.isArray(args?.offset) ? args.offset.map(Number) : []
        if (gain.length === 0 || offset.length === 0) {
          return {
            status: 'refused',
            reason: 'radiometric-calibration 需要 gain 和 offset（每波段一个值）。样例数据没有定标系数，通常来自影像元数据。',
          }
        }
        if (gain.length !== offset.length) {
          return { status: 'refused', reason: `gain 和 offset 数量必须一致（收到 ${gain.length} 和 ${offset.length}）。` }
        }
        const calibrationType = String(args?.calibrationType ?? 'Radiance')
        const outcome = await run('RadiometricCalibration', {
          CALIBRATION_TYPE: calibrationType,
          GAIN: gain,
          OFFSET: offset,
        })
        if (outcome.status === 'ok') outcome.summary = { method, calibrationType, bands: gain.length }
        return outcome
      }
      return {
        status: 'refused',
        reason: 'method 只能是 quac / iar / dark-subtraction / radiometric-calibration。',
      }
    },
  }))

  // ---------------------------------------------------------------------
  // 分类
  // ---------------------------------------------------------------------
  //
  // TrainClassifier/ClassifyRaster need an ENVITRAINER and an ENVICLASSIFIER,
  // neither of which has a JSON form. The standalone statistical classifiers take
  // plain arrays that ROIStatistics already returns, so a full supervised
  // workflow runs without ever building an ENVI object.

  ctx.tools.register(defineTool({
    name: 'envi_classify',
    description:
      'Classify a raster from an ROI file. Reads per-ROI statistics, then runs the chosen classifier. Supervised: "maximum-likelihood" (MEAN+COVARIANCE), "mahalanobis" (MEAN+COVARIANCE+pixel counts), "minimum-distance" (MEAN+STDDEV), "spectral-angle" (MEAN only, tolerant of small samples). Unsupervised: "isodata" (needs no ROIs). This is the whole supervised workflow in one call. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: { type: 'string', description: 'Raster to classify.' },
        roiPath: {
          type: 'string',
          description: 'Training ROI (.xml) for the supervised classifiers. Ignored by isodata.',
        },
        classifier: {
          type: 'string',
          description: 'maximum-likelihood | mahalanobis | minimum-distance | spectral-angle | isodata. Default maximum-likelihood.',
        },
        outputPath: { type: 'string', description: 'Where to write the classification raster.' },
        numberOfClasses: {
          type: 'number',
          description: 'isodata only: how many clusters to find. Default 8.',
        },
        iterations: { type: 'number', description: 'isodata only: maximum iterations. Default 10.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output raster.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['rasterPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rasterPath = String(args?.rasterPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (rasterPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('rasterPath / outputPath 都不能为空')
      }
      const requested = args?.classifier ?? 'maximum-likelihood'
      const spec = resolveClassifier(requested)
      if (spec === undefined) {
        return {
          status: 'refused',
          reason: `没有 ${requested} 这个分类器。可选：maximum-likelihood、mahalanobis、minimum-distance、spectral-angle、isodata。`,
        }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '分类会写输出栅格，需要 writeAllowed=true。' }
      }

      if (spec.kind === 'unsupervised') {
        const outcome = await invoke({
          taskName: spec.taskName,
          input: {
            INPUT_RASTER: rasterParameter(rasterPath),
            NUMBER_OF_CLASSES: Math.max(2, Math.round(Number(args?.numberOfClasses ?? 8))),
            ITERATIONS: Math.max(1, Math.round(Number(args?.iterations ?? 10))),
            OUTPUT_RASTER_URI: toPosix(outputPath),
          },
          timeoutMs: config.taskTimeoutMs,
          overwrite: args?.overwrite === true,
        })
        if (outcome.status === 'ok') {
          outcome.summary = { classifier: spec.label, mode: 'unsupervised' }
        }
        return outcome
      }

      const roiPath = String(args?.roiPath ?? '')
      if (roiPath.trim() === '') {
        return { status: 'refused', reason: `${spec.label} 需要 roiPath 提供训练样本。` }
      }

      // Step 1: statistics per ROI. This is also what validates the ROI.
      const stats = await invoke({
        taskName: 'ROIStatistics',
        input: {
          INPUT_RASTER: rasterParameter(rasterPath),
          INPUT_ROI: { FACTORY: 'URLROI', URL: toPosix(roiPath) },
        },
        timeoutMs: config.taskTimeoutMs,
      })
      if (stats.status !== 'ok') {
        return { status: 'failed', stage: 'roi-statistics', reason: stats.reason, detail: stats }
      }

      const bandCount = Array.isArray(stats.result?.MEAN?.[0]) ? stats.result.MEAN[0].length : undefined
      const built = classifierInputsFromStatistics(stats.result, {
        classifier: spec.key,
        bandCount,
      })
      if (!built.ok) {
        return { status: 'refused', stage: 'classifier-inputs', reason: built.reason }
      }

      // Step 2: classify.
      const outcome = await invoke({
        taskName: spec.taskName,
        input: {
          INPUT_RASTER: rasterParameter(rasterPath),
          ...built.inputs,
          OUTPUT_RASTER_URI: toPosix(outputPath),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') {
        outcome.summary = {
          classifier: spec.label,
          mode: 'supervised',
          classes: built.classNames.length,
          classNames: built.classNames,
        }
      }
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_classification_cleanup',
    description:
      'Clean up a classification raster: "clump" merges adjacent same-class pixels, "sieve" drops specks below a size, "smooth" majority-filters, "aggregate" merges small regions into neighbours. Classifier output is speckled; this is the usual next step. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Classification raster.' },
        outputPath: { type: 'string', description: 'Output raster path.' },
        method: { type: 'string', description: 'clump | sieve | smooth | aggregate. Default clump.' },
        kernelSize: { type: 'number', description: 'clump/smooth only: neighbourhood size in pixels. Default 3.' },
        minimumSize: { type: 'number', description: 'sieve only: discard regions smaller than this many pixels. Default 9.' },
        aggregateSize: { type: 'number', description: 'aggregate only: minimum region size to keep. Default 9.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      const method = String(args?.method ?? 'clump').toLowerCase()
      const spec = CLASSIFICATION_CLEANUP[method]
      if (spec === undefined) {
        return { status: 'refused', reason: 'method 只能是 clump / sieve / smooth / aggregate。' }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '分类后处理会写输出栅格，需要 writeAllowed=true。' }
      }
      const kernel = Math.max(3, Math.round(Number(args?.kernelSize ?? 3)))
      const input = {
        INPUT_RASTER: rasterParameter(inputPath),
        OUTPUT_RASTER_URI: toPosix(outputPath),
      }
      // Each cleanup task names its knobs differently -- measured from the live
      // contracts, not guessed:
      //   ClassificationClumping     -> DILATE_KERNEL / ERODE_KERNEL (uint arrays)
      //   ClassificationSieving      -> MINIMUM_SIZE
      //   ClassificationSmoothing    -> KERNEL_SIZE
      //   ClassificationAggregation  -> MINIMUM_SIZE (not a factor)
      if (method === 'clump') {
        // A square struct element; ENVI wants x/y sizes as an array.
        input.DILATE_KERNEL = [kernel, kernel]
        input.ERODE_KERNEL = [kernel, kernel]
      } else if (method === 'sieve' || method === 'aggregate') {
        const size = method === 'sieve'
          ? Math.max(1, Math.round(Number(args?.minimumSize ?? 9)))
          : Math.max(1, Math.round(Number(args?.aggregateSize ?? 9)))
        input.MINIMUM_SIZE = size
      } else {
        input.KERNEL_SIZE = kernel
      }
      const outcome = await invoke({
        taskName: spec.taskName,
        input,
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') outcome.summary = { method: spec.label }
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_spectral_analysis',
    description:
      'Spectral unmixing and target detection from endmember spectra: "linear-unmixing", "matched-filter", or "mixture-tuned-matched-filter" (MTMF). Endmembers are plain arrays, so no ENVI objects are involved. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        rasterPath: { type: 'string', description: 'Input raster.' },
        outputPath: { type: 'string', description: 'Output raster path.' },
        method: {
          type: 'string',
          description: 'linear-unmixing | matched-filter | mixture-tuned-matched-filter. Default linear-unmixing.',
        },
        endmembers: {
          type: 'array',
          description: 'Endmember spectra: one array of per-band values per endmember.',
          items: { type: 'array', items: { type: 'number' } },
        },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
      },
      required: ['rasterPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const rasterPath = String(args?.rasterPath ?? '')
      const outputPath = String(args?.outputPath ?? '')
      if (rasterPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('rasterPath / outputPath 都不能为空')
      }
      const method = String(args?.method ?? 'linear-unmixing').toLowerCase()
      const spec = SPECTRAL_ANALYZERS[method]
      if (spec === undefined) {
        return {
          status: 'refused',
          reason: 'method 只能是 linear-unmixing / matched-filter / mixture-tuned-matched-filter。',
        }
      }
      const endmembers = Array.isArray(args?.endmembers) ? args.endmembers : []
      if (endmembers.length === 0) {
        return { status: 'refused', reason: '需要 endmembers：每个端元一条逐波段光谱数组。' }
      }
      if (endmembers.some((row) => !Array.isArray(row) || row.length === 0)) {
        return { status: 'refused', reason: 'endmembers 必须是二维数组，每行一个端元的光谱。' }
      }
      const width = endmembers[0].length
      if (endmembers.some((row) => row.length !== width)) {
        return { status: 'refused', reason: '所有端元的波段数必须一致。' }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '光谱分析会写输出栅格，需要 writeAllowed=true。' }
      }
      const outcome = await invoke({
        taskName: spec.taskName,
        input: {
          INPUT_RASTER: rasterParameter(rasterPath),
          ENDMEMBERS: endmembers.map((row) => row.map(Number)),
          OUTPUT_RASTER_URI: toPosix(outputPath),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') {
        outcome.summary = { method: spec.label, endmembers: endmembers.length, bands: width }
      }
      return outcome
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_classification_to_vector',
    description:
      'Vectorise a classification raster into a shapefile, polygon ROI, or pixel ROI so the classes can be measured, overlaid, or exported. Requires writeAllowed.',
    parameters: {
      type: 'object',
      properties: {
        inputPath: { type: 'string', description: 'Classification raster.' },
        outputPath: { type: 'string', description: 'Output path; suffix follows the target format.' },
        target: { type: 'string', description: 'shapefile | polygon-roi | pixel-roi. Default shapefile.' },
        writeAllowed: { type: 'boolean', description: 'Must be true to write the output.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and companions) before writing. Default false.' },
      },
      required: ['inputPath', 'outputPath'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const inputPath = String(args?.inputPath ?? '')
      let outputPath = String(args?.outputPath ?? '')
      if (inputPath.trim() === '' || outputPath.trim() === '') {
        throw new Error('inputPath / outputPath 都不能为空')
      }
      const target = String(args?.target ?? 'shapefile').toLowerCase()
      const spec = CLASSIFICATION_TO_VECTOR[target]
      if (spec === undefined) {
        return { status: 'refused', reason: 'target 只能是 shapefile / polygon-roi / pixel-roi。' }
      }
      if (args?.writeAllowed !== true) {
        return { status: 'refused', reason: '分类转矢量会写文件，需要 writeAllowed=true。' }
      }
      // ROI targets must be .xml, same rule as every other ROI path.
      if (target !== 'shapefile' && !/\.xml$/i.test(outputPath)) {
        outputPath = outputPath.replace(/\.[^./\\]*$/, '') + '.xml'
      }
      const isRoi = target !== 'shapefile'
      const outcome = await invoke({
        taskName: spec.taskName,
        input: {
          INPUT_RASTER: rasterParameter(inputPath),
          [isRoi ? 'OUTPUT_ROI_URI' : 'OUTPUT_VECTOR_URI']: toPosix(outputPath),
        },
        timeoutMs: config.taskTimeoutMs,
        overwrite: args?.overwrite === true,
      })
      if (outcome.status === 'ok') outcome.summary = { target: spec.label, outputPath }
      return outcome
    },
  }))

  // ---------------------------------------------------------------------
  // 后台执行
  // ---------------------------------------------------------------------

  ctx.tools.register(defineTool({
    name: 'envi_task_run_async',
    description:
      'Start a long ENVI task in the background and return a job id immediately. Read with envi_job, cancel with envi_job_kill. Same writeAllowed contract as envi_task_run.',
    parameters: {
      type: 'object',
      properties: {
        taskName: { type: 'string', description: 'Exact task name.' },
        parameters: { type: 'object', additionalProperties: true, description: 'Task parameters.' },
        rasterInputs: { type: 'object', additionalProperties: true, description: 'Parameter -> raster path.' },
        outputs: { type: 'object', additionalProperties: true, description: 'URI parameter -> output path.' },
        title: { type: 'string', description: 'Short label shown in listings.' },
        writeAllowed: { type: 'boolean', description: 'Required for tasks that write files.' },
        overwrite: { type: 'boolean', description: 'Delete an existing output (and its .hdr) before writing. Default false.' },
        timeoutSeconds: { type: 'number', description: 'Default 3600, max 86400.' },
      },
      required: ['taskName'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const taskName = String(args?.taskName ?? '').trim()
      if (taskName === '') throw new Error('taskName 不能为空')
      const input = {}
      for (const [key, value] of Object.entries(args?.parameters ?? {})) input[key] = value
      for (const [key, value] of Object.entries(args?.rasterInputs ?? {})) input[key] = rasterParameter(String(value))
      for (const [key, value] of Object.entries(args?.outputs ?? {})) input[key] = toPosix(String(value))
      const writes = Object.keys(input).some((key) => /_URI$|OUTPUT/i.test(key))
      if (writes && args?.writeAllowed !== true) {
        return { status: 'refused', reason: '这个任务会写文件，需要 writeAllowed=true。' }
      }
      const job = jobs.create({ title: args?.title ?? taskName, kind: 'task' })
      const timeoutMs = Math.min(86400, Math.max(10, Number(args?.timeoutSeconds) || 3600)) * 1000
      const overwrite = args?.overwrite === true
      // The store hands out an AbortController per job; passing its signal through
      // is what lets envi_job_kill actually terminate the engine process.
      const signal = jobs.controller(job.id)?.signal
      void (async () => {
        try {
          // overwrite must be forwarded here too; leaving it out made the async
          // path fail on a rerun with "输出文件已存在" even though the caller asked
          // to replace it.
          const outcome = await invoke({ taskName, input, timeoutMs, overwrite, signal })
          if (outcome.status === 'ok') jobs.finish(job.id, { result: outcome.result })
          else if (signal?.aborted !== true) jobs.fail(job.id, outcome.reason ?? '任务失败')
        } catch (error) {
          // A kill rejects the in-flight promise; that is expected, not a failure
          // to report, and the job status stays 'killed'.
          if (signal?.aborted !== true) {
            jobs.fail(job.id, error instanceof Error ? error.message : String(error))
          }
        }
      })()
      return { status: 'started', jobId: job.id, taskName }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_job',
    description:
      'Read a background ENVI task. Pass no id to list every job. With waitSeconds it blocks up to that long for the job to settle, which avoids polling in a loop.'
      + ' ENVI runs take ~5-9s plus processing time, so waiting 60s is usually enough for small scenes.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id from envi_task_run_async.' },
        waitSeconds: {
          type: 'number',
          description: 'Block until the job settles, up to this many seconds. Default 0 (return immediately). Max 600.',
        },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      if (typeof args?.id !== 'string' || args.id.trim() === '') return { jobs: jobs.list() }
      const id = args.id.trim()
      const deadline = Date.now() + Math.min(600, Math.max(0, Number(args?.waitSeconds) || 0)) * 1000
      let job = jobs.get(id)
      if (job === undefined) return { error: `没有这个作业：${id}`, jobs: jobs.list() }
      // Poll the store rather than awaiting an event: finish() and kill() are the
      // only writers, and both set a terminal status synchronously.
      while (job.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        job = jobs.get(id)
        if (job === undefined) break
      }
      if (job === undefined) return { error: `作业已结束并被回收：${id}`, jobs: jobs.list() }
      return {
        id: job.id,
        title: job.title,
        status: job.status,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        result: job.result,
        error: job.error,
        waited: job.status !== 'running',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'envi_job_kill',
    description: 'Cancel a background ENVI task.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Job id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (args) => {
      const killed = jobs.kill(String(args?.id ?? ''))
      return killed ? { status: 'killed', id: args.id } : { error: `没有正在运行的作业：${args?.id}` }
    },
  }))

  // ---------------------------------------------------------------------
  // 提示词与环境
  // ---------------------------------------------------------------------

  const prompts = ctx.get('systemPrompt')
  if (prompts !== undefined) {
    ctx.effect(() => prompts.section({ name: 'dsh-envi:reference', order: 3300, text: REFERENCE }), 'envi: reference prompt')
  }

  const shellEnv = ctx.get('shellEnv')
  if (shellEnv !== undefined) {
    ctx.effect(() => shellEnv.register({
      name: 'dsh-envi',
      variables: { DSH_ENVI_HOME: { description: 'Detected ENVI installation directory.' } },
      resolve: () => ({ DSH_ENVI_HOME: installation().enviHome ?? '' }),
    }), 'envi: shell env')
  }

  ctx.effect(() => () => jobs.killAll(), 'envi: kill jobs on dispose')
}

/** The first output URI in a task's parameters, if any. */
function outputUriOf(input) {
  if (input === null || typeof input !== 'object') return undefined
  for (const [key, value] of Object.entries(input)) {
    if (!/^OUTPUT_/.test(key)) continue
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

/**
 * First input path in `input` that points at a file which is not there.
 *
 * Only file-backed dehydrated objects and plain *_URI inputs are checked; scalars
 * and arrays are ignored. Returns undefined when everything exists.
 *
 * Relative paths are resolved against the caller's working directory, not the
 * engine's scratch directory. The engine runs with cwd set to its log folder, so
 * letting it resolve "scene.dat" both fails and reports a path the user never
 * wrote.
 */
async function findMissingInput(input, baseDir = process.cwd()) {
  if (input === null || typeof input !== 'object') return undefined
  for (const [key, value] of Object.entries(input)) {
    if (/^OUTPUT_/i.test(key)) continue
    let candidate
    if (typeof value === 'string' && /_URI$/i.test(key) && value.trim() !== '') {
      candidate = value
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const factory = String(value.FACTORY ?? '')
      if (/^URL/i.test(factory) && typeof value.URL === 'string') candidate = value.URL
    }
    if (candidate === undefined) continue
    // Skip URLs and ENVI expressions; only local paths can be tested here.
    if (/^[a-z]+:\/\//i.test(candidate)) continue
    const absolute = /^[A-Za-z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\')
      ? candidate
      : join(baseDir, candidate)
    if (!(await exists(absolute))) {
      // Report the resolved path so a relative input is not a mystery.
      return absolute === candidate ? candidate : `${candidate}（按当前目录解析为 ${absolute}）`
    }
  }
  return undefined
}

/** Bounding box of the chosen points, 1-based for human reporting. */
function boundsOf(points) {
  const rows = points.map((point) => point.row)
  const columns = points.map((point) => point.column)
  return {
    rows: [Math.min(...rows) + 1, Math.max(...rows) + 1],
    columns: [Math.min(...columns) + 1, Math.max(...columns) + 1],
  }
}

/**
 * Turn ROIStatistics output into per-region rows.
 *
 * ENVI returns parallel arrays (MEAN, STDDEV, ROI_NAMES, ROI_PIXEL_COUNT) whose
 * outer index is the region and inner index is the band. Zipping them here keeps
 * the model from having to reason about that layout on every call.
 */
function summarizeRoi(result) {
  const names = Array.isArray(result?.ROI_NAMES) ? result.ROI_NAMES : []
  const counts = Array.isArray(result?.ROI_PIXEL_COUNT) ? result.ROI_PIXEL_COUNT : []
  return names.map((name, index) => ({
    name,
    pixels: counts[index],
    mean: result.MEAN?.[index],
    min: result.MIN?.[index],
    max: result.MAX?.[index],
    stddev: result.STDDEV?.[index],
  }))
}

const REFERENCE = [
  '# ENVI 操作参考（dsh-envi）',
  '',
  '## 执行通道',
  'ENVI 自带的 IDL 8.8 是运行时虚拟机，`idl.exe -e`、批处理 `.pro`、`idlrt -e` 都不会执行代码。',
  '唯一可用的无人值守通道是 ENVI 自己的任务引擎（taskengine.exe ENVI），它接收 JSON、返回 JSON，不开窗口也不弹对话框。',
  '',
  '## 工作方式',
  '1. `envi_tasks` 找任务名（300+ 个，覆盖 ENVI 全部处理能力）。',
  '2. `envi_task_info` 查该任务的确切参数名、类型、是否必填。',
  '3. `envi_task_run` 执行。栅格输入用 {FACTORY:"URLRaster", URL:"C:/path"}；裸路径会 hydration 失败。',
  '',
  '## 常用封装（不用自己拼参数）',
  '- `envi_raster_info` 读栅格属性',
  '- `envi_raster_statistics` 算统计量',
  '- `envi_spectral_index` 算 NDVI 等指数（写盘需 writeAllowed）',
  '- `envi_subset` 裁剪子集（写盘需 writeAllowed）',
  '- `envi_band_math` 波段运算（写盘需 writeAllowed）',
  '',
  '## 约定',
  '- 输出类参数一般叫 OUTPUT_RASTER_URI / OUTPUT_REPORT_URI，用 posix 正斜杠路径。',
  '- 任何写文件的调用都需要 writeAllowed=true；缺失时工具会拒绝并说明原因。',
  '- 长任务（分类、镶嵌、深度学习训练）用 envi_task_run_async，别阻塞对话。',
  '- 任务名拼错时引擎会说 "No task matches"，用 envi_tasks 搜索确认，不要猜。',
  '- 选样本点用 envi_roi_create（给 {row, column}），别手写 ROI XML：',
  '  几何必须是 <PixelDef>、文件必须是 .xml、coordSys 不能为空，三条错一条 ENVI 就读不了。',
].join('\n')

/**
 * Every tool goes through this shaper so the model always receives JSON text
 * blocks; `render` is required by the registry and `isConcurrencySafe` false
 * keeps ENVI invocations from competing for the same license seat.
 */
function defineTool({ name: toolName, description, parameters, execute }) {
  return {
    name: toolName,
    description,
    parameters,
    async execute(args) {
      // The single choke point every tool result passes through. Two separate
      // ways a result can be rejected at the tool boundary are neutralised here
      // rather than at 26 call sites:
      //
      //   * a non-finite number (NaN/Infinity from a masked statistic), which
      //     JSON cannot represent at all;
      //   * an `undefined` property value, which JSON.stringify silently drops,
      //     leaving the parsed object with fewer keys than the live one -- DSH
      //     reads that difference as "value is not lossless JSON".
      //
      // ENVI's own parameter contracts hit the second case constantly because
      // `DEFAULT` is null for every output parameter.
      return toLosslessJson(await execute(args ?? {}))
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
      },
    },
    isConcurrencySafe: () => false,
  }
}

export { explainEngineFailure }
