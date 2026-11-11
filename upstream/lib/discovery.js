/**
 * ENVI / IDL installation discovery.
 *
 * Nothing here may throw for a missing installation: every probe reports what
 * it found and the caller decides whether that is enough.
 */

import { readdirSync, statSync } from 'node:fs'
import { join, delimiter } from 'node:path'

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Every direct child directory name, or [] when unreadable. */
function children(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * ENVI installs as ENVI<major><minor> (ENVI53, ENVI54, ENVI56...).
 * Returns them newest first so a machine with two installs defaults to the new one.
 */
export function enviRootCandidates(env = process.env) {
  const roots = []
  const push = (path) => {
    if (typeof path === 'string' && path.trim() !== '') roots.push(path.trim())
  }
  for (const name of ['ENVI_DIR', 'ENVI_HOME', 'ENVI_ROOT']) push(env[name])
  if (process.platform === 'win32') {
    const programFiles = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean)
    for (const base of programFiles) {
      push(join(base, 'Harris'))
      push(join(base, 'Exelis'))
      push(join(base, 'ITT'))
      push(join(base, 'NV5', 'Geospatial'))
      push(join(base, 'NV5Geospatial'))
    }
  } else if (process.platform === 'darwin') {
    push('/Applications/NV5/ENVI')
    push('/Applications/Harris/ENVI')
  } else {
    push('/usr/local/harris/envi')
    push('/opt/harris/envi')
    push('/usr/local/nv5/envi')
  }
  for (const entry of String(env.PATH ?? '').split(delimiter)) {
    if (/[\\/]envi\d*[\\/]bin[\\/]*$/i.test(entry)) push(entry)
  }
  return [...new Set(roots)]
}

/** Newest-first list of ENVI<major><minor> directories under each root. */
export function findEnviHome(env = process.env) {
  const found = []
  for (const root of enviRootCandidates(env)) {
    if (/envi\d*[\\/]?(bin)?[\\/]*$/i.test(root) && isDir(root)) {
      found.push(stripBin(root))
      continue
    }
    for (const name of children(root)) {
      if (!/^ENVI\d+$/i.test(name)) continue
      const home = join(root, name)
      if (isDir(join(home, 'bin'))) found.push(home)
    }
  }
  return dedupeNewestFirst(found)
}

function stripBin(path) {
  const trimmed = path.replace(/[\\/]+$/, '')
  return /[\\/]bin$/i.test(trimmed) ? trimmed.replace(/[\\/]bin$/i, '') : trimmed
}

function dedupeNewestFirst(paths) {
  const seen = new Set()
  const unique = []
  for (const path of paths) {
    const key = path.toLowerCase().replace(/\//g, '\\')
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(path)
  }
  return unique.sort((a, b) => versionScore(b) - versionScore(a))
}

function versionScore(path) {
  const match = /ENVI(\d+)(\d)/i.exec(path)
  if (match === null) return 0
  return Number(match[1]) * 100 + Number(match[2]) * 10
}

/** The IDL88 style directory that owns a launcher. */
export function findIdlHome(enviHome) {
  const candidates = children(enviHome)
    .filter((name) => /^IDL\d+$/i.test(name))
    .map((name) => join(enviHome, name))
    .sort()
  return candidates[0]
}

/**
 * Locate the interpreter launcher for one ENVI home.
 *
 * Modern ENVI (5.1+) ships a runtime-only IDL at IDL88/bin/bin.x86_64/idl_rt.exe.
 * Older releases expose bin/idl.exe. Both are returned when present so the
 * caller can choose; only the real idl.exe accepts -e.
 */
export function findIdlInterpreter(enviHome, env = process.env) {
  if (!isDir(enviHome)) return undefined
  const binaries = []
  const addCandidate = (base, relative) => {
    const path = join(base, ...relative)
    if (isFile(path) && !binaries.some((entry) => entry.toLowerCase() === path.toLowerCase())) binaries.push(path)
  }
  for (const name of children(enviHome)) {
    if (!/^IDL\d+$/i.test(name)) continue
    const binRoot = join(enviHome, name, 'bin')
    for (const rel of [
      ['bin.x86_64', 'idl_rt.exe'],
      ['bin.x86_64', 'idlrt.exe'],
      ['bin.x86_64', 'idl.exe'],
      ['bin', 'idl_rt.exe'],
      ['bin', 'idl.exe'],
    ]) {
      addCandidate(binRoot, rel)
    }
  }
  for (const rel of [['idl_rt.exe'], ['idl.exe'], ['envi_idl.exe']]) addCandidate(join(enviHome, 'bin'), rel)
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir.trim() === '') continue
    for (const name of ['idl_rt.exe', 'idl.exe']) addCandidate(dir, [name])
  }
  if (binaries.length === 0) return undefined
  const runtimeIdl = binaries.find((path) => /idl_?\s?rt\.exe$/i.test(path))
  const commandIdl = binaries.find((path) => /\bidl\.exe$/i.test(path))
  return {
    enviHome,
    idlHome: findIdlHome(enviHome),
    runtimeIdl,
    commandIdl,
    primary: runtimeIdl ?? commandIdl,
  }
}

/** ENVI lib/hook holds envi_rt.sav, the ENVI runtime boot file. */
export function findEnviBootPath(enviHome) {
  const idlHome = findIdlHome(enviHome)
  if (idlHome === undefined) return undefined
  for (const rel of [['lib', 'hook', 'envi_rt.sav'], ['lib', 'hook', 'envi.sav'], ['lib', 'envi_rt.sav']]) {
    const path = join(idlHome, ...rel)
    if (isFile(path)) return path
  }
  return undefined
}

/** ENVI save holds the compiled ENVI routine library in 5.x+. */
export function findEnviSaveDir(enviHome) {
  const save = join(enviHome, 'save')
  return isDir(save) ? save : undefined
}

/**
 * Locate ENVI's command-line task engine.
 *
 * This is the only ENVI entry point that executes work unattended on this
 * machine: it reads a JSON task document on stdin and writes JSON on stdout,
 * with no window and no dialog. Its path contains spaces, so callers must
 * spawn it with an argv array rather than through a shell string.
 */
export function findTaskEngine(enviHome, env = process.env) {
  if (!isDir(enviHome)) return undefined
  const candidates = []
  for (const name of children(enviHome)) {
    if (!/^IDL\d+$/i.test(name)) continue
    for (const rel of [
      ['bin', 'bin.x86_64', 'taskengine.exe'],
      ['bin', 'bin.x86_64', 'envitaskengine.bat'],
      ['bin', 'taskengine.exe'],
    ]) {
      candidates.push(join(enviHome, name, ...rel))
    }
  }
  for (const dir of String(env.PATH ?? '').split(delimiter)) {
    if (dir.trim() === '') continue
    candidates.push(join(dir, 'taskengine.exe'))
  }
  // Only the .exe is usable: a .bat wrapper cannot be spawned without a shell.
  const found = candidates.find((path) => /\btaskengine\.exe$/i.test(path) && isFile(path))
  return found
}

/**
 * Full discovery report for one configured or detected installation.
 * hasCommandIdl tells the caller whether a scratch-script run is possible at all.
 */
export function discoverEnvi({ installDir, idlDir, env = process.env } = {}) {
  const configured = typeof installDir === 'string' && installDir.trim() !== '' ? installDir.trim() : undefined
  const homes = configured === undefined ? findEnviHome(env) : [stripBin(configured)]
  const attempts = []
  for (const home of homes) {
    attempts.push({
      enviHome: home,
      exists: isDir(home),
      interpreter: findIdlInterpreter(home, env),
      bootPath: findEnviBootPath(home),
      saveDir: findEnviSaveDir(home),
    })
  }
  const explicitIdl = typeof idlDir === 'string' && idlDir.trim() !== '' ? idlDir.trim() : undefined
  if (explicitIdl !== undefined) {
    const override = locateExplicitIdl(explicitIdl)
    if (override !== undefined) {
      if (attempts.length === 0) {
        attempts.push({ enviHome: undefined, exists: isDir(stripBin(explicitIdl)), interpreter: override, bootPath: undefined, saveDir: undefined })
      } else {
        const first = attempts[0]
        first.interpreter = { ...override, enviHome: first.enviHome, idlHome: first.interpreter?.idlHome }
      }
    }
  }
  const chosen = attempts.find((attempt) => attempt.exists === true && attempt.interpreter !== undefined) ?? attempts[0]
  const taskEngine = chosen?.enviHome === undefined ? undefined : findTaskEngine(chosen.enviHome, env)
  return {
    // An installation counts as usable when its task engine exists, because that
    // is the channel the plugin actually executes through.
    found: chosen !== undefined && chosen.exists === true && taskEngine !== undefined,
    enviHome: chosen?.enviHome,
    idlHome: chosen?.interpreter?.idlHome ?? (chosen?.enviHome === undefined ? undefined : findIdlHome(chosen.enviHome)),
    runtimeIdl: chosen?.interpreter?.runtimeIdl,
    commandIdl: chosen?.interpreter?.commandIdl,
    primary: chosen?.interpreter?.primary,
    taskEngine,
    bootPath: chosen?.bootPath,
    saveDir: chosen?.saveDir,
    searched: homes,
  }
}

/** Accept either an IDL home directory or the launcher executable itself. */
function locateExplicitIdl(idlDir) {
  const candidates = []
  if (isFile(idlDir)) {
    candidates.push(idlDir)
  } else if (isDir(idlDir)) {
    for (const rel of [
      ['bin', 'bin.x86_64', 'idl_rt.exe'],
      ['bin', 'bin.x86_64', 'idl.exe'],
      ['bin', 'idl_rt.exe'],
      ['bin', 'idl.exe'],
      ['idl_rt.exe'],
      ['idl.exe'],
    ]) {
      const path = join(idlDir, ...rel)
      if (isFile(path)) candidates.push(path)
    }
  }
  if (candidates.length === 0) return undefined
  const runtimeIdl = candidates.find((path) => /idl_?\s?rt\.exe$/i.test(path))
  const commandIdl = candidates.find((path) => /\bidl\.exe$/i.test(path))
  return {
    primary: runtimeIdl ?? commandIdl,
    runtimeIdl,
    commandIdl,
    idlHome: /[\\/]bin[\\/]/i.test(candidates[0]) ? candidates[0].replace(/[\\/]bin[\\/].*$/i, '') : undefined,
  }
}

/** Human-readable install report for the envi_install_info tool. */
export function describeInstallation(info) {
  if (info?.found !== true) {
    return {
      status: 'not-found',
      message:
        'No ENVI installation was found. Set the plugin config installDir, or launch ENVI once so the installer registry is populated.',
      searched: info?.searched ?? findEnviHome(),
    }
  }
  return {
    status: 'ok',
    enviHome: info.enviHome,
    idlHome: info.idlHome,
    runtimeIdl: info.runtimeIdl,
    commandIdl: info.commandIdl,
    primary: info.primary,
    taskEngine: info.taskEngine,
    bootPath: info.bootPath,
    saveDir: info.saveDir,
    hasCommandIdl: typeof info.commandIdl === 'string',
  }
}

export { isFile, isDir }
