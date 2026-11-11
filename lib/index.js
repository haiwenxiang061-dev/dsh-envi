/**
 * dsh-envi — operate ENVI from DeepSeek Harness (native bundle form).
 *
 * This is the DSH-native port of the ZCode `envi-mcp` plugin. The ZCode build
 * carried two artifacts purely because ZCode speaks MCP rather than Cordis:
 *
 *   shim.mjs    — a fake `ctx` whose `tools.register` collected tools into a Map
 *   server.mjs  — a stdio JSON-RPC server re-exposing that Map as MCP tools
 *
 * Neither survives the port. DSH *is* the Cordis host, so upstream's own
 * `apply` runs unmodified against the real `ctx`. This entry re-exports it and
 * adds the two host contributions the MCP form could not express:
 *
 *   - `envi` skill          (ZCode discovered it from skills/envi/SKILL.md)
 *   - `/envi-check` command (ZCode slash command, commands/envi-check.md)
 *
 * Everything ENVI-specific — discovery, the task-engine subprocess, ROI /
 * classification / raster helpers — is reused verbatim from `upstream/`.
 */

import { readFileSync } from 'node:fs'

import * as upstream from '../upstream/index.js'

export const name = 'dsh-envi'

/**
 * `tools` is mandatory. `skills` is deliberately absent: the registry is
 * optional infrastructure and every tool works without it, so a host lacking
 * skills must still activate.
 */
export const inject = ['tools']

const DEFAULTS = {
  installDir: '',
  idlDir: '',
  taskTimeoutMs: 900000,
  catalogCacheMs: 60000,
  scratchDir: '',
  /** Also expose `envi-check` to the model-facing catalog. */
  modelInvocableCommand: false,
  /** Keep `skills/**` and `commands/*.md` discoverable from disk as well. */
  filesystemFallback: true,
}

/** Read a bundled asset as UTF-8. */
function asset(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

/** Split a Markdown file with YAML frontmatter into `{ data, body }`. */
function splitFrontmatter(text) {
  const normalized = text.replace(/^\uFEFF/, '')
  if (!normalized.startsWith('---')) return { data: {}, body: normalized }
  const end = normalized.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: normalized }
  const head = normalized.slice(3, end)
  const body = normalized.slice(end + 4).replace(/^\r?\n/, '')
  const data = {}
  for (const line of head.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if (
      value.length > 1 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    data[match[1]] = value
  }
  return { data, body }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }

  // 1) Tools -----------------------------------------------------------------
  // Upstream's apply is synchronous and only touches `ctx.tools.register`, plus
  // optional `systemPrompt` / `shellEnv` that it resolves via `ctx.get`. Pass
  // the host ctx and the shared config keys straight through.
  const upstreamDispose = upstream.apply(ctx, {
    installDir: config.installDir,
    idlDir: config.idlDir,
    taskTimeoutMs: config.taskTimeoutMs,
    catalogCacheMs: config.catalogCacheMs,
    scratchDir: config.scratchDir,
  })
  if (typeof upstreamDispose === 'function') {
    ctx.effect(() => upstreamDispose, 'envi: dispose upstream tools')
  }

  // 2) Skill: envi ------------------------------------------------------------
  const { data: skillMeta, body: skillBody } = splitFrontmatter(asset('../skills/envi/SKILL.md'))
  registerSkill(ctx, {
    name: skillMeta.name ?? 'envi',
    description: skillMeta.description ?? '通过任务引擎操作 ENVI 遥感软件。',
    ...(skillMeta.whenToUse === undefined ? {} : { whenToUse: skillMeta.whenToUse }),
    source: 'bundle:dsh-envi/skills/envi',
    content: skillBody,
    path: 'skills/envi/SKILL.md',
    invocation: { modelInvocable: true, userInvocable: true },
  })

  // 3) Command: /envi-check --------------------------------------------------
  // ZCode's slash command maps onto a user-invocable skill: typing the name
  // injects the body into that step. `$ARGUMENTS` has no placeholder equivalent
  // here, so the token is stripped and the text otherwise passes through.
  const { data: cmdMeta, body: cmdBody } = splitFrontmatter(asset('../commands/envi-check.md'))
  registerSkill(ctx, {
    name: 'envi-check',
    description: cmdMeta.description ?? '检查 ENVI 环境并列出可用任务',
    source: 'bundle:dsh-envi/commands/envi-check',
    content: cmdBody.replace(/\$ARGUMENTS/g, '').trimEnd(),
    path: 'commands/envi-check.md',
    invocation: { modelInvocable: config.modelInvocableCommand, userInvocable: true },
  })

  // 4) Filesystem fallback ---------------------------------------------------
  // The Markdown stays on disk and editable; runtime registration wins any
  // same-name tie, so the files act as a fallback rather than a duplicate.
  if (config.filesystemFallback) {
    const provider = ctx.get('skillFilesystem')
    if (provider !== undefined && typeof provider.addRoot === 'function') {
      ctx.effect(
        () => provider.addRoot(new URL('../skills', import.meta.url).href, { name: 'dsh-envi', rank: 350 }),
        'envi: skill root',
      )
      ctx.effect(
        () =>
          provider.addRoot(new URL('../commands', import.meta.url).href, {
            name: 'dsh-envi-commands',
            rank: 340,
            pattern: '*.md',
          }),
        'envi: command root',
      )
    }
  }
}

/** Register one in-memory skill, degrading quietly when no registry is mounted. */
function registerSkill(ctx, skill) {
  const skills = ctx.get('skills')
  if (skills === undefined || typeof skills.register !== 'function') {
    ctx.logger?.warn?.(`dsh-envi: no skill registry mounted; "${skill.name}" not contributed`)
    return
  }
  ctx.effect(() => skills.register(skill), `envi: skill ${skill.name}`)
}
