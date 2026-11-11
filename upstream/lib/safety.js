/**
 * Writing IDL/ENVI from a model is the risky half of this plugin: one wrong
 * statement can overwrite a raster in place. This module keeps the rules in
 * one place so the tools and the prompt section cannot drift apart.
 */

/** ENVI routines that never touch user data. */
const READ_ONLY_ROUTINES = new Set([
  'ENVI',
  'ENVI_GET_FILE',
  'ENVI_FILE_QUERY',
  'ENVI_OPEN_FILE',
  'ENVI_CLOSE_FILE',
  'ENVI_GET_PROJECTION',
  'ENVI_GET_MAP_INFO',
  'ENVI_FILE_INFO',
  'ENVI_IMAGE_INFO',
  'ENVI_GET_DATA',
  'ENVI_GET_HEADER',
  'QUERY_IMAGE',
  'READ_IMAGE',
  'READ_TIFF',
  'READ_PNG',
  'READ_JPEG',
  'READ_BINARY',
  'READ_ASCII',
  'READ_CSV',
  'FILE_TEST',
  'FILE_SEARCH',
  'FILE_INFO',
  'PRINT',
  'HELP',
])

/** Constructors/statements that appear inside every normal ENVI script. */
const NEUTRAL = new Set([
  'COMPILE_OPT',
  'CD',
  'PRO',
  'END',
  'BEGIN',
  'ENDIF',
  'ELSE',
  'ENDELSE',
  'FOR',
  'ENDFOR',
  'WHILE',
  'ENDWHILE',
  'REPEAT',
  'UNTIL',
  'IF',
  'THEN',
  'CASE',
  'SWITCH',
  'CATCH',
  'RETURN',
  'BREAK',
  'CONTINUE',
])

/**
 * Routines whose name alone says "this writes". Used for the pre-flight hints
 * the model sees before running, not as a hard deny: a real script legitimately
 * calls them, and the user can always ask for them explicitly.
 */
const WRITE_HINTS = [
  [/^ENVI_CREATE_FILE$/i, 'creates a new ENVI dataset (ENVI_FILE_MNG id=, /CREATE, DATA=, DIMS=)'],
  [/^ENVI_FILE_MNG$/i, 'opens/creates/removes ENVI datasets; check id=/CREATE/REMOVE arguments'],
  [/^ENVI_OUTPUT/i, 'writes an ENVI output dataset'],
  [/^ENVI_WRITE/i, 'writes an ENVI output dataset'],
  [/^ENVI_(OPEN_)?ROI/i, 'creates or saves an ROI'],
  [/^ENVI_SAVE/i, 'saves ENVI state or products'],
  [/^ENVI_QUERY/i, 'may read or write depending on keywords'],
  [/^WRITE_/i, 'writes a raster/image file'],
  [/^FILE_DELETE$/i, 'deletes a file'],
  [/^FILE_MOVE$/i, 'moves or renames a file'],
  [/^SPAWN$/i, 'runs an external process'],
  [/^CALL_EXTERNAL$/i, 'runs native code'],
  [/^OPENW$/i, 'opens a file for writing'],
  [/^OPENU$/i, 'opens a file for update'],
  [/^EOF$/i, 'writes/reads a file position'],
]

/** Statements that make an unattended run hang or leak a GUI. */
const FORBIDDEN = [
  { pattern: /\bWIDGET_(BASE|BUTTON|CONTROL|TABLE|TEXT|LABEL|DRAW|INFO)\b/i, reason: 'opens a GUI widget, which blocks a headless run' },
  { pattern: /\bDIALOG_PICKFILE\b/i, reason: 'waits for a human to choose a file' },
  { pattern: /\bDIALOG_MESSAGE\b/i, reason: 'waits for a human to dismiss a dialog' },
  { pattern: /\bENVI_PICKFILE\b/i, reason: 'waits for a human to choose a file' },
  { pattern: /\bXMANAGER\b/i, reason: 'creates an X-manager window' },
  { pattern: /(^|\n)\s*WAIT\s*,\s*\d{2,}/i, reason: 'sleeps for many seconds, which hides a hang' },
  { pattern: /(^|\n)\s*STOP\b/i, reason: 'enters the interactive debugger' },
  { pattern: /(^|\n)\s*RETALL\b/i, reason: 'drops into the interactive prompt' },
  { pattern: /(^|\n)\s*\.OUT\b/i, reason: 'is an interactive dot-command' },
  { pattern: /(^|\n)\s*@\s*\S+\.pro/i, reason: 'nests another batch file, which IDL rejects after -e' },
]

export function inspectSnippet(snippet) {
  const code = String(snippet ?? '')
  const forbidden = FORBIDDEN.filter((rule) => rule.pattern.test(code)).map((rule) => rule.reason)
  const writeHints = []
  for (const line of code.split(/\r?\n/)) {
    const call = /(?:^|\n|&)\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:,|\s*$|\()/.exec(line)
    if (call === null) continue
    const name = call[1].toUpperCase()
    if (NEUTRAL.has(name) || READ_ONLY_ROUTINES.has(name)) continue
    for (const [pattern, hint] of WRITE_HINTS) {
      if (pattern.test(name)) writeHints.push({ routine: name, hint })
    }
  }
  return { forbidden, writeHints, mayWrite: writeHints.length > 0 }
}

/**
 * Gate result for one run request. Returns `undefined` when the run may
 * proceed, or a refusal message in the user's language.
 */
export function gateRun({ snippet, writeAllowed, dryRun }) {
  const audit = inspectSnippet(snippet)
  if (audit.forbidden.length > 0) {
    return {
      reason:
        '这些语句会让无人值守的 IDL 挂起或弹出界面，已拒绝执行：' +
        audit.forbidden.map((item) => `\n  - ${item}`).join(''),
      audit,
    }
  }
  if (audit.mayWrite && writeAllowed !== true && dryRun !== true) {
    return {
      reason:
        '这段脚本包含可能写入磁盘的 ENVI/IDL 调用，需要在同一次调用里显式传 writeAllowed=true 才会执行：' +
        audit.writeHints.map((item) => `\n  - ${item.routine}: ${item.hint}`).join('') +
        '\n如果只是想预览，可以传 dryRun=true 只做静态检查。',
      audit,
    }
  }
  return undefined
}

/** Short, deterministic report used by `dryRun` and by refusals. */
export function describeAudit(audit) {
  const lines = []
  lines.push(`可能写入的操作：${audit.mayWrite ? '是' : '否'}`)
  for (const item of audit.writeHints) lines.push(`  - ${item.routine}: ${item.hint}`)
  if (audit.forbidden.length > 0) {
    lines.push('会被拒绝的语句：')
    for (const item of audit.forbidden) lines.push(`  - ${item}`)
  }
  return lines.join('\n')
}
