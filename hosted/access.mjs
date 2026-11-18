// The sign-in server is the only writer. A decision and its grant share one atomic file replacement.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { checkAccessList, checkDomain, checkEmail, normalizeDomain, normalizeEmail } from '@blaxel/sign-in'

const INTERNAL_DOMAINS = ['baseten.co', 'blaxel.ai']
export const SEED = Object.freeze({ emails: [], domains: INTERNAL_DOMAINS })
export const seedAdmins = (env = process.env) => (env.PR_EVAL_ADMINS || '').split(',').map(email => email.trim()).filter(Boolean)
const internal = email => INTERNAL_DOMAINS.includes(normalizeEmail(email)?.split('@')[1])
const listsOf = ({ admins, emails, domains }) => ({ admins, emails, domains })
const MAX_BODY = 4096
const HOUR = 3_600_000
const REQUEST_PATH = '/api/access-requests'
const MACHINE_PATH = '/api/worker/access-requests'

async function save(file, data) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
  } finally {
    await rm(tmp, { force: true })
  }
}

export async function seedAccess(file, log = console, env = process.env) {
  try {
    await readFile(file)
    return false
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(file), { recursive: true })
  const admins = seedAdmins(env)
  await save(file, listsOf(checkAccessList({ ...SEED, admins })))
  if (!admins.length) log.warn?.('[access] set PR_EVAL_ADMINS to name the first admins')
  return true
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
class Refused extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function refuse(status, message) { throw new Refused(status, message) }

async function readBody(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') refuse(415, 'Send JSON.')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) refuse(413, 'The request is too long.')
    chunks.push(chunk)
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body && typeof body === 'object' && !Array.isArray(body)) return body
  } catch { /* invalid JSON */ }
  refuse(400, 'Send a JSON object.')
}

function checkedEntry(list, value) {
  const checked = list === 'domains' ? checkDomain(value) : checkEmail(value)
  if (checked.error) refuse(400, checked.error)
  return checked.domain ?? checked.email
}
function adminChange(data, { list, value, remove }) {
  if (!['admins', 'emails', 'domains'].includes(list) || typeof value !== 'string') refuse(400, 'Say which list and entry.')
  const entry = checkedEntry(list, value)
  if (remove === true) {
    if (!data[list].includes(entry)) refuse(400, 'That entry is not on the list.')
    if (list === 'admins' && data.admins.length === 1) refuse(400, 'Add another admin before removing the last admin.')
    data[list] = data[list].filter(e => e !== entry)
  } else {
    if (list !== 'admins' || !internal(entry)) refuse(403, 'Request access for an outside person or domain.')
    data.admins = [...new Set([...data.admins, entry])].sort()
  }
  return entry
}
function submit(data, body, who, now) {
  if (typeof body.target !== 'string' || !body.target.trim()) refuse(400, 'Enter an email or domain.')
  const raw = body.target.trim()
  const list = raw.includes('@') && !raw.startsWith('@') ? 'emails' : 'domains'
  const target = checkedEntry(list, raw)
  const reason = typeof body.reason === 'string' && body.reason.trim()
  if (!reason || reason.length > 500) refuse(400, 'Enter a reason of up to 500 characters.')
  if (data[list].includes(target) || (list === 'emails' && (data.admins.includes(target) || data.domains.includes(target.split('@')[1])))) {
    refuse(409, 'That email or domain already has access.')
  }
  const mine = data.requests.filter(r => r.requestedBy === who)
  if (mine.some(r => r.target === target && r.status === 'pending')) refuse(409, 'You already have a pending request for this entry.')
  if (mine.filter(r => Date.parse(r.requestedAt) > now - HOUR).length >= 5) refuse(429, 'You can submit five requests per hour. Try again later.')
  const request = { id: randomUUID(), list, target, reason, requestedBy: who, requestedAt: new Date(now).toISOString(), status: 'pending' }
  data.requests.push(request)
  return request
}

function decide(data, { id, status, decidedBy }, now) {
  if (!['approved', 'denied'].includes(status) || typeof decidedBy !== 'string' || !/^U[A-Z0-9]{2,31}$/.test(decidedBy)) refuse(400, 'Invalid decision or approver.')
  const row = data.requests.find(r => r.id === id)
  if (!row) refuse(404, 'Unknown request.')
  // A retry after a lost reply returns the authoritative outcome, even if a later click differs.
  if (row.status === 'pending') {
    if (status === 'approved') {
      const entry = checkedEntry(row.list, row.target)
      data[row.list] = [...new Set([...data[row.list], entry])].sort()
    }
    Object.assign(row, { status, decidedBy, decidedAt: new Date(now).toISOString() })
  }
  return row
}

const digest = value => createHash('sha256').update(value).digest()

export function accessHandlers({ file, secret, now = Date.now, log = console }) {
  const bearer = secret && digest('Bearer ' + secret)
  let queue = Promise.resolve()
  async function handle(req, res, work, afterSave) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined
      // Never wait for a client's body while holding the writer queue.
      const next = queue.then(async () => {
        const raw = JSON.parse(await readFile(file, 'utf8'))
        const lists = checkAccessList(raw)
        if (lists.problems.length || (raw.requests !== undefined && !Array.isArray(raw.requests))) throw new Error('Invalid access file')
        const data = { ...listsOf(lists), requests: raw.requests ?? [] }
        const result = work(data, body)
        if (req.method === 'POST') {
          await save(file, data)
          afterSave?.()
        }
        return result
      })
      queue = next.catch(() => {})
      send(res, 200, await next)
    } catch (error) {
      if (!(error instanceof Refused)) log.error?.('[access] could not read or save the access file')
      send(res, error.status ?? 503, { error: error instanceof Refused ? error.message : 'Access is unavailable. Try again in a moment.' })
    }
  }
  return {
    // Called by sign-in after verified identity, admission and the exact-origin check for writes.
    async api(req, res, { path, session }) {
      if (![REQUEST_PATH, '/api/admin/access'].includes(path)) return false
      const who = normalizeEmail(session?.user?.email)
      if (path === REQUEST_PATH && !internal(who)) return send(res, 403, { error: 'Only internal staff can request access.' })
      if (path === REQUEST_PATH && req.method === 'HEAD') return send(res, 204)
      if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Use GET or POST.' })
      let audit
      return handle(req, res, (data, body) => {
        if (path === REQUEST_PATH) {
          if (body) {
            if (!bearer) refuse(503, 'Access requests are not set up yet.')
            return submit(data, body, who, now())
          }
          return { enabled: !!bearer, requests: data.requests.filter(r => r.requestedBy === who).reverse() }
        }
        if (!who || !data.admins.includes(who)) refuse(403, 'Only admins can manage the access list.')
        if (body) {
          const entry = adminChange(data, body)
          audit = `[access] ${who} ${body.remove === true ? 'removed' : 'added'} ${entry} (${body.list})`
        }
        return { ...listsOf(data), you: who }
      }, () => { if (audit) log.info?.(audit) })
    },
    // The sole machine endpoint, before cookie sign-in. Every other path stays with the site server.
    attach(server) {
      const [site] = server.listeners('request')
      server.removeListener('request', site)
      server.on('request', (req, res) => {
        const [path, query] = req.url.split('?')
        if (path !== MACHINE_PATH) return site(req, res)
        if (!bearer || !timingSafeEqual(bearer, digest(req.headers.authorization ?? ''))) return send(res, 401, { error: 'Unauthorized.' })
        if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'Use GET or POST.' })
        return handle(req, res, (data, body) => {
          if (body) return decide(data, body, now())
          const after = new URLSearchParams(query).get('after') ?? ''
          const pending = data.requests.filter(r => r.status === 'pending' && r.id > after).sort((a, b) => a.id < b.id ? -1 : 1)
          const requests = pending.slice(0, 100)
          return { requests, next: pending.length > requests.length ? requests.at(-1).id : null }
        })
      })
    },
  }
}
