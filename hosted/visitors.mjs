// Distinct verified addresses per exact domain. Keep only a digest and domain in the sign-in state directory.
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

export function visitorCounts(file) {
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE IF NOT EXISTS visitors (
    domain TEXT NOT NULL, address TEXT NOT NULL, PRIMARY KEY (domain, address)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS tracking (id INTEGER PRIMARY KEY CHECK (id = 1), since TEXT NOT NULL);
  INSERT OR IGNORE INTO tracking VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`)
  const since = db.prepare('SELECT since FROM tracking').get().since
  const seen = db.prepare('SELECT 1 FROM visitors WHERE domain = ? AND address = ?')
  const add = db.prepare('INSERT OR IGNORE INTO visitors VALUES (?, ?)')
  const count = db.prepare('SELECT count(*) AS people FROM visitors WHERE domain = ?')
  return {
    record(email) {
      const domain = email.split('@')[1]
      const address = createHash('sha256').update(email).digest('hex')
      if (!seen.get(domain, address)) add.run(domain, address)
    },
    forDomains(domains) {
      return { since, counts: Object.fromEntries(domains.map(domain => [domain, count.get(domain).people])) }
    },
    close() { db.close() },
  }
}
