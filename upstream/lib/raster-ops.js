/**
 * Raster operations that need more than a single path.
 *
 * The important discovery here is that `ENVIRASTERARRAY` dehydrates as a *plain
 * array of raster hashes* -- `[{FACTORY:'URLRaster',URL:...}, ...]`. That single
 * fact unlocks mosaicking and layer stacking, which otherwise look like they need
 * an ENVI object collection. Verified with BuildMosaicRaster on two subsets.
 */

/** Wrap a bare path, leaving an already-dehydrated raster alone. */
export function toRasterArray(paths) {
  if (!Array.isArray(paths)) return []
  return paths
    .map((entry) => {
      if (typeof entry === 'string') {
        const trimmed = entry.trim()
        return trimmed === '' ? undefined : { FACTORY: 'URLRaster', URL: toPosixPath(trimmed) }
      }
      if (entry !== null && typeof entry === 'object' && entry.FACTORY !== undefined) return entry
      return undefined
    })
    .filter((entry) => entry !== undefined)
}

export function toPosixPath(value) {
  return String(value ?? '').replace(/\\/g, '/')
}

/**
 * Validate a `SUB_RECT`.
 *
 * ENVI wants `[x1, y1, x2, y2]` in 0-based pixel coordinates, inclusive. A
 * reversed or out-of-bounds rectangle does not always fail loudly -- it can
 * produce an empty or transposed output -- so the bounds are checked against the
 * raster dimensions when they are known.
 */
export function normalizeSubRect(rect, { samples, lines } = {}) {
  if (!Array.isArray(rect) || rect.length !== 4) {
    return { ok: false, reason: 'SUB_RECT 必须是 4 个数：[x1, y1, x2, y2]（0 起始，含端点）。' }
  }
  const values = rect.map((value) => Number(value))
  if (values.some((value) => !Number.isFinite(value))) {
    return { ok: false, reason: 'SUB_RECT 里必须都是数字。' }
  }
  let [x1, y1, x2, y2] = values.map((value) => Math.round(value))
  if (x2 < x1 || y2 < y1) {
    // Tolerate a corner-order mix-up rather than silently cropping nothing.
    const fixedX = [Math.min(x1, x2), Math.max(x1, x2)]
    const fixedY = [Math.min(y1, y2), Math.max(y1, y2)]
    ;[x1, x2] = fixedX
    ;[y1, y2] = fixedY
  }
  if (x1 < 0 || y1 < 0) {
    return { ok: false, reason: 'SUB_RECT 的左上角不能是负数。' }
  }
  if (Number.isFinite(samples) && x2 > samples - 1) {
    return { ok: false, reason: `SUB_RECT 的 x2=${x2} 超出影像宽度（0..${samples - 1}）。` }
  }
  if (Number.isFinite(lines) && y2 > lines - 1) {
    return { ok: false, reason: `SUB_RECT 的 y2=${y2} 超出影像高度（0..${lines - 1}）。` }
  }
  return { ok: true, rect: [x1, y1, x2, y2] }
}

/**
 * Resolve a resampling keyword.
 *
 * The accepted strings differ per task ("Cubic" vs "Cubic Convolution"), so the
 * caller's loose word is mapped to whatever that task documents.
 */
export function normalizeResampling(value, { allowCubicConvolution = true } = {}) {
  const key = String(value ?? '').trim().toLowerCase().replace(/[_\s]+/g, ' ')
  if (key === '' || key === 'nearest' || key === 'nearest neighbor') return 'Nearest Neighbor'
  if (key === 'bilinear') return 'Bilinear'
  if (key === 'cubic' || key === 'cubic convolution') {
    return allowCubicConvolution ? 'Cubic Convolution' : 'Cubic'
  }
  return undefined
}

/** `[samples, lines]` for DimensionsResampleRaster. */
export function normalizeDimensions(dimensions) {
  if (!Array.isArray(dimensions) || dimensions.length !== 2) {
    return { ok: false, reason: 'dimensions 必须是 [列数, 行数]。' }
  }
  const [columns, rows] = dimensions.map((value) => Math.round(Number(value)))
  if (!Number.isFinite(columns) || !Number.isFinite(rows) || columns < 1 || rows < 1) {
    return { ok: false, reason: 'dimensions 必须是两个正整数。' }
  }
  return { ok: true, dimensions: [columns, rows] }
}

/** `[x, y]` pixel size in map units for PixelScaleResampleRaster. */
export function normalizePixelScale(scale) {
  if (!Array.isArray(scale) || scale.length !== 2) {
    return { ok: false, reason: 'pixelScale 必须是 [xSize, ySize]。' }
  }
  const [x, y] = scale.map((value) => Number(value))
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
    return { ok: false, reason: 'pixelScale 必须是两个正数。' }
  }
  return { ok: true, pixelScale: [x, y] }
}

/**
 * Band numbers as ENVI expects them: 1-based.
 *
 * Models routinely pass 0-based indices. Accept them but shift consistently, since
 * asking for band 0 is out of range and would otherwise fail confusingly.
 */
export function normalizeBands(bands, { bandCount } = {}) {
  if (!Array.isArray(bands) || bands.length === 0) {
    return { ok: false, reason: 'bands 不能为空。' }
  }
  const numbers = bands.map((value) => Math.round(Number(value)))
  if (numbers.some((value) => !Number.isFinite(value))) {
    return { ok: false, reason: 'bands 里必须都是数字。' }
  }
  const zeroBased = numbers.includes(0)
  const shifted = zeroBased ? numbers.map((value) => value + 1) : numbers
  if (shifted.some((value) => value < 1)) {
    return { ok: false, reason: 'bands 必须从 1 开始（或整体从 0 开始的索引）。' }
  }
  if (Number.isFinite(bandCount) && shifted.some((value) => value > bandCount)) {
    return { ok: false, reason: `bands 超出了影像波段数（1..${bandCount}）。` }
  }
  return { ok: true, bands: shifted }
}
