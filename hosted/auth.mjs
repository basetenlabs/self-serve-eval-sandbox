import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AuthFailure, blaxelOidc } from './oidc.mjs'
import { renderLogin } from './login-page.mjs'
import { MAX_SESSIONS, privateEntry, retireLegacySessions, sessionStore, SESSION_TTL } from './session-store.mjs'

export { AuthFailure, SESSION_TTL }

// Ported from Baseten Auto-Optimize (server/auth/index.mjs). Michael's access policy: a verified
// email whose whole domain is one of these. Blaxel workspace membership grants nothing.
export const ALLOWED_DOMAINS = Object.freeze(['blaxel.ai', 'baseten.co'])
const ATTEMPT_TTL = 10 * 60_000
// Sign-ins in flight per browser (one per tab), kept in a sealed cookie so a restart never loses them.
const ATTEMPTS_PER_BROWSER = 3
const STARTS_PER_MINUTE = 60
const random = () => randomBytes(32).toString('base64url')
export const sameSecret = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const LOCAL_PART = /^[a-z0-9_%+'-]+(?:\.[a-z0-9_%+'-]+)*$/

/** The lowercased address, only when its entire domain is allowed: a suffix test would admit x@notbaseten.co or x@eng.baseten.co. */
export function allowedEmail(value, domains = ALLOWED_DOMAINS) {
  if (typeof value !== 'string') return undefined
  const email = value.trim().toLowerCase()
  const at = email.lastIndexOf('@')
  const local = email.slice(0, at)
  return at > 0 && local.length <= 64 && LOCAL_PART.test(local) && domains.includes(email.slice(at + 1)) ? email : undefined
}

/** Only short same-origin paths survive the round trip through sign-in. */
export function safeNext(value) {
  return typeof value === 'string' && value.length <= 512 && /^\/(?![/\\])[\x21-\x7e]*$/.test(value) && !value.startsWith('/login') && !value.startsWith('/auth/') ? value : '/'
}

/** A private 32-byte key file for local runs, created on first use (mode 600 in a mode-700 directory). */
function localKey(directory, name) {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  privateEntry(directory, true)
  const path = join(directory, name)
  let fd
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const key = randomBytes(32)
    const created = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(created, key); fsyncSync(created) } finally { closeSync(created) }
    return key
  }
  // The checks and the read apply to the same open file.
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size !== 32) throw new Error(`${path} must be a private 32-byte file`)
    return readFileSync(fd)
  } finally { closeSync(fd) }
}
const derive = (secret, label) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), label, 32))

/**
 * "Sign in with Blaxel" for the hosted eval page: a standard OAuth authorization-code flow with PKCE,
 * state and nonce, bound to the browser that started it. Anyone whose Blaxel account has a
 * verified blaxel.ai or baseten.co email may use it. Blaxel tokens are used once to establish
 * identity and discarded; the browser holds only a random HttpOnly session ID.
 *
 * `secrets` ({ sessionKey, clientId, clientSecret }) come from the hosted server's process
 * environment. Without them (local runs and tests), a private site.key file in
 * `stateDirectory` and Dynamic Client Registration stand in.
 */
export async function blaxelAuth({ origin, environment, stateDirectory, secrets, domains = ALLOWED_DOMAINS, clientName, fetcher, now = Date.now }) {
  const secure = new URL(origin).protocol === 'https:'
  // __Host- cookies must be Secure, which needs HTTPS; plain localhost runs use host-only cookies.
  const SESSION = secure ? '__Host-eval_session' : 'eval_session'
  const BROWSER = secure ? '__Host-eval_signin' : 'eval_signin'
  const flags = `Path=/; HttpOnly;${secure ? ' Secure;' : ''} SameSite=Lax`
  if (secrets && (!Buffer.isBuffer(secrets.sessionKey) || secrets.sessionKey.length !== 32)) throw new Error('SESSION_KEY must be 32 random bytes')
  const master = secrets?.sessionKey ?? (stateDirectory ? localKey(stateDirectory, 'site.key') : randomBytes(32))
  const sealKey = derive(master, 'eval-sandbox:signin-cookie:v1')
  // Device-flow credentials from the previous sign-in never outlive this upgrade.
  if (retireLegacySessions(stateDirectory)) console.log('[auth] removed the retired device-flow session store')
  const oidc = blaxelOidc({ environment, origin, stateDirectory, clientName, fetcher, now, client: secrets && { clientId: secrets.clientId, clientSecret: secrets.clientSecret } })
  const sessions = sessionStore({ directory: stateDirectory && join(stateDirectory, 'identity'), key: derive(master, 'eval-sandbox:sessions:v1'), origin, scope: 'oidc-email-domains:' + [...domains].sort().join(','), environment, now })
  const aad = Buffer.from('eval-signin:v1:' + origin)
  function seal(value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', sealKey, iv)
    cipher.setAAD(aad)
    return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]).toString('base64url')
  }
  function unseal(value) {
    try {
      const bytes = Buffer.from(value, 'base64url')
      if (bytes.length < 29 || bytes.length > 3000) return undefined
      const decipher = createDecipheriv('aes-256-gcm', sealKey, bytes.subarray(0, 12))
      decipher.setAAD(aad)
      decipher.setAuthTag(bytes.subarray(-16))
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString())
    } catch { return undefined }
  }
  // States already used, so a callback URL can't be replayed while its cookie is still around.
  const used = new Map()
  function inFlight(req) {
    const raw = cookies(req)[BROWSER]
    const list = typeof raw === 'string' ? unseal(raw) : undefined
    return Array.isArray(list) ? list.filter(a => a && typeof a.state === 'string' && typeof a.nonce === 'string' && typeof a.verifier === 'string' && Number.isFinite(a.expiresAt) && a.expiresAt > now() && !used.has(a.state)) : []
  }
  let windowStart = 0
  let started = 0

  function sweep() {
    for (const [state, expiresAt] of used) if (expiresAt <= now()) used.delete(state)
    sessions.sweep()
  }
  const sweepTimer = setInterval(() => { try { sweep() } catch { /* Requests fail closed on storage errors. */ } }, 60_000)
  sweepTimer.unref()

  const cookie = (name, value, seconds) => `${name}=${value}; ${flags}; Max-Age=${seconds}`
  const signinCookie = list => cookie(BROWSER, list.length ? seal(list) : '', list.length ? ATTEMPT_TTL / 1000 : 0)
  function cookies(req) {
    const out = {}
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const at = part.indexOf('=')
      if (at < 0) continue
      const name = part.slice(0, at).trim()
      // A duplicated cookie name is ambiguous; ignore both.
      out[name] = name in out ? null : part.slice(at + 1).trim()
    }
    return out
  }
  const token = value => (typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined)
  // Storage errors propagate, so every caller fails closed.
  function read(req) {
    const id = token(cookies(req)[SESSION])
    if (!id) return {}
    const session = sessions.get(id)
    return session && session.expiresAt > now() ? { id, session } : {}
  }
  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  const sessionDays = Math.round(SESSION_TTL / 86_400_000)
  function page(res, status, options) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(renderLogin({ origin, domains, sessionDays, accountUrl: oidc.accountUrl, ...options }))
  }
  async function csrfValid(req, session) {
    if (req.headers.origin !== origin || !session) return false
    if (req.headers['x-csrf-token'] !== undefined) return sameSecret(req.headers['x-csrf-token'], session.csrf)
    // The no-script Sign out form posts its token in the body.
    if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') return false
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1024) return false
    }
    return sameSecret(new URLSearchParams(body).get('csrf') ?? undefined, session.csrf)
  }

  /** The access policy, applied to Blaxel's own record of the person. */
  function admit(person) {
    if (!person.emailVerified) throw new AuthFailure(403, `Verify ${person.email} with Blaxel first, then sign in again.`, 'unverified')
    const email = allowedEmail(person.email, domains)
    if (!email) throw new AuthFailure(403, `${person.email} isn't a ${domains.map(d => '@' + d).join(' or ')} address.`, 'not_allowed')
    return email
  }

  async function start(req, res) {
    sweep()
    if (now() - windowStart >= 60_000) { windowStart = now(); started = 0 }
    if (started >= STARTS_PER_MINUTE) {
      res.setHeader('Retry-After', '60')
      page(res, 429, { error: { code: 'busy', message: 'Lots of people are signing in right now. Try again in a minute.' } })
      return
    }
    started++
    const next = safeNext(new URL(req.url ?? '/', origin).searchParams.get('next'))
    let begun
    try { begun = await oidc.begin() } catch (error) {
      if (!(error instanceof AuthFailure)) throw error
      page(res, error.status, { next, error: { code: 'failed', message: error.message } })
      return
    }
    // Each tab's sign-in rides along in this browser's sealed cookie, so several can be in flight at once.
    const list = [...inFlight(req), { ...begun.attempt, next, expiresAt: now() + ATTEMPT_TTL }].slice(-ATTEMPTS_PER_BROWSER)
    res.writeHead(303, { Location: begun.url, 'Set-Cookie': signinCookie(list) })
    res.end()
  }

  async function callback(req, res) {
    const params = new URL(req.url ?? '/', origin).searchParams
    const state = params.get('state') ?? ''
    const list = inFlight(req)
    const attempt = list.find(a => sameSecret(a.state, state))
    if (!attempt) {
      console.warn(`[auth] callback refused: ${list.length ? 'unknown state' : 'no sign-in in flight in this browser'}`)
      page(res, 400, { error: { code: 'expired', message: 'That sign-in expired or was started in another browser. Start again here.' } })
      return
    }
    // Single use, whatever happens next.
    used.set(attempt.state, attempt.expiresAt)
    const rest = list.filter(a => a !== attempt)
    res.setHeader('Set-Cookie', signinCookie(rest))
    if (params.get('error')) {
      console.warn(`[auth] Blaxel returned ${String(params.get('error')).replace(/[^\w.-]/g, '').slice(0, 40)}`)
      const canceled = params.get('error') === 'access_denied'
      page(res, 400, { next: attempt.next, error: { code: canceled ? 'canceled' : 'failed', message: canceled ? 'Sign-in was canceled in Blaxel.' : 'Blaxel couldn\'t complete the sign-in. Please try again.' } })
      return
    }
    let person, email
    try {
      person = await oidc.complete(params.get('code'), attempt)
      email = admit(person)
    } catch (error) {
      if (!(error instanceof AuthFailure)) throw error
      console.warn(`[auth] sign-in refused (${error.code ?? error.status}): ${error.message}`)
      page(res, error.status, { next: attempt.next, error: { code: error.code ?? 'failed', message: error.message } })
      return
    }
    if (sessions.size >= MAX_SESSIONS) sweep()
    if (sessions.size >= MAX_SESSIONS) {
      page(res, 503, { next: attempt.next, error: { code: 'busy', message: 'Sign-in is busy. Please try again later.' } })
      return
    }
    // Signing in again replaces this browser's earlier session; a new random ID is never derived from the old one.
    const previous = read(req)
    if (previous.id) sessions.delete(previous.id)
    const id = random()
    sessions.create(id, { csrf: random(), sub: person.sub, email, name: person.name, createdAt: now(), expiresAt: now() + SESSION_TTL })
    console.log(`[auth] signed in: ${email}`)
    res.writeHead(303, { Location: attempt.next, 'Set-Cookie': [cookie(SESSION, id, SESSION_TTL / 1000), signinCookie(rest)] })
    res.end()
  }

  async function logout(req, res) {
    const { id, session } = read(req)
    if (session && !(await csrfValid(req, session))) { json(res, 403, { error: 'Please reload this page and try again.' }); return }
    // The deletion commits before the response confirms sign-out or clears the cookie.
    if (id) sessions.delete(id)
    const cleared = cookie(SESSION, '', 0)
    if (req.headers.accept === 'application/json') res.writeHead(204, { 'Set-Cookie': cleared }).end()
    else res.writeHead(303, { Location: '/login', 'Set-Cookie': cleared }).end()
  }

  return {
    /** Serves /login and /auth/*. Returns true when the request was handled. */
    async handle(req, res, path) {
      if (req.method === 'GET' && path === '/login') {
        const next = safeNext(new URL(req.url ?? '/', origin).searchParams.get('next'))
        if (read(req).session) { res.writeHead(303, { Location: next }).end(); return true }
        page(res, 200, { next })
        return true
      }
      if (req.method === 'GET' && path === '/auth/start') { await start(req, res); return true }
      if (req.method === 'GET' && path === '/auth/callback') { await callback(req, res); return true }
      if (req.method === 'GET' && path === '/auth/session') {
        const { session } = read(req)
        if (!session) json(res, 401, { error: 'Sign in to view this website.' })
        else json(res, 200, { remainingMs: Math.max(0, session.expiresAt - now()), user: { email: session.email, name: session.name } })
        return true
      }
      if (req.method === 'POST' && path === '/auth/logout') { await logout(req, res); return true }
      return false
    },
    /** The signed-in person for a protected request, or undefined after answering it (sign-in redirect or 401). */
    require(req, res, path) {
      const { session } = read(req)
      if (!session) {
        // The website root always redirects, so anonymous link previews reach the sign-in page.
        if (path === '/' || (req.headers.accept ?? '').includes('text/html')) {
          const next = path === '/' ? '/' : safeNext(req.url)
          res.writeHead(303, { Location: '/login' + (next === '/' ? '' : '?next=' + encodeURIComponent(next)) }).end()
        } else json(res, 401, { error: 'Sign in to view this website.' })
        return undefined
      }
      return { csrf: session.csrf, email: session.email, name: session.name }
    },
    close() { clearInterval(sweepTimer); used.clear(); sessions.close(); sealKey.fill(0) },
  }
}
