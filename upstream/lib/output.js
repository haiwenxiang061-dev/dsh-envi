/**
 * Output-path handling shared by every tool that writes a dataset.
 *
 * Measured behaviour: ENVI refuses to write over an existing file and reports it
 * as `Parameter named "OUTPUT_RASTER" failed PreExecute: The output URI already
 * exists: ...`. For an assistant that may run the same command twice, that turns
 * a harmless retry into a confusing failure, so every writer goes through here.
 */
import { access, rm } from 'node:fs/promises'
import { constants } from 'node:fs'

/** True when the path exists (file or directory). */
export async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Encountered companions ENVI writes next to a dataset.
 *
 * The .hdr sidecar is the important one for rasters: leaving it behind after
 * deleting a .dat produces a header describing a raster that is not there, which
 * then fails in ways that look corrupt. Shapefiles are worse -- the .shp alone is
 * useless without .shx and .dbf, so deleting must take the whole set.
 */
export function companionsOf(outputPath) {
  const path = String(outputPath ?? '')
  if (/\.shp$/i.test(path)) {
    const base = path.slice(0, -4)
    // .qtr is written by ENVI itself (a spatial index); without it in this list a
    // rerun fails because the stray .qtr is treated as an existing output that we
    // never deleted.
    return ['.shx', '.dbf', '.prj', '.cpg', '.sbn', '.sbx', '.shp.qtr', '.shp.xml']
      .map((suffix) => `${base}${suffix}`)
  }
  // GeoJSON / KML have no sidecars; deleting the file is enough.
  if (/\.(geojson|json|kml|kmz|csv|txt|xml)$/i.test(path)) return []
  const withoutExtension = path.replace(/\.(dat|img|tif|tiff|bsq|bil|bip|envi)$/i, '')
  return [
    `${withoutExtension}.hdr`,
    `${withoutExtension}.enp`,
    `${withoutExtension}.aux.xml`,
  ]
}

/**
 * Characters Windows will not accept in a path, plus reserved device names.
 *
 * ENVI reports a write to such a path as the bare `ENVITASKFROMVIRTUALRASTER::
 * DOEXECUTE: Task execution failed.` with no hint that the filename is the
 * problem, so the check has to happen before the engine starts.
 */
const ILLEGAL_PATH = /[<>:"|?*\u0000-\u001f]/
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Empty string when the path is usable, else a sentence explaining why not. */
export function inspectOutputPath(outputPath) {
  const path = String(outputPath ?? '')
  if (path.trim() === '') return '输出路径不能为空。'
  // A colon is legal as the drive separator (C:\...), so only flag the ones after
  // the drive letter.
  const rest = /^[A-Za-z]:/.test(path) ? path.slice(2) : path
  const illegal = rest.match(ILLEGAL_PATH)
  if (illegal !== null) {
    return `输出路径含有 Windows 不允许的字符 "${illegal[0]}"：${path}。`
      + '文件名不能用 < > : " | ? * 这些字符，换一个名字再试。'
  }
  const lastSegment = path.split(/[\\/]/).pop() ?? ''
  if (RESERVED_NAME.test(lastSegment)) {
    return `"${lastSegment}" 是 Windows 保留设备名，不能作为文件名。换一个名字。`
  }
  return ''
}

/**
 * Decide what to do about an existing output.
 *
 * `overwrite: true` deletes the previous dataset (and its header) first; without
 * it the caller gets a refusal that names the exact conflict, because silently
 * overwriting someone's earlier result is worse than stopping.
 */
export async function prepareOutput(outputPath, { overwrite = false } = {}) {
  const path = String(outputPath ?? '')
  // Reject unusable names here: the engine's own error for them is unreadable.
  const problem = inspectOutputPath(path)
  if (problem !== '') return { ok: false, reason: problem }

  const present = await exists(path)
  if (!present) return { ok: true, path, removed: [] }

  if (overwrite !== true) {
    return {
      ok: false,
      reason: `输出文件已存在，ENVI 不会覆盖：${path}。换一个输出路径，或传 overwrite=true 先删除旧的。`,
      exists: true,
    }
  }

  const removed = []
  const targets = [path, ...companionsOf(path)]
  for (const target of targets) {
    try {
      await rm(target, { force: true })
      removed.push(target)
    } catch {
      // Missing companion files are expected.
    }
  }
  // Re-check: if the dataset survived the delete, writing would fail anyway.
  if (await exists(path)) {
    return {
      ok: false,
      reason: `无法删除已存在的 ${path}，它可能被其他程序占用。`,
      exists: true,
    }
  }
  return { ok: true, path, removed }
}

/**
 * Per-path lock so two in-process writers cannot interleave delete-then-write.
 *
 * Without this, four concurrent callers with overwrite:true race: A deletes, B
 * deletes, C writes, then A's post-delete existence check finds C's file and
 * refuses with "输出文件已存在" even though the caller asked to replace it.
 * Measured: 3 of 4 concurrent overwrites failed this way.
 *
 * The map is module-level so the lock spans every tool in the process. It only
 * serialises writers that target the SAME path; different paths still run fully
 * concurrent.
 */
const pathLocks = new Map()

/** Stable key for a path: Windows paths are case-insensitive. */
function lockKey(path) {
  return path.replace(/\\/g, '/').toLowerCase()
}

/**
 * Run `fn` with exclusive access to `path`.
 *
 * Chained promises rather than a queue class: each caller awaits the previous
 * holder, then releases by resolving its own gate.
 */
export async function withPathLock(path, fn) {
  const key = lockKey(path)
  const previous = pathLocks.get(key) ?? Promise.resolve()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  // The queued entry waits for our gate, so the next caller blocks until we exit.
  const queued = previous.then(() => gate)
  pathLocks.set(key, queued)
  await previous
  try {
    return await fn()
  } finally {
    release()
    // Only clear when nobody has queued behind us, so a long session cannot grow
    // the map without bound.
    if (pathLocks.get(key) === queued) pathLocks.delete(key)
  }
}

/**
 * Recognise ENVI's "already exists" failure so it can be explained rather than
 * shown raw.
 */
export function describeExistingOutput(reason, outputPath) {
  if (!/already exists/i.test(String(reason ?? ''))) return undefined
  return `输出文件已存在（${outputPath}），ENVI 不会覆盖。换路径或传 overwrite=true。`
}
