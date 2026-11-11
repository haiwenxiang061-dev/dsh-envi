/**
 * Background job tracking for long ENVI runs.
 *
 * A hyperspectral classification can take minutes; the tool layer must not
 * block the model's turn on it. Jobs are process-local, keep a bounded log
 * tail, and are always cancellable.
 */

import { randomBytes } from 'node:crypto'

const DEFAULT_LOG_LIMIT = 20000
const MAX_FINISHED = 32

export class JobStore {
  constructor({ logLimit = DEFAULT_LOG_LIMIT } = {}) {
    this.logLimit = logLimit
    /** @type {Map<string, Job>} */
    this.jobs = new Map()
    this.controllers = new Map()
  }

  create({ title, kind = 'run' }) {
    const id = `envi-${randomBytes(3).toString('hex')}`
    const job = {
      id,
      title: String(title ?? kind).slice(0, 160),
      kind,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: undefined,
      log: '',
      result: undefined,
      error: undefined,
    }
    this.jobs.set(id, job)
    this.controllers.set(id, new AbortController())
    this.evict()
    return job
  }

  controller(id) {
    return this.controllers.get(id)
  }

  append(id, text) {
    const job = this.jobs.get(id)
    if (job === undefined) return
    job.log = tail(job.log + text, this.logLimit)
  }

  finish(id, { result, error }) {
    const job = this.jobs.get(id)
    if (job === undefined) return job
    job.status = error === undefined ? 'done' : 'failed'
    job.finishedAt = new Date().toISOString()
    job.result = result
    job.error = error
    this.controllers.delete(id)
    return job
  }

  fail(id, message) {
    return this.finish(id, { error: String(message) })
  }

  get(id) {
    return this.jobs.get(id)
  }

  /** Running jobs plus the most recent finished ones. */
  list() {
    const all = [...this.jobs.values()]
    const running = all.filter((job) => job.status === 'running')
    const finished = all.filter((job) => job.status !== 'running').slice(-8)
    return [...running, ...finished].map(describe)
  }

  kill(id) {
    const controller = this.controllers.get(id)
    if (controller === undefined) return false
    controller.abort()
    const job = this.jobs.get(id)
    if (job !== undefined) {
      job.status = 'killed'
      job.finishedAt = new Date().toISOString()
    }
    this.controllers.delete(id)
    return true
  }

  killAll() {
    for (const id of [...this.controllers.keys()]) this.kill(id)
  }

  evict() {
    const finished = [...this.jobs.values()].filter((job) => job.status !== 'running')
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
      this.jobs.delete(job.id)
    }
  }
}

function describe(job) {
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedSeconds: Math.round(((job.finishedAt === undefined ? Date.now() : Date.parse(job.finishedAt)) - Date.parse(job.startedAt)) / 1000),
    logTail: job.log.slice(-4000),
    result: job.result,
    error: job.error,
  }
}

function tail(text, limit) {
  return text.length <= limit ? text : `…\n${text.slice(-limit)}`
}
