/**
 * Supervised and unsupervised classification without ENVI's object graph.
 *
 * The obvious route -- `TrainClassifier` + `ClassifyRaster` -- requires an
 * `ENVITRAINER` and an `ENVICLASSIFIER`, both of which are opaque objects with no
 * JSON form. The standalone classifiers sidestep that entirely: they take plain
 * numeric arrays that `ROIStatistics` already produces.
 *
 *   MaximumLikelihood : MEAN[nClasses][nBands] + COVARIANCE[nClasses][nBands][nBands]
 *   MinimumDistance   : MEAN[nClasses][nBands] + STDDEV[nClasses][nBands]
 *
 * Both verified end to end against qb_boulder_msi.
 */

/** Classifiers that can be driven from statistics alone. */
export const STATISTICAL_CLASSIFIERS = {
  'maximum-likelihood': {
    taskName: 'MaximumLikelihoodClassification',
    label: '最大似然（Maximum Likelihood）',
    needsCovariance: true,
    needsPixelCount: false,
  },
  'minimum-distance': {
    taskName: 'MinimumDistanceClassification',
    label: '最小距离（Minimum Distance）',
    needsCovariance: false,
    needsPixelCount: false,
  },
  // Mahalanobis also wants CLASS_PIXEL_COUNT; ROIStatistics supplies
  // ROI_PIXEL_COUNT, which is the same quantity per class.
  mahalanobis: {
    taskName: 'MahalanobisDistanceClassification',
    label: '马氏距离（Mahalanobis Distance）',
    needsCovariance: true,
    needsPixelCount: true,
  },
  // Spectral Angle Mapper only needs the class means, so it tolerates small or
  // heterogeneous sample sets better than the covariance-based methods.
  'spectral-angle': {
    taskName: 'SpectralAngleMapperClassification',
    label: '光谱角制图（Spectral Angle Mapper）',
    needsCovariance: false,
    needsStddev: false,
  },
};

/**
 * Unsupervised clustering, no samples needed.
 *
 * Only ISODATA exists in this ENVI build -- KMeansClassification is not in the
 * catalog (checked against the live 295-task list), so it is not offered here.
 */
export const UNSUPERVISED_CLASSIFIERS = {
  isodata: { taskName: 'ISODATAClassification', label: 'ISODATA' },
}

/**
 * Spectral unmixing / target detection tasks.
 *
 * These take endmember spectra directly as arrays, so they work without any ENVI
 * object graph either. Each needs ENDMEMBERS[nEndmembers][nBands].
 */
export const SPECTRAL_ANALYZERS = {
  'linear-unmixing': { taskName: 'LinearSpectralUnmixing', label: '线性光谱解混' },
  'matched-filter': { taskName: 'MatchedFilter', label: '匹配滤波' },
  'mixture-tuned-matched-filter': {
    taskName: 'MixtureTunedMatchedFilter',
    label: '混合调谐匹配滤波（MTMF）',
  },
}

/**
 * Post-classification cleanup.
 *
 * Rasters produced by a classifier are noisy speckle; these are the standard
 * ENVI cleanups. All take only a raster plus a couple of scalars.
 */
export const CLASSIFICATION_CLEANUP = {
  clump: { taskName: 'ClassificationClumping', label: '聚类（Clump）' },
  sieve: { taskName: 'ClassificationSieving', label: '筛除（Sieve）' },
  smooth: { taskName: 'ClassificationSmoothing', label: '平滑（Smooth）' },
  aggregate: { taskName: 'ClassificationAggregation', label: '聚合（Aggregate）' },
}

/** Vectorise a classification raster. */
export const CLASSIFICATION_TO_VECTOR = {
  shapefile: { taskName: 'ClassificationToShapefile', label: '分类 → Shapefile' },
  'polygon-roi': { taskName: 'ClassificationToPolygonROI', label: '分类 → 多边形 ROI' },
  'pixel-roi': { taskName: 'ClassificationToPixelROI', label: '分类 → 像素 ROI' },
}

export function resolveClassifier(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/[_\s]/g, '-')
  if (STATISTICAL_CLASSIFIERS[key] !== undefined) {
    return { kind: 'statistical', key, ...STATISTICAL_CLASSIFIERS[key] }
  }
  if (UNSUPERVISED_CLASSIFIERS[key] !== undefined) {
    return { kind: 'unsupervised', key, ...UNSUPERVISED_CLASSIFIERS[key] }
  }
  return undefined
}

/**
 * Turn one `ROIStatistics` result into the arrays a classifier needs.
 *
 * ENVI returns the outer index as class and the inner index as band, which is
 * exactly the shape the classifiers expect -- so this is mostly validation. The
 * checks matter because a mismatched band count produces a classification that
 * runs happily and is silently wrong.
 */
export function classifierInputsFromStatistics(stats, { classifier, bandCount }) {
  if (stats === undefined || stats === null) return { ok: false, reason: '没有 ROI 统计量。' }
  const names = Array.isArray(stats.ROI_NAMES) ? stats.ROI_NAMES : []
  const means = stats.MEAN
  if (names.length === 0 || !Array.isArray(means)) {
    return { ok: false, reason: 'ROI 统计量里没有均值数组，先确认 ROI 有像素。' }
  }
  const spec = resolveClassifier(classifier)
  if (spec === undefined || spec.kind !== 'statistical') {
    return { ok: false, reason: `未知的统计分类器：${classifier}` }
  }

  const meanShape = shapeOf(means)
  if (meanShape.rows !== names.length) {
    return {
      ok: false,
      reason: `均值数组有 ${meanShape.rows} 行，但有 ${names.length} 个 ROI；两者必须一致。`,
    }
  }
  if (bandCount !== undefined && meanShape.columns !== bandCount) {
    return {
      ok: false,
      reason: `均值每个类有 ${meanShape.columns} 个波段，但影像有 ${bandCount} 个波段。`,
    }
  }

  const inputs = {
    MEAN: means,
    CLASS_NAMES: names,
  }
  if (Array.isArray(stats.ROI_COLORS) && stats.ROI_COLORS.length === names.length) {
    // ROI_COLORS comes back flat for a single region; normalize to one RGB per class.
    inputs.CLASS_COLORS = normalizeColors(stats.ROI_COLORS, names.length)
  }

  if (spec.needsCovariance) {
    const covariance = stats.COVARIANCE
    if (!Array.isArray(covariance) || covariance.length !== names.length) {
      return { ok: false, reason: `${spec.label} 需要 COVARIANCE，但统计量里缺失或类数不符。` }
    }
    const square = covariance.every((matrix) => shapeOf(matrix).rows === meanShape.columns
      && shapeOf(matrix).columns === meanShape.columns)
    if (!square) {
      return { ok: false, reason: `协方差矩阵必须是 ${meanShape.columns}×${meanShape.columns}。` }
    }
    inputs.COVARIANCE = covariance
  } else if (spec.needsStddev !== false) {
    const stddev = stats.STDDEV
    if (!Array.isArray(stddev) || stddev.length !== names.length) {
      return { ok: false, reason: `${spec.label} 需要 STDDEV，但统计量里缺失或类数不符。` }
    }
    inputs.STDDEV = stddev
  }

  if (spec.needsPixelCount === true) {
    // Mahalanobis weights by how many pixels each class contributed. ENVI names
    // it ROI_PIXEL_COUNT in the statistics output but CLASS_PIXEL_COUNT here.
    const counts = stats.ROI_PIXEL_COUNT
    if (!Array.isArray(counts) || counts.length !== names.length) {
      return { ok: false, reason: `${spec.label} 需要每类像元数，但 ROI_PIXEL_COUNT 缺失。` }
    }
    inputs.CLASS_PIXEL_COUNT = counts.map((count) => Math.trunc(Number(count)))
  }

  return { ok: true, inputs, classNames: names }
}

/** Rows/columns of a nested numeric array. */
export function shapeOf(value) {
  if (!Array.isArray(value)) return { rows: 0, columns: 0 }
  const columns = value.length === 0 ? 0 : (Array.isArray(value[0]) ? value[0].length : 0)
  return { rows: value.length, columns }
}

/**
 * ENVI's ROI_COLORS is `[[r,g,b], ...]` for several regions but `[r,g,b]` for one.
 * Always hand the classifier one RGB triple per class.
 */
export function normalizeColors(colors, classCount) {
  if (!Array.isArray(colors)) return undefined
  if (colors.length === classCount && colors.every((entry) => Array.isArray(entry))) {
    return colors
  }
  if (colors.length === 3 && colors.every((entry) => typeof entry === 'number')) {
    return [colors]
  }
  return undefined
}
