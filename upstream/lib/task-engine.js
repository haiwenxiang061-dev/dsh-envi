/**
 * Client for ENVI's own command-line task engine.
 *
 * `taskengine.exe ENVI` is the only unattended ENVI entry point that works on
 * this machine (see docs/probe-findings.md). The contract, measured:
 *
 *   stdin  -> {"schema":"envitask","taskName":"...","inputParameters":{...}}
 *   stdout -> {"outputParameters":{...}}
 *   stderr -> human readable errors; exit code 1 on failure
 *
 * Two details that are easy to get wrong and are codified here:
 *
 * 1. Raster parameters are dehydrated hashes: `{FACTORY:"URLRaster", URL:"..."}`.
 *    A bare path string fails hydration.
 * 2. The task engine writes its own IDL banner and DLM notices to the log, and
 *    its JSON result goes to stdout only. The two must not be mixed.
 *
 * Every invocation is a fresh process: no window, no dialog, no shared state.
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The task engine needs a short path: it lives under "Program Files". */
export const ENGINE_ENGINES = { envi: 'ENVI', idl: 'IDL' }

export class TaskEngineError extends Error {
  constructor(message, { exitCode, stderr, stdout } = {}) {
    super(message)
    this.name = 'TaskEngineError'
    this.exitCode = exitCode
    this.stderr = stderr
    this.stdout = stdout
  }
}

/**
 * Build the JSON document the engine reads.
 *
 * `input` values are passed through untouched so callers can supply dehydrated
 * rasters; `--compile` is handled at the argument level, not here.
 */
export function buildTaskDocument({ taskName, input = {} }) {
  return { schema: 'envitask', taskName, inputParameters: input }
}

/** A raster parameter value in the shape the engine hydrates. */
export function rasterParameter(path) {
  return { FACTORY: 'URLRaster', URL: toPosix(path) }
}

/**
 * A vector (ENVIVECTOR) parameter value.
 *
 * Dehydrates as URLVector, mirroring URLRaster; verified with
 * VectorRecordsToROI on ENVI's sample shapefile.
 */
export function vectorParameter(path) {
  return { FACTORY: 'URLVector', URL: toPosix(path) }
}

/**
 * A coordinate-system (ENVICOORDSYS) parameter value.
 *
 * A bare WKT string is rejected with "dehydrated form of type ENVICOORDSYS is a
 * Hash or List of Hashes", and the ENVICoordSys factory is not recognised. The
 * form the engine accepts is FACTORY:"CoordSys" plus COORD_SYS_STR -- verified
 * against ReprojectRaster.
 */
export function coordSysParameter(wkt) {
  return { FACTORY: 'CoordSys', COORD_SYS_STR: String(wkt ?? '') }
}

/** A URI output parameter (report files, exported vectors, ...). */
export function uriParameter(path) {
  return toPosix(path)
}

export function toPosix(path) {
  return String(path ?? '').replace(/\\/g, '/')
}

/**
 * Replace values JSON cannot carry with something it can.
 *
 * Real statistics over a masked raster produce `NaN` (every pixel nodata),
 * `Infinity` (divide-by-zero in a ratio) and `null` gaps. Two separate failures
 * come out of that, and both are fixed around this function:
 *
 * 1. ENVI writes those literals into its stdout JSON. `JSON.parse` rejects them
 *    -- they are a JSON5 extension, not JSON -- so the ENTIRE payload was
 *    discarded and every statistics call on a real scene failed with
 *    "value is not lossless JSON" while the engine had actually succeeded.
 *    `reviveNonFinite` below turns the literals back into real numbers before
 *    parsing.
 * 2. The tool boundary demands lossless JSON, so even a parsed `NaN` cannot be
 *    returned. This function maps it to `null`.
 *
 * A second, unrelated loss comes from ordinary object building: assigning
 * `undefined` to a property puts the key on the object, `JSON.stringify` drops
 * it, and the parsed key count no longer matches the live one. That is the same
 * "value is not lossless JSON" rejection, and it fired on every ENVI parameter
 * contract because `DEFAULT` is null for all OUTPUT parameters. Undefined object
 * values are therefore dropped rather than nulled.
 *
 * Non-finite numbers become `null` rather than 0: 0 is a plausible measurement
 * and would silently poison a downstream threshold, while `null` reads as
 * "unknown". BigInt is stringified because it only appears in byte counts.
 */
export function toLosslessJson(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(toLosslessJson)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      // Drop undefined-valued keys instead of turning them into null: the key
      // was never meaningfully present, and keeping it as null would claim a
      // measurement of "unknown" where the caller simply omitted it. Dropping
      // also matches what JSON.stringify would do, so the serialized object
      // keeps the same key count and the boundary accepts it.
      if (item === undefined) continue
      out[key] = toLosslessJson(item)
    }
    return out
  }
  // A bare undefined/function/symbol has no JSON form. It only reaches here as an
  // array element (object keys are dropped above), where it must become null to
  // keep the array length -- an array that shrinks is lossy in exactly the way
  // the boundary rejects.
  return value === undefined ? null : value
}

/**
 * Rewrite the bare `NaN` / `Infinity` / `-Infinity` literals ENVI emits into
 * values `JSON.parse` accepts.
 *
 * Done by walking the text and tracking whether the cursor is inside a string,
 * not by a bare regex: this JSON carries file paths, and a path like
 * `C:/NaN/x.dat` must survive untouched. Only an unquoted, value-position
 * literal is rewritten.
 */
export function reviveNonFinite(text) {
  let out = ''
  let inString = false
  let escaped = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    // Unquoted position: try the non-finite literals in longest-first order.
    for (const literal of ['-Infinity', 'Infinity', 'NaN']) {
      if (text.startsWith(literal, i)) {
        const before = text[i - 1]
        const after = text[i + literal.length]
        // A literal must stand alone: punctuation or whitespace around it.
        const bounded = (before === undefined || /[\s:,[{]/.test(before))
          && (after === undefined || /[\s,}\]]/.test(after))
        if (bounded) {
          out += literal === 'NaN' ? 'null' : literal === '-Infinity' ? '-1e999' : '1e999'
          i += literal.length
          break
        }
      }
    }
    if (i < text.length && !['-Infinity', 'Infinity', 'NaN'].some((l) => text.startsWith(l, i))) {
      out += text[i]
      i += 1
    }
  }
  return out
}

/**
 * Split engine output into the JSON result and the diagnostics worth showing.
 *
 * The engine prints exactly one JSON object on stdout. Anything else that lands
 * there is a problem worth surfacing rather than silently discarding.
 */
export function parseEngineOutput({ stdout, stderr, exitCode }) {
  const text = String(stdout ?? '').trim()
  let parsed
  let parseError
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // ENVI's non-finite literals are the common cause; retry once with them
      // neutralised before reporting the original error.
      try {
        parsed = JSON.parse(reviveNonFinite(text))
      } catch {
        parseError = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return {
    ok: exitCode === 0 && parsed !== undefined,
    exitCode,
    result: parsed?.outputParameters === undefined ? undefined : toLosslessJson(parsed.outputParameters),
    parseError,
    diagnostics: String(stderr ?? '').trim(),
    raw: text,
  }
}

/**
 * Turn engine stderr into one actionable sentence.
 *
 * These messages come from ENVI and are precise; paraphrasing them would lose
 * the one detail that identifies the fix. The full engine text is always kept
 * on the tool result as `engineStderr`, so the model can read the original.
 */
export function explainEngineFailure({ stderr, parseError, exitCode }) {
  const text = String(stderr ?? '').trim()
  if (/No task matches/i.test(text)) {
    return `ENVI 没有这个任务。先用 envi_tasks 搜索确认任务名，不要猜。（原文：${firstLine(text)}）`
  }
  if (/Required parameter has no VALUE/i.test(text)) {
    return `缺少必填参数。用 envi_task_info 查看该任务的必填输入。（原文：${firstLine(text)}）`
  }
  // "File does not exist" also arrives wrapped in a "failed hydration" message,
  // so it has to be checked BEFORE the format branch -- otherwise a missing file
  // is reported as a malformed parameter and the caller edits the wrong thing.
  if (/does not exist|No such file|cannot be found/i.test(text)) {
    const path = (text.match(/([A-Za-z]:[\\/][^"\n]*?)(?=\s+File does not exist|\s*$)/) ?? [])[1]
    const where = path === undefined ? '' : ` 找不到：${path.trim()}`
    return `文件不存在。${where}（原文：${firstLine(text)}）`
  }
  if (/failed hydration/i.test(text)) {
    // Hydration failures mean different things per type, and guessing "raster"
    // for a coordinate-system failure sends the caller down the wrong path. The
    // parameter name is in the message, so the advice follows it.
    if (/ENVICOORDSYS|Coordinate System String/i.test(text)) {
      return `坐标系参数格式不对。COORD_SYS 要写成 {FACTORY:"CoordSys", COORD_SYS_STR:"<WKT>"} 或 {FACTORY:"CoordSys", COORD_SYS_CODE:32613}；裸字符串和 "EPSG:32613" 都会被拒绝。（原文：${firstLine(text)}）`
    }
    if (/ENVIVECTOR|URLVECTOR/i.test(text)) {
      return `矢量参数格式不对。必须是 {FACTORY:"URLVector", URL:"C:/path/file.shp"}，文件要真实存在。（原文：${firstLine(text)}）`
    }
    if (/ENVIROI|URLROI/i.test(text)) {
      return `ROI 参数格式不对。必须是 {FACTORY:"URLROI", URL:"C:/path/file.xml"}，且文件后缀要 .xml。（原文：${firstLine(text)}）`
    }
    return `参数格式不对。栅格参数必须是 {FACTORY:"URLRaster", URL:"..."} 形式，不是裸路径。（原文：${firstLine(text)}）`
  }
  if (/No parameter name matches|No parameter or property name matches/i.test(text)) {
    return `参数名不存在。用 envi_task_info 确认确切键名。（原文：${firstLine(text)}）`
  }
  if (/not a valid IDL enviTask object|Invalid task definition/i.test(text)) {
    return `任务定义无效（自定义任务需要 ENVI 任务基类，不能用 IDLTaskFromProcedure）。（原文：${firstLine(text)}）`
  }
  if (/license/i.test(text)) {
    return `许可证问题，ENVI 没有拿到 license。（原文：${firstLine(text)}）`
  }
  if (parseError !== undefined) {
    return `引擎输出不是合法 JSON（${parseError}）。`
  }
  if (text !== '') return firstLine(text)
  return `引擎以退出码 ${exitCode} 结束但没有输出。`
}

function firstLine(text) {
  return String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? ''
}

/**
 * Run one task and return its parsed output.
 *
 * `wrapper` is optional: because the engine requires a short path that keeps
 * source and script in sync, the caller may pass a function that builds the
 * exact argv for the platform.
 */
export async function runTask({
  engine,
  enginePath,
  taskName,
  input,
  compile = false,
  timeoutMs = 900000,
  logPath,
  cwd,
  env,
  spawn: spawnImpl = spawn,
  signal,
}) {
  const startedAt = Date.now()
  const document = JSON.stringify(buildTaskDocument({ taskName, input }))
  const args = [ENGINE_ENGINES[engine] ?? 'ENVI']
  if (compile) args.unshift('--compile')
  if (typeof logPath === 'string' && logPath !== '') args.unshift(`--log=${logPath}`)

  const outcome = await spawnCapture({
    command: enginePath,
    args,
    stdin: document,
    timeoutMs,
    cwd,
    env,
    spawn: spawnImpl,
    signal,
  })

  const parsed = parseEngineOutput(outcome)
  const seconds = Math.round((timeoutMs ?? 0) / 1000)
  return {
    ...parsed,
    elapsedMs: Date.now() - startedAt,
    args,
    document,
    timedOut: outcome.timedOut === true,
    // explainEngineFailure reads `stderr`; parseEngineOutput calls it
    // `diagnostics`. Bridge the two names explicitly rather than relying on a
    // spread, so a rename cannot silently downgrade every error to a generic one.
    failure: parsed.ok
      ? undefined
      // A killed engine exits with a null code and no output, which otherwise
      // reads as "引擎以退出码 null 结束但没有输出" -- true but useless. Timeout is
      // its own outcome and must say so, with the knobs to raise.
      : (outcome.timedOut === true
        ? `任务超时（${seconds} 秒）后被终止，进程已清理。大影像的镶嵌/分类/大气校正需要更长时间：` +
          `调大 timeoutSeconds，或用 envi_task_run_async 放到后台跑。`
        : explainEngineFailure({
          stderr: parsed.diagnostics,
          parseError: parsed.parseError,
          exitCode: parsed.exitCode,
        })),
  }
}

/** Spawn, feed stdin, collect streams, enforce a timeout. */
async function spawnCapture({ command, args, stdin, timeoutMs, cwd, env, spawn: spawnImpl, signal }) {
  let child
  try {
    child = spawnImpl(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    return { stdout: '', stderr: error instanceof Error ? error.message : String(error), exitCode: null }
  }

  const out = []
  const err = []
  child.stdout?.on('data', (chunk) => out.push(String(chunk)))
  child.stderr?.on('data', (chunk) => err.push(String(chunk)))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, Math.max(1000, Number(timeoutMs) || 900000))
  timer.unref?.()
  const onAbort = () => child.kill()
  signal?.addEventListener('abort', onAbort, { once: true })

  // The engine reads the whole document from stdin and only then starts work.
  if (child.stdin !== null && child.stdin !== undefined) {
    child.stdin.on('error', () => {
      // A fast failure closes the pipe before the write completes; the exit code
      // and stderr already describe what happened.
    })
    child.stdin.end(stdin)
  }

  const settled = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, error }))
    child.once('close', (code) => resolve({ code }))
  })
  clearTimeout(timer)
  signal?.removeEventListener('abort', onAbort)

  return {
    stdout: out.join(''),
    stderr: err.join('') || (settled?.error instanceof Error ? settled.error.message : ''),
    exitCode: settled?.code ?? null,
    timedOut,
  }
}

/**
 * Scratch directory for one engine invocation's logs.
 *
 * The engine can only write its IDL log to a real file, so each run needs one.
 * `root` lets the caller keep them on a chosen drive (F:\workspace on this
 * machine) instead of the system temp folder, which is often on a small C:.
 * Callers are responsible for removing the directory when the run ends; see
 * `pruneScratch` for the belt-and-braces sweep.
 */
export async function scratchDir(prefix = 'dsh-envi', root) {
  const base = typeof root === 'string' && root.trim() !== '' ? root.trim() : tmpdir()
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, `${prefix}-`))
}

/**
 * Delete scratch directories older than `maxAgeMs`.
 *
 * Runs are removed individually, but a killed process or a crash leaves one
 * behind. Sweeping on each call keeps the workspace from filling with logs the
 * user never asked for.
 */
export async function pruneScratch(root, maxAgeMs = 6 * 60 * 60 * 1000) {
  if (typeof root !== 'string' || root.trim() === '') return 0
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-envi')) continue
    const path = join(root, entry.name)
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      // Raced with another run or already gone.
    }
  }
  return removed
}

export { readFile, rm, writeFile }
