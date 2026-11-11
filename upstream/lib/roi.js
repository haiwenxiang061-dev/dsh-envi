/**
 * ROI files for ENVI 5.x.
 *
 * Two facts were measured, and both are load-bearing (docs/probe-findings.md):
 *
 * 1. A pixel ROI must use `<PixelDef><SpatialRef>...</SpatialRef></PixelDef>`.
 *    Writing `<GeometryDef><CoordSysStr>` instead makes ENVI interpret the
 *    numbers as map coordinates, which then fail to match the raster.
 * 2. The file MUST end in `.xml`. The legacy `.roi` extension yields
 *    "ENVIURLROI: Unknown dataset" even for byte-identical content.
 *
 * Coordinates are `row column` pairs on one line -- ENVI's own sample files use
 * that order, and verified statistics confirm it.
 */

/**
 * Build the `<SpatialRef>` body from a raster's ENVI header.
 *
 * ENVI stores this as a single packed string, so it must be reproduced exactly:
 * `coordSys={...} tiePoint=x,y,mapx,mapy pixelSize=sx,sy dims=cols,rows rotation=r`
 */
export function buildSpatialRef({ coordinateSystemString, tiePoint, pixelSize, dims, rotation = '0' }) {
  if (typeof coordinateSystemString !== 'string' || coordinateSystemString.trim() === '') return undefined
  if (!Array.isArray(tiePoint) || tiePoint.length < 4) return undefined
  if (!Array.isArray(pixelSize) || pixelSize.length < 2) return undefined
  if (!Array.isArray(dims) || dims.length < 2) return undefined
  const ref = [
    `coordSys={${coordinateSystemString.trim()}}`,
    `tiePoint=${tiePoint.join(',')}`,
    `pixelSize=${pixelSize.join(',')}`,
    `dims=${dims.join(',')}`,
    `rotation=${rotation}`,
  ]
  return ref.join(' ')
}

/** One `<Region>` with a point/pixel geometry. */
export function buildRegionXml({ name, color = [255, 0, 0], spatialRef, coordinates }) {
  const points = normalizePoints(coordinates)
  if (points.length === 0) throw new Error('ROI 至少需要一个点')
  const coordText = points.map((point) => `${point.row} ${point.column}`).join(' ')
  return [
    `  <Region name="${escapeXml(name)}" color="${normalizeColor(color).join(',')}">`,
    '    <PixelDef>',
    `      <SpatialRef>${escapeXml(spatialRef)}</SpatialRef>`,
    '      <Coordinates>',
    coordText,
    '      </Coordinates>',
    '    </PixelDef>',
    '  </Region>',
  ].join('\n')
}

/** The complete document. */
export function buildRoiXml(regions) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<RegionsOfInterest version="1.0">',
    ...regions,
    '</RegionsOfInterest>',
    '',
  ].join('\n')
}

/**
 * One `<Region>` holding a polygon, written the way ENVI itself writes polygons.
 *
 * Measured difference from a point ROI: polygons use `<GeometryDef><CoordSysStr>`
 * plus `<Polygon><Exterior><LinearRing>`, and their coordinates are **map**
 * coordinates (metres), not pixel indices. Writing a polygon as `PixelDef` makes
 * ENVI read the vertices as isolated pixels -- a 40x40 box collapsed to 4 samples.
 *
 * `projection` is the bare WKT string (no `{}` wrapper, no SpatialRef packing).
 */
export function buildPolygonRegionXml({ name, color = [255, 0, 0], projection, vertices, mapVertices }) {
  const ring = closeRing(Array.isArray(mapVertices) ? mapVertices : [])
  if (ring.length < 4) throw new Error('多边形 ROI 至少需要 3 个顶点')
  const coordText = ring.map((point) => `${formatMap(point.x)} ${formatMap(point.y)}`).join(' ')
  void vertices
  return [
    `  <Region name="${escapeXml(name)}" color="${normalizeColor(color).join(',')}">`,
    '    <GeometryDef>',
    `      <CoordSysStr>${escapeXml(projection)}</CoordSysStr>`,
    '      <Polygon>',
    '        <Exterior>',
    '          <LinearRing>',
    '            <Coordinates>',
    coordText,
    '            </Coordinates>',
    '          </LinearRing>',
    '        </Exterior>',
    '      </Polygon>',
    '    </GeometryDef>',
    '  </Region>',
  ].join('\n')
}

/**
 * Convert pixel indices to map coordinates using the header's tie point.
 *
 * ENVI's `map info` tie point is 1-based on the pixel coordinate but the offset
 * maths is linear, so `map = mapOrigin + (pixel - tiePixel) * pixelSize`.
 * Both the tie point and the pixel size come straight from the .hdr, which keeps
 * the polygon aligned with the raster it belongs to.
 */
export function pixelsToMap(points, geometry) {
  const {
    tiePixelRow, tiePixelColumn, mapX, mapY, pixelSizeX, pixelSizeY,
  } = geometry
  return points.map((point) => ({
    x: mapX + (point.column - tiePixelColumn) * pixelSizeX,
    y: mapY - (point.row - tiePixelRow) * pixelSizeY,
  }))
}

/** Keep enough digits that sub-pixel differences survive, without noise. */
function formatMap(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return String(Math.round(number * 1e8) / 1e8)
}

/**
 * Parse the geometry numbers needed for pixel->map conversion out of a header.
 *
 * Unlike `spatialRefFromHeader` this returns the individual pieces, because a
 * polygon needs the bare WKT plus the tie point rather than one packed string.
 */
export function geometryFromHeader(headerText) {
  const text = String(headerText ?? '')
  const mapInfo = extractBraced(text, 'map info')
  if (mapInfo === undefined) return undefined
  const parts = mapInfo.split(',').map((part) => part.trim())
  if (parts.length < 7) return undefined
  const numbers = parts.slice(1, 7).map((part) => Number(part))
  if (numbers.some((value) => !Number.isFinite(value))) return undefined
  const projection =
    extractBraced(text, 'coordinate system string') ?? coordinateSystemFromMapInfo(parts)
  if (projection === undefined) return undefined
  return {
    projection,
    tiePixelColumn: numbers[0],
    tiePixelRow: numbers[1],
    mapX: numbers[2],
    mapY: numbers[3],
    pixelSizeX: numbers[4],
    pixelSizeY: numbers[5],
  }
}

/** Repeat the first vertex when the caller left the ring open. */
export function closeRing(points) {
  if (points.length === 0) return points
  const first = points[0]
  const last = points[points.length - 1]
  // Points may be {row, column} (pixel) or {x, y} (map); close whichever it is.
  const isMap = first.x !== undefined && first.y !== undefined
  const sameFirst = isMap
    ? first.x === last.x && first.y === last.y
    : first.row === last.row && first.column === last.column
  if (sameFirst) return points
  return [...points, { ...first }]
}

/**
 * Points inside a rectangle, as a grid.
 *
 * Handy when a model wants a block of samples rather than a scatter: "take a
 * 5x5 block centred here". Returns every cell, so the caller controls density.
 */
export function rectangularGrid({ row, column, rows, columns, step = 1 }) {
  const out = []
  const height = Math.max(1, Math.round(Number(rows) || 1))
  const width = Math.max(1, Math.round(Number(columns) || 1))
  const stride = Math.max(1, Math.round(Number(step) || 1))
  for (let r = 0; r < height; r += stride) {
    for (let c = 0; c < width; c += stride) {
      out.push({ row: Number(row) + r, column: Number(column) + c })
    }
  }
  return out
}

/**
 * Accept the shapes a caller is likely to produce and return `{row, column}`.
 *
 * Supports `{row, column}`, `{line, sample}`, `[row, column]`, and `[column, row]`
 * via an explicit flag. Getting this backwards silently produces samples from the
 * wrong place, so the ambiguous 2-element array requires `order: 'xy'`.
 */
export function normalizePoints(input, { order = 'row-column' } = {}) {
  if (!Array.isArray(input)) return []
  const points = []
  for (const item of input) {
    if (item === null || item === undefined) continue
    if (Array.isArray(item)) {
      const a = Number(item[0])
      const b = Number(item[1])
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      points.push(order === 'xy' ? { row: b, column: a } : { row: a, column: b })
      continue
    }
    if (typeof item === 'object') {
      const row = Number(item.row ?? item.line ?? item.y)
      const column = Number(item.column ?? item.col ?? item.sample ?? item.x)
      if (!Number.isFinite(row) || !Number.isFinite(column)) continue
      points.push({ row, column })
    }
  }
  return points.map((point) => ({
    row: Math.max(0, Math.round(point.row)),
    column: Math.max(0, Math.round(point.column)),
  }))
}

/**
 * Clamp an RGB triple into 0-255 bytes.
 *
 * Exported because the threshold ROI path needs the same coercion and a second
 * copy would drift from this one.
 */
export function normalizeColor(color) {
  const values = Array.isArray(color) ? color : [255, 0, 0]
  const out = [0, 0, 0]
  for (let index = 0; index < 3; index += 1) {
    const value = Number(values[index])
    out[index] = Number.isFinite(value) ? Math.min(255, Math.max(0, Math.round(value))) : 255
  }
  return out
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Parse `map info` and (when present) `coordinate system string` out of an ENVI
 * .hdr file.
 *
 * A coordinate system string is mandatory: an empty `coordSys={}` makes ENVI fail
 * with "Failed to create Coordinate System from string" (measured). The QuickBird
 * sample carries only `map info`, so the projection is reconstructed from it.
 */
export function spatialRefFromHeader(headerText) {
  const text = String(headerText ?? '')
  const mapInfo = extractBraced(text, 'map info')
  if (mapInfo === undefined) return undefined
  const parts = mapInfo.split(',').map((part) => part.trim())
  // {UTM, x, y, mapx, mapy, psx, psy, zone, hemisphere, datum, units}
  if (parts.length < 7) return undefined
  const tiePoint = [
    trimNumber(parts[1]),
    trimNumber(parts[2]),
    trimNumber(parts[3]),
    trimNumber(parts[4]),
  ]
  const pixelSize = [trimNumber(parts[5]), trimNumber(parts[6])]
  const dims = extractDims(text)
  if (dims === undefined) return undefined
  const projection =
    extractBraced(text, 'coordinate system string') ?? coordinateSystemFromMapInfo(parts)
  if (projection === undefined) return undefined
  return buildSpatialRef({
    coordinateSystemString: projection,
    tiePoint,
    pixelSize,
    dims,
    rotation: '0',
  })
}

/**
 * Reconstruct a WKT projection from `map info`.
 *
 * Only UTM is derived here because that is what the header guarantees: the zone,
 * hemisphere and datum are all present. Anything else returns undefined rather
 * than guessing, since a wrong projection silently places pixels off the image.
 */
function coordinateSystemFromMapInfo(parts) {
  const projection = String(parts[0] ?? '').toUpperCase()
  if (projection !== 'UTM') return undefined
  const zone = Number(parts[7])
  const hemisphere = String(parts[8] ?? '').toUpperCase()
  // ENVI's UTM `map info` ends either with a datum name or with `units=Meters`.
  // Measured on bhtmref.hdr: {UTM, 1, 1, ..., 13, North, units=Meters} -- parts[9]
  // is the unit, not a datum. The old code uppercased the whole "units=Meters"
  // string, missed the ellipsoid table, and returned undefined, so an ordinary UTM
  // scene could not produce a spatial reference and ROI creation failed outright.
  // A datum-looking part[9] wins; otherwise fall back to WGS-84, which is what ENVI
  // itself assumes for a UTM header that omits the datum.
  const declared = String(parts[9] ?? '').trim()
  const datum = declared === '' || /^units?=/i.test(declared) ? 'WGS84' : declared
  if (!Number.isInteger(zone) || zone < 1 || zone > 60) return undefined
  if (hemisphere !== 'NORTH' && hemisphere !== 'SOUTH') return undefined
  const ellipsoid = ellipsoidFor(datum)
  if (ellipsoid === undefined) return undefined
  const centralMeridian = zone * 6 - 183
  return (
    `PROJCS["UTM_Zone_${zone}${hemisphere === 'NORTH' ? 'N' : 'S'}",` +
    `GEOGCS["GCS_${ellipsoid.name}",DATUM["D_${ellipsoid.name}",SPHEROID["${ellipsoid.name}",${ellipsoid.radius},${ellipsoid.flattening}]],` +
    'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],' +
    'PROJECTION["Transverse_Mercator"],' +
    `PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",${hemisphere === 'NORTH' ? '0.0' : '10000000.0'}],` +
    `PARAMETER["Central_Meridian",${centralMeridian}.0],` +
    'PARAMETER["Scale_Factor",0.9996],' +
    `PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]`
  )
}

/** The datum spellings that actually appear in ENVI headers. */
function ellipsoidFor(datum) {
  const key = datum.replace(/[\s_-]/g, '')
  const table = {
    'WGS84': { name: 'WGS_1984', radius: '6378137.0', flattening: '298.257223563' },
    'WGS1984': { name: 'WGS_1984', radius: '6378137.0', flattening: '298.257223563' },
    'NAD83': { name: 'North_American_1983', radius: '6378137.0', flattening: '298.257222101' },
    'NAD27': { name: 'North_American_1927', radius: '6378206.4', flattening: '294.9786982' },
  }
  return table[key]
}

/** Read a `{...}` ENVI header field, tolerating multi-line values. */
function extractBraced(text, key) {
  const pattern = new RegExp(`${key}\\s*=\\s*\\{([\\s\\S]*?)\\}`, 'i')
  const match = pattern.exec(text)
  if (match === null) return undefined
  return match[1].replace(/\s*\n\s*/g, ' ').trim()
}

/** ENVI headers write `samples = 1024` and `lines = 1024`. */
function extractDims(text) {
  const samples = /samples\s*=\s*(\d+)/i.exec(text)
  const lines = /lines\s*=\s*(\d+)/i.exec(text)
  if (samples === null || lines === null) return undefined
  return [Number(samples[1]), Number(lines[1])]
}

function trimNumber(value) {
  const trimmed = String(value ?? '').trim()
  const number = Number(trimmed)
  if (!Number.isFinite(number)) return trimmed
  // Keep ENVI's own float style: integers stay integers, fractions keep digits.
  return Number.isInteger(number) ? String(number) : String(number)
}
