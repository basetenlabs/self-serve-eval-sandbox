import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const SESSION_TTL = 7 * 24 * 60 * 60_000
export const MAX_SESSIONS = 1000
const hash = id => createHash('sha256').update(id).digest('hex')
const failure = () => new Error('Persistent session storage is unavailable')

export function privateEntry(path, directory = false) {
  const info = lstatSync(path)
  if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o077) || info.uid !== process.getuid()) throw failure()
  return info
}

// Sessions hold identity only (who signed in and when). No Blaxel credential is ever stored.
function valid(session) {
  return session && ['csrf', 'sub', 'email'].every(key => typeof session[key] === 'string' && session[key].length > 0 && session[key].length <= 1024) &&
    (session.name === undefined || (typeof session.name === 'string' && session.name.length <= 200)) &&
    Number.isSafeInteger(session.createdAt) && Number.isSafeInteger(session.expiresAt) &&
    session.expiresAt > session.createdAt && session.expiresAt - session.createdAt <= SESSION_TTL
}

/**
 * Before Blaxel OIDC, this directory held the device-flow sign-in's encrypted
 * Blaxel access and refresh tokens (sessions.sqlite and session.key). Erase the
 * rows with secure_delete, then remove the files. A rollback to that server
 * starts with an empty store and asks everyone to sign in again.
 */
export function retireLegacySessions(directory) {
  if (!directory) return false
  const base = resolve(directory)
  const database = join(base, 'sessions.sqlite')
  let found = false
  try {
    if (lstatSync(database).isFile()) {
      found = true
      let legacy
      try {
        legacy = new DatabaseSync(database)
        legacy.exec('PRAGMA secure_delete = ON; DELETE FROM sessions;')
      } catch { /* Unreadable: removing the file below still retires it. */ } finally { legacy?.close() }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const name of ['sessions.sqlite-journal', 'sessions.sqlite', 'session.key']) {
    try { unlinkSync(join(base, name)); found = true } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return found
}

// Only authenticated sessions reach this store; sign-ins in flight live in a sealed browser cookie.
// SQLite commits before login/logout responds. The deployment controller stops the previous
// server before starting its replacement.
// `key` is the 32-byte encryption key, supplied by the caller: the hosted server derives it from
// SESSION_KEY in its process environment, so the durable volume holds ciphertext only.
// `scope` names the access policy (the allowed email domains). Changing it, the origin, the
// environment or the key ends every stored session rather than reinterpreting it.
export function sessionStore({ directory, key: suppliedKey, origin, scope, environment, now = Date.now }) {
  if (!Buffer.isBuffer(suppliedKey) || suppliedKey.length !== 32) throw failure()
  const key = Buffer.from(suppliedKey)
  const context = JSON.stringify({ version: 2, origin, scope, environment, key: createHash('sha256').update('eval-session-key-id:').update(key).digest('hex').slice(0, 16) })
  let database
  try {
    let path = ':memory:'
    if (directory) {
      const base = resolve(directory)
      mkdirSync(base, { recursive: true, mode: 0o700 })
      privateEntry(base, true)
      path = join(base, 'sessions.sqlite')
      try { privateEntry(path) } catch (error) {
        if (error.code !== 'ENOENT') throw error
        closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600))
      }
    }
    database = new DatabaseSync(path)
    database.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA secure_delete = ON;
      PRAGMA max_page_count = 4096;
      CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id = 1), context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, payload BLOB NOT NULL) STRICT;`)
    database.prepare('INSERT OR IGNORE INTO metadata VALUES (1, ?)').run(context)
    if (database.prepare('SELECT context FROM metadata WHERE id = 1').get()?.context !== context) {
      database.exec('DELETE FROM sessions')
      database.prepare('UPDATE metadata SET context = ? WHERE id = 1').run(context)
    }
  } catch {
    database?.close()
    key.fill(0)
    throw failure()
  }
  const cache = new Map()
  const read = database.prepare('SELECT expires, payload FROM sessions WHERE id = ?')
  const count = database.prepare('SELECT count(*) AS count FROM sessions')
  const remove = database.prepare('DELETE FROM sessions WHERE id = ?')
  const expired = database.prepare('DELETE FROM sessions WHERE expires <= ?')
  const insert = database.prepare('INSERT INTO sessions SELECT ?, ?, ? WHERE (SELECT count(*) FROM sessions) < ?')
  const aad = id => Buffer.from(context + ':' + id)
  // Only these fields are ever stored or cached.
  function encode(id, session) {
    if (!valid(session)) throw failure()
    const { csrf, sub, email, name, createdAt, expiresAt } = session
    const stored = { csrf, sub, email, name, createdAt, expiresAt }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aad(id))
    const bytes = Buffer.from(JSON.stringify(stored))
    return { stored, payload: Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]) }
  }
  return {
    get size() { return count.get().count },
    get(id) {
      const digest = hash(id)
      const row = read.get(digest)
      if (!row || row.expires <= now()) { cache.delete(digest); return undefined }
      const payload = Buffer.from(row.payload)
      const cached = cache.get(digest)
      if (cached?.payload.equals(payload)) return cached.session
      try {
        if (payload.length < 29 || payload.length > 65536) throw failure()
        const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
        decipher.setAAD(aad(digest))
        decipher.setAuthTag(payload.subarray(-16))
        const session = JSON.parse(Buffer.concat([decipher.update(payload.subarray(12, -16)), decipher.final()]))
        if (!valid(session) || session.expiresAt !== row.expires || session.createdAt > now()) throw failure()
        cache.set(digest, { payload, session })
        return session
      } catch { throw failure() }
    },
    create(id, session) {
      const digest = hash(id)
      const { stored, payload } = encode(digest, session)
      if (insert.run(digest, stored.expiresAt, payload, MAX_SESSIONS).changes !== 1) throw failure()
      cache.set(digest, { payload, session: stored })
    },
    delete(id) {
      if (!id) return
      const digest = hash(id)
      remove.run(digest)
      cache.delete(digest)
    },
    sweep() {
      expired.run(now())
      for (const [id, entry] of cache) if (entry.session.expiresAt <= now()) cache.delete(id)
    },
    close() { cache.clear(); database.close(); key.fill(0) },
  }
}
