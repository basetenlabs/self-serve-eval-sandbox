// "Sign in with Blaxel" as an ordinary web OAuth client: authorization code +
// PKCE + state + nonce against Blaxel's OpenID Connect server, with a
// confidential client registered for this website's exact redirect URI. Blaxel
// tokens are used once, at sign-in, to establish who the person is, and are
// never stored. Ported from Baseten Auto-Optimize (server/auth/oidc.mjs).
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class AuthFailure extends Error {
  constructor(status, message = 'Sign-in could not be verified.', code) {
    super(message)
    this.status = status
    this.code = code
  }
}

const b64url = buffer => Buffer.from(buffer).toString('base64url')
const SKEW_MS = 120_000
const MAX_ACTIVE = 16
const MAX_RESPONSE_BYTES = 64 * 1024
const unverified = () => new AuthFailure(401, 'Blaxel\'s sign-in response could not be verified.')

/**
 * `client` is a registration made ahead of time ({ clientId, clientSecret }); the hosted server
 * receives it from its process environment and never registers or writes a secret itself.
 * Without one, the first sign-in registers this origin's redirect URI with Blaxel's Dynamic
 * Client Registration and keeps it in a private oauth-client.json in `stateDirectory` (local
 * runs), or only in memory when there is no state directory (tests).
 */
export function blaxelOidc({ environment, origin, stateDirectory, client: provided, clientName = 'Baseten Eval Sandbox', fetcher = fetch, now = Date.now }) {
  if (!['dev', 'prod'].includes(environment)) throw new Error('BLAXEL_ENV must be dev or prod')
  const api = environment === 'dev' ? 'https://api.blaxel.dev' : 'https://api.blaxel.ai'
  const domain = environment === 'dev' ? 'blaxel.dev' : 'blaxel.ai'
  const redirectUri = origin + '/auth/callback'
  const credential = value => typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value)
  if (provided && !(credential(provided.clientId) && credential(provided.clientSecret))) throw new Error('Invalid OIDC client credentials')
  const fixed = provided && Object.freeze({ api, client_id: provided.clientId, client_secret: provided.clientSecret, redirect_uris: [redirectUri] })
  const clientFile = !fixed && stateDirectory ? join(stateDirectory, 'oauth-client.json') : undefined
  let metadata, client = fixed, registering, jwks, jwksAt = 0, active = 0

  async function request(url, init = {}) {
    if (active >= MAX_ACTIVE) throw new AuthFailure(503, 'Sign-in is busy. Please try again.')
    active++
    try {
      const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json', ...init.headers } })
      const chunks = []
      let length = 0
      for await (const chunk of response.body ?? []) {
        length += chunk.length
        if (length > MAX_RESPONSE_BYTES) throw new AuthFailure(503)
        chunks.push(chunk)
      }
      let data
      try { data = JSON.parse(Buffer.concat(chunks).toString()) } catch { data = undefined }
      return { status: response.status, data: data && typeof data === 'object' && !Array.isArray(data) ? data : {} }
    } catch (error) {
      if (error instanceof AuthFailure) throw error
      throw new AuthFailure(503, 'Blaxel could not be reached. Please try again.')
    } finally { active-- }
  }

  // Every endpoint, including where the browser is sent, must be Blaxel's own HTTPS host for this environment.
  const blaxelUrl = value => {
    try {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && (url.hostname === domain || url.hostname.endsWith('.' + domain))
    } catch { return false }
  }
  async function discover() {
    if (metadata) return metadata
    const { status, data } = await request(api + '/.well-known/oauth-authorization-server')
    const endpoints = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri']
    if (status !== 200 || !endpoints.every(key => blaxelUrl(data[key])) ||
        ['registration_endpoint', 'userinfo_endpoint'].some(key => data[key] !== undefined && !blaxelUrl(data[key])) ||
        !Array.isArray(data.code_challenge_methods_supported) || !data.code_challenge_methods_supported.includes('S256')) {
      throw new AuthFailure(503, 'Blaxel sign-in is unavailable right now. Please try again.')
    }
    metadata = data
    return metadata
  }

  // Opened once without following links; the checks and the read apply to that same open file.
  function readClient() {
    if (!clientFile) return undefined
    let fd
    try { fd = openSync(clientFile, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
    try {
      const info = fstatSync(fd)
      if (!info.isFile() || (info.mode & 0o077) || info.uid !== process.getuid() || info.size > 4096) throw new Error(`${clientFile} must be a small private file (mode 600)`)
      const saved = JSON.parse(readFileSync(fd, 'utf8'))
      if (saved.api === api && saved.redirect_uris?.length === 1 && saved.redirect_uris[0] === redirectUri &&
          typeof saved.client_id === 'string' && saved.client_id && typeof saved.client_secret === 'string' && saved.client_secret) return saved
      return undefined
    } finally { closeSync(fd) }
  }
  // Written beside the final name and renamed into place, so a reader never sees a partial file.
  function saveClient(saved) {
    if (!clientFile) return
    const temporary = `${clientFile}.${b64url(randomBytes(9))}.tmp`
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(fd, JSON.stringify(saved, null, 2)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, clientFile)
    const parent = openSync(stateDirectory, constants.O_RDONLY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  }
  async function register() {
    const { registration_endpoint: endpoint } = await discover()
    if (!endpoint) throw new AuthFailure(503, 'Blaxel sign-in is unavailable right now. Please try again.')
    const { status, data } = await request(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: clientName, redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_post' }),
    })
    // Only printable, bounded credentials are kept, so a registration response can't smuggle anything else into the file.
    if (status !== 201 || !credential(data.client_id) || !credential(data.client_secret)) {
      throw new AuthFailure(503, 'This website could not register with Blaxel sign-in.')
    }
    const saved = { api, client_id: String(data.client_id), client_secret: String(data.client_secret), redirect_uris: [redirectUri], registered_at: new Date(now()).toISOString() }
    saveClient(saved)
    console.log(`[auth] registered OAuth client ${saved.client_id} for ${redirectUri}`)
    return saved
  }
  async function registeredClient() {
    if (client) return client
    client = readClient()
    if (client) return client
    // Concurrent first sign-ins share one registration.
    registering ??= register().finally(() => { registering = undefined })
    client = await registering
    return client
  }
  // Blaxel no longer knows this client (for example, it was deleted); register again on the next sign-in.
  // A registration supplied by the operator can only be replaced by the operator.
  function forgetClient(stale) {
    if (stale === fixed) {
      console.error('[auth] Blaxel rejected the configured OIDC client; delete oauth-client.json in the state directory to register a new one')
      throw new AuthFailure(503, 'Blaxel sign-in is unavailable right now. Please try again later.', 'failed')
    }
    if (client !== stale) return
    client = undefined
    if (clientFile) try { unlinkSync(clientFile) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }

  async function signingKey(kid) {
    const { jwks_uri: uri } = await discover()
    const known = () => jwks?.keys?.some(key => key.kid === kid)
    // An unknown key ID refreshes the key set, at most once a minute.
    if (!jwks || (!known() && now() - jwksAt > 60_000)) {
      const { status, data } = await request(uri)
      if (status !== 200 || !Array.isArray(data.keys)) throw new AuthFailure(503, 'Blaxel sign-in is unavailable right now. Please try again.')
      jwks = data
      jwksAt = now()
    }
    const jwk = jwks.keys.find(key => key?.kid === kid && key.kty === 'RSA' && (key.use === undefined || key.use === 'sig') && (key.alg === undefined || key.alg === 'RS256'))
    if (!jwk) throw unverified()
    try { return createPublicKey({ key: jwk, format: 'jwk' }) } catch { throw unverified() }
  }

  async function verifyIdToken(token, nonce, registered) {
    const parts = typeof token === 'string' ? token.split('.') : []
    if (parts.length !== 3) throw unverified()
    let header, claims
    try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); claims = JSON.parse(Buffer.from(parts[1], 'base64url')) } catch { throw unverified() }
    if (!header || !claims || typeof claims !== 'object') throw unverified()
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new AuthFailure(401, 'Blaxel\'s sign-in response used an unexpected signature.')
    const key = await signingKey(header.kid)
    if (!verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), key, Buffer.from(parts[2], 'base64url'))) throw unverified()
    const { issuer } = await discover()
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (claims.iss !== issuer || !audience.includes(registered.client_id) || (audience.length > 1 && claims.azp !== registered.client_id) ||
        !Number.isFinite(claims.exp) || claims.exp * 1000 < now() - SKEW_MS ||
        (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat * 1000 > now() + SKEW_MS)) ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf * 1000 > now() + SKEW_MS)) ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 || typeof nonce !== 'string' || claims.nonce !== nonce) {
      throw unverified()
    }
    return claims
  }

  /**
   * Who signed in. The signed ID token is the primary source; when it lacks a
   * verified-email claim, Blaxel's OIDC userinfo endpoint answers with the same
   * token. (Blaxel's /v0/profile API rejects OAuth-app tokens.)
   */
  async function identityOf(claims, accessToken) {
    const name = person => [person.given_name, person.family_name].filter(part => typeof part === 'string' && part.trim()).join(' ').trim().slice(0, 120) ||
      (typeof person.name === 'string' && person.name.trim() ? person.name.trim().slice(0, 120) : undefined)
    if (typeof claims.email === 'string' && typeof claims.email_verified === 'boolean') {
      return { sub: claims.sub, email: claims.email.trim().toLowerCase(), emailVerified: claims.email_verified, name: name(claims) }
    }
    const { userinfo_endpoint: endpoint } = await discover()
    if (!endpoint) throw new AuthFailure(503, 'Blaxel did not share a verified email for this account.')
    const info = await request(endpoint, { headers: { Authorization: 'Bearer ' + accessToken } })
    if (info.status !== 200 || typeof info.data.email !== 'string') {
      console.warn(`[auth] userinfo answered ${info.status}`)
      throw new AuthFailure(503, 'Your Blaxel account details could not be read. Please try again.')
    }
    // userinfo must describe the same person the ID token names.
    if (info.data.sub !== claims.sub) throw new AuthFailure(401, 'Blaxel returned inconsistent account details. Please try again.')
    return { sub: claims.sub, email: info.data.email.trim().toLowerCase(), emailVerified: info.data.email_verified === true, name: name({ ...claims, ...info.data }) }
  }

  return {
    /** A fresh, browser-bound sign-in attempt and the Blaxel URL that starts it. */
    async begin() {
      const [{ authorization_endpoint: endpoint }, { client_id }] = await Promise.all([discover(), registeredClient()])
      const attempt = { state: b64url(randomBytes(32)), nonce: b64url(randomBytes(32)), verifier: b64url(randomBytes(48)) }
      const url = new URL(endpoint)
      url.search = new URLSearchParams({
        response_type: 'code', client_id, redirect_uri: redirectUri, scope: 'openid email profile',
        state: attempt.state, nonce: attempt.nonce,
        code_challenge: b64url(createHash('sha256').update(attempt.verifier).digest()), code_challenge_method: 'S256',
      }).toString()
      return { attempt, url: url.href }
    },
    /** Exchanges the code, verifies the ID token and returns identity only. Blaxel's tokens go out of scope here. */
    async complete(code, attempt) {
      if (typeof code !== 'string' || !code || code.length > 2048) throw new AuthFailure(400, 'Blaxel returned an incomplete sign-in. Please try again.', 'failed')
      const [{ token_endpoint: endpoint }, registered] = await Promise.all([discover(), registeredClient()])
      const { status, data } = await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: registered.client_id, client_secret: registered.client_secret, code_verifier: attempt.verifier }).toString(),
      })
      if ((status === 400 || status === 401) && data.error === 'invalid_client') {
        forgetClient(registered)
        throw new AuthFailure(503, 'Blaxel sign-in had to be set up again. Please try again.', 'failed')
      }
      if (status === 400 || status === 401) throw new AuthFailure(401, 'That sign-in expired or was already used. Please try again.', 'expired')
      if (status !== 200 || typeof data.access_token !== 'string' || typeof data.id_token !== 'string') throw new AuthFailure(503, 'Blaxel sign-in could not be completed. Please try again.', 'failed')
      const claims = await verifyIdToken(data.id_token, attempt.nonce, registered)
      return await identityOf(claims, data.access_token)
    },
    /** Registers this origin's redirect URI with Blaxel and returns the new client, keeping it only where configured. */
    register,
    redirectUri,
    /** Blaxel's account page, for switching to another account. */
    accountUrl: environment === 'dev' ? 'https://app.blaxel.dev' : 'https://app.blaxel.ai',
  }
}
