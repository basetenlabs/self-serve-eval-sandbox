// Who may sign in, kept in a file on the volume that admins edit from the page.
//
// The file is `{ "admins": [], "emails": [], "domains": [] }`. @blaxel/sign-in re-reads it whenever it
// changes and checks every request against it, so a change here takes effect at once, removals too.
// Only the sign-in server writes it, through the admin API below, and checks each entry with the
// sign-in's own rules first.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { checkAccessList, checkDomain, checkEmail, normalizeDomain, normalizeEmail } from '@blaxel/sign-in'

/** Who gets in when there is no file yet: everyone with a baseten.co or blaxel.ai email, and the admins in PR_EVAL_ADMINS. */
export const SEED = Object.freeze({
  emails: [],
  domains: ['baseten.co', 'blaxel.ai'],
})

/** The first admins: PR_EVAL_ADMINS, comma-separated emails. */
export const seedAdmins = (env = process.env) => (env.PR_EVAL_ADMINS || '').split(',').map(email => email.trim()).filter(Boolean)

const LISTS = ['admins', 'emails', 'domains']
const MAX_BODY = 4096

/** Writes `lists` to `file` all at once: a temporary file renamed over the old one. */
async function save(file, lists) {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(tmp, JSON.stringify({ admins: lists.admins, emails: lists.emails, domains: lists.domains }, null, 2) + '\n', { mode: 0o600 })
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

/** Creates the file with SEED when it doesn't exist yet; never touches one that does. Returns whether it wrote. */
export async function seedAccess(file, log = console, env = process.env) {
  try {
    await readFile(file)
    return false
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(file), { recursive: true })
  const admins = seedAdmins(env)
  await save(file, checkAccessList({ ...SEED, admins }))
  log.info?.(`[access] created ${file}: ${admins.length ? admins.join(', ') : 'no'} admins, ${SEED.domains.join(', ')} as domains`)
  if (!admins.length) log.warn?.('[access] set PR_EVAL_ADMINS to name the first admins; until then nobody can edit the list from the page')
  return true
}

/** The file's lists, normalized, or undefined when it can't be read or parsed right now. */
async function current(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    return checkAccessList(parsed)
  } catch {
    return undefined
  }
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) return undefined
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { return undefined }
}

/**
 * The admin API, for @blaxel/sign-in's `api` hook: it runs only for a signed-in, admitted person, and
 * a POST has already passed the exact-origin check.
 *
 *   GET  /api/admin/access  -> { admins, emails, domains, you }
 *   POST /api/admin/access  { list: "admins" | "emails" | "domains", value, remove?: true } -> the same
 *
 * Every request checks again that the person is an admin in the file as it is now (403 if not). Writes
 * go one at a time, so two admins editing at once can't undo each other's change.
 */
export function adminApi({ file, log = console }) {
  let queue = Promise.resolve()
  const oneAtATime = work => {
    const next = queue.then(work, work)
    queue = next.catch(() => {})
    return next
  }

  return async (req, res, { path, session }) => {
    if (path !== '/api/admin/access') return false
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'Use GET or POST.' })
    const you = normalizeEmail(session?.user?.email)
    const isAdmin = lists => !!you && lists.admins.includes(you)

    if (req.method === 'GET') {
      const lists = await current(file)
      if (!lists) return send(res, 503, { error: 'The access list can\'t be read right now. Try again in a moment.' })
      if (!isAdmin(lists)) return send(res, 403, { error: 'Only admins can see who has access.' })
      return send(res, 200, { admins: lists.admins, emails: lists.emails, domains: lists.domains, you })
    }

    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, { error: 'Send JSON.' })
    const body = await readBody(req)
    return oneAtATime(async () => {
      const lists = await current(file)
      if (!lists) return send(res, 503, { error: 'The access list can\'t be read right now, so nothing was changed. Try again in a moment.' })
      if (!isAdmin(lists)) return send(res, 403, { error: 'Only admins can change who has access.' })
      if (!body || !LISTS.includes(body.list) || typeof body.value !== 'string') {
        return send(res, 400, { error: 'Say which list (admins, emails or domains) and the entry.' })
      }
      const { list } = body
      const next = { admins: [...lists.admins], emails: [...lists.emails], domains: [...lists.domains] }
      let entry
      if (body.remove) {
        entry = list === 'domains' ? normalizeDomain(body.value) : normalizeEmail(body.value)
        if (!entry || !next[list].includes(entry)) return send(res, 400, { error: `${String(body.value).slice(0, 254)} isn't on that list.` })
        if (list === 'admins' && next.admins.length === 1) {
          return send(res, 400, { error: 'This is the last admin. Add another admin before removing them.' })
        }
        next[list] = next[list].filter(e => e !== entry)
      } else {
        const checked = list === 'domains' ? checkDomain(body.value) : checkEmail(body.value)
        if (checked.error) return send(res, 400, { error: checked.error })
        entry = checked.domain ?? checked.email
        if (!next[list].includes(entry)) next[list].push(entry)
      }
      const saved = checkAccessList(next)
      if (!saved.admins.length) return send(res, 400, { error: 'The list needs at least one admin.' })
      try {
        await save(file, saved)
      } catch (error) {
        log.error?.(`[access] could not write ${file}: ${error.message}`)
        return send(res, 503, { error: 'The access list couldn\'t be saved. Try again in a moment.' })
      }
      log.info?.(`[access] ${you} ${body.remove ? 'removed' : 'added'} ${entry} ${body.remove ? 'from' : 'to'} ${list}`)
      return send(res, 200, { admins: saved.admins, emails: saved.emails, domains: saved.domains, you })
    })
  }
}
