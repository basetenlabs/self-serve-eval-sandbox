import { randomBytes } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPolicy, createSiteServer, loadBrand, loadConfig, renderLogin } from '@blaxel/sign-in'
import { accessHandlers, SEED, seedAccess } from './access.mjs'
import { visitorCounts } from './visitors.mjs'
import { resendMailer } from './mailer.mjs'
import { accessRequests, inviteLink } from './requests.mjs'
import config from './site.config.mjs'

const quiet = { info() {}, warn() {}, error() {} }
const ADMINS = { PR_EVAL_ADMINS: 'lead@baseten.co, lead@blaxel.ai' }
const folder = t => {
  const dir = mkdtempSync(join(tmpdir(), 'pr-eval-access-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The admin API behind a plain HTTP server; the test names the signed-in person in a header. */
async function serve(t, file, { ownerEmail, secret = randomBytes(32).toString('hex') } = {}) {
  const visitors = visitorCounts(':memory:')
  t.after(() => visitors.close())
  const access = accessHandlers({ file, secret, ownerEmail, visitors, log: quiet })
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (await access.api(req, res, { path, session: { user: { email: req.headers['x-test-email'] } } }) === false) res.writeHead(404).end()
  })
  access.attach(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, headers, body) => {
    const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  return {
    get: email => call('/api/admin/access', { 'x-test-email': email }),
    post: (email, body) => call('/api/admin/access', { 'x-test-email': email }, body),
    request: (email, body) => call('/api/access-requests', { 'x-test-email': email }, body),
    machine: (body, bearer = secret) => call('/api/worker/access-requests', { authorization: 'Bearer ' + bearer }, body),
  }
}

test('a refused account gets the shared access instructions from sign-in 0.4.3', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))
  assert.equal(pkg.dependencies['@blaxel/sign-in'], 'npm:@blaxel-ai/sign-in@0.4.3')
  const html = renderLogin({
    brand: loadBrand(config.brand, fileURLToPath(new URL('./', import.meta.url))),
    policy: createPolicy({ ...config.access, file: join(tmpdir(), 'no-such-access.json'), log: quiet }),
    origin: 'http://localhost',
    state: { code: 'not_allowed', message: 'This account is not on the list.' },
    blaxelSignOut: 'https://app.blaxel.ai/logout',
  })
  assert.match(html, /This account can&#39;t get in/)
  assert.match(html, /Ask an Eval Sandbox admin to add you\./)
})

test('a deploy keeps sessions: every release reads the access file deploy.py names, so the session scope stays', async t => {
  // Sessions end when policy.scope changes, and the scope hashes the access file's path. Each release's own
  // ../data/access.json is a different path; AUTH_ACCESS_FILE (deploy.py ACCESS) is the same one every time.
  const root = folder(t)
  const policy = async (release, env = {}) => {
    const hosted = join(root, 'releases', release, 'hosted') // a release as deploy.py lays it out
    if (!existsSync(hosted)) {
      mkdirSync(join(hosted, '..'), { recursive: true })
      symlinkSync(fileURLToPath(new URL('./', import.meta.url)), hosted)
    }
    return (await loadConfig({ file: join(hosted, 'site.config.mjs'), env: { ...env, AUTH_STATE_DIR: root }, log: quiet })).policy
  }
  const shared = { AUTH_ACCESS_FILE: '/data/app/data/access.json' }
  const before = await policy('20261111-080000-aaaaaaa', shared), after = await policy('20261111-081500-d131a6e', shared)
  assert.equal(before.file, '/data/app/data/access.json')
  assert.equal(after.scope, before.scope)
  // Without it, as before this fix: each release's own path, a new scope, everyone signed out.
  assert.notEqual((await policy('20261111-080000-aaaaaaa')).scope, (await policy('20261111-081500-d131a6e')).scope)
})

test('who may sign in comes only from the access file, which starts with the seed', async t => {
  assert.deepEqual(Object.keys(config.access), ['file'])
  const file = join(folder(t), 'data', 'access.json')
  assert.equal(await seedAccess(file, quiet, ADMINS), true)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { admins: ['lead@baseten.co', 'lead@blaxel.ai'], emails: [], domains: [...SEED.domains].sort() })
  writeFileSync(file, JSON.stringify({ admins: ['a@baseten.co'], emails: [], domains: [] }))
  assert.equal(await seedAccess(file, quiet), false) // an existing file is never replaced
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).admins[0], 'a@baseten.co')
})

test('approval admits an outside email or domain and denial keeps access closed', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const policy = createPolicy({ file, log: quiet })
  const api = await serve(t, file)
  assert.equal(policy.check('lead@baseten.co'), 'allowed')
  assert.equal(policy.check('someone@blaxel.ai'), 'allowed')
  assert.equal(policy.check('guest@example.org'), 'refused')

  assert.deepEqual((await api.get('lead@baseten.co')).body.visitors.counts, { 'baseten.co': 0, 'blaxel.ai': 0 })
  const who = 'staff@baseten.co'
  const ask = target => api.request(who, { target, reason: 'Review the eval', requestedBy: 'other@blaxel.ai', status: 'approved' })
  const decide = (id, status) => api.machine({ id, status, decidedBy: 'U1234' })
  const { body: email } = await ask(' Guest@Example.org ')
  assert.equal(email.status, 'pending')
  assert.equal(email.requestedBy, who)
  assert.equal((await ask('guest@example.org')).status, 409)
  assert.equal(policy.check(email.target), 'refused')
  assert.equal((await api.request('other@blaxel.ai')).body.requests.length, 0)
  assert.equal((await api.machine(undefined, '')).status, 401)
  assert.equal((await api.machine(undefined, 'wrong')).status, 401)
  assert.equal((await api.machine()).body.requests[0].id, email.id)
  assert.equal((await decide(email.id, 'approved')).body.status, 'approved')
  assert.equal(policy.check('guest@example.org'), 'allowed')
  assert.equal(policy.check('other@example.org'), 'refused')
  const { body: domain } = await ask('@example.org')
  const decisions = await Promise.all(['approved', 'denied'].map(status => decide(domain.id, status)))
  assert.deepEqual(decisions[0].body, decisions[1].body)
  if (decisions[0].body.status === 'denied') {
    const retry = await ask('example.org')
    await decide(retry.body.id, 'approved')
  }
  assert.equal(policy.check('other@example.org'), 'allowed')
  const denied = (await ask('denied.example')).body
  await decide(denied.id, 'denied')
  const later = await decide(denied.id, 'approved')
  assert.equal(later.body.status, 'denied')
  assert.equal(policy.check('staff@denied.example'), 'refused')
  const seen = (await api.request(who)).body.requests
  assert.ok(seen.some(r => r.id === denied.id && r.decidedAt && r.decidedBy === 'U1234' && r.decisionMethod === 'worker' && r.status === 'denied'))
  assert.deepEqual((await api.machine()).body.requests, [])
  assert.equal((await api.post('lead@blaxel.ai', { list: 'domains', value: 'example.org', remove: true })).status, 200)
  assert.equal((await api.post('lead@blaxel.ai', { list: 'emails', value: 'guest@example.org', remove: true })).status, 200)
  await decide(email.id, 'approved') // a replay cannot restore a later revocation
  assert.equal(policy.check('guest@example.org'), 'refused')
  assert.equal(policy.check('other@example.org'), 'refused')
  assert.deepEqual(readdirSync(join(file, '..')), ['access.json']) // written by rename: no temporary file left
})

test('only the configured current admin can grant outside access while the worker is offline', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const owner = 'lead@baseten.co'
  const other = 'lead@blaxel.ai'
  const api = await serve(t, file, { ownerEmail: ' Lead@Baseten.co ', secret: '' })
  assert.equal((await api.get(owner)).body.canGrantDirectly, true)
  assert.equal((await api.get(other)).body.canGrantDirectly, false)
  assert.equal((await api.request(owner, { target: 'guest@example.org', reason: 'Demo' })).status, 503)
  const policy = createPolicy({ file, log: quiet })
  for (const [list, value, email] of [['emails', 'Guest@Example.org', 'guest@example.org'], ['domains', 'Example.net', 'other@example.net']]) {
    assert.equal((await api.post(other, { list, value, canGrantDirectly: true })).status, 403)
    assert.equal(policy.check(email), 'refused')
    assert.equal((await api.post(owner, { list, value })).status, 200)
    assert.equal(policy.check(email), 'allowed')
    assert.equal((await api.post(owner, { list, value })).status, 200)
  }
  const restarted = await serve(t, file, { ownerEmail: owner })
  const { requests } = (await restarted.request(owner)).body
  assert.equal(requests.length, 2)
  for (const row of requests) {
    assert.equal(row.status, 'approved')
    assert.equal(row.decidedBy, owner)
    assert.equal(row.decisionMethod, 'direct')
    assert.ok(row.id && Date.parse(row.decidedAt))
  }
  assert.deepEqual(requests.map(r => [r.list, r.target]), [['domains', 'example.net'], ['emails', 'guest@example.org']])
  assert.deepEqual((await restarted.request(other)).body.requests, [])
  assert.deepEqual((await restarted.machine()).body.requests, [])
  assert.equal((await restarted.post(owner, { list: 'admins', value: 'guest@example.org' })).status, 403)
  await restarted.post(other, { list: 'admins', value: owner, remove: true })
  assert.equal((await restarted.post(owner, { list: 'domains', value: 'example.edu' })).status, 403)
})

test('a direct grant settles pending requests once and survives a late worker decision', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const owner = 'lead@baseten.co'
  const api = await serve(t, file, { ownerEmail: owner })
  const staff = 'staff@blaxel.ai'
  const request = { target: 'guest@example.org', reason: 'Review the eval' }
  const first = (await api.request(staff, request)).body
  const second = (await api.request('other@baseten.co', request)).body
  const grant = { list: 'emails', value: request.target }
  assert.equal((await api.post(owner, grant)).status, 200)
  assert.deepEqual((await api.machine()).body.requests, [])
  const history = (await api.request(owner)).body.requests
  assert.deepEqual(history.map(r => r.id), [second.id, first.id])
  assert.deepEqual((await api.request(staff)).body.requests, [history[1]])
  assert.equal(history[1].requestedBy, staff)
  assert.equal(history[1].reason, request.reason)
  assert.equal(history[1].decidedBy, owner)
  assert.equal(history[1].decisionMethod, 'direct')
  assert.equal((await api.post(owner, { ...grant, remove: true })).status, 200)
  assert.deepEqual((await api.machine({ id: first.id, status: 'approved', decidedBy: 'U1234' })).body, history[1])
  assert.deepEqual((await api.get(owner)).body.emails, [])
})

test('a missing or invalid single owner disables direct grants', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  for (const ownerEmail of [undefined, 'lead@baseten.co,lead@blaxel.ai']) {
    const api = await serve(t, file, { ownerEmail })
    assert.equal((await api.get('lead@baseten.co')).body.canGrantDirectly, false)
    assert.equal((await api.post('lead@baseten.co', { list: 'domains', value: 'example.org' })).status, 403)
  }
})

test('domain counts survive restart and count distinct signed-in addresses at the exact domain', t => {
  const file = join(folder(t), 'visitors.sqlite')
  const first = visitorCounts(file)
  for (const address of ['one@example.org', 'two@example.org', 'one@example.org', 'one@sub.example.org']) first.record(address)
  const before = first.forDomains(['example.org', 'other.org'])
  assert.deepEqual(before.counts, { 'example.org': 2, 'other.org': 0 })
  first.close()
  const reopened = visitorCounts(file)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.forDomains(['example.org', 'other.org']), before)
})

test('only admins read or change the list, checked against the file on every request', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const api = await serve(t, file)
  for (const who of ['someone@baseten.co', undefined]) {
    assert.equal((await api.get(who)).status, 403)
    assert.equal((await api.post(who, { list: 'admins', value: 'someone@baseten.co' })).status, 403)
  }
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).admins.length, 2)

  const promoted = await api.post('lead@blaxel.ai', { list: 'admins', value: 'someone@baseten.co' })
  assert.deepEqual(promoted.body.admins, ['lead@baseten.co', 'lead@blaxel.ai', 'someone@baseten.co'])
  assert.equal((await api.get('someone@baseten.co')).status, 200)
  await api.post('someone@baseten.co', { list: 'admins', value: 'lead@blaxel.ai', remove: true })
  assert.equal((await api.get('lead@blaxel.ai')).status, 403) // removed a moment ago: no longer an admin
})

test('entries follow the sign-in rules, and the last admin stays', async t => {
  const file = join(folder(t), 'access.json')
  writeFileSync(file, JSON.stringify({ admins: ['only@baseten.co'], emails: [], domains: [] }))
  const api = await serve(t, file)
  const as = body => api.post('only@baseten.co', body)
  assert.match((await as({ list: 'domains', value: 'gmail.com' })).body.error, /public email provider/)
  assert.match((await as({ list: 'domains', value: '*.partner.io' })).body.error, /wildcard/)
  assert.match((await as({ list: 'emails', value: '*@partner.io' })).body.error, /not a valid email/)
  assert.match((await as({ list: 'owners', value: 'x@partner.io' })).body.error, /which list/)
  const last = await as({ list: 'admins', value: 'only@baseten.co', remove: true })
  assert.equal(last.status, 400)
  assert.match(last.body.error, /last admin/)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { admins: ['only@baseten.co'], emails: [], domains: [] })
})

test('direct outside grants and requests by prospects are refused, and submissions stay bounded across restart', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const api = await serve(t, file)
  const staff = 'staff@blaxel.ai'
  const body = { target: 'person@example.com', reason: 'Review the eval' }
  for (const email of ['guest@example.com', 'user@baseten.co.example', 'missing']) {
    assert.equal((await api.request(email, body)).status, 403)
    assert.equal((await api.request(email)).status, 403)
  }
  for (const [list, value] of [['admins', 'guest@example.com'], ['emails', 'guest@example.com'], ['domains', 'example.com']]) {
    assert.equal((await api.post('lead@baseten.co', { list, value })).status, 403)
  }
  assert.equal((await api.request(staff, { ...body, reason: '  ' })).status, 400)
  assert.equal((await api.request(staff, { ...body, target: 'gmail.com' })).status, 400)
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, (_, i) =>
    api.request(staff, { ...body, target: `person${i}@example.com` }).then(r => r.status))), [200, 200, 200, 200, 200])
  const restarted = await serve(t, file)
  assert.equal((await restarted.request(staff, body)).status, 429)
  assert.equal((await restarted.machine()).body.requests.length, 5)
  assert.equal((await restarted.get('lead@baseten.co')).body.requests, undefined)
})

test('the worker endpoint is the only route ahead of browser sign-in', async t => {
  const dir = folder(t)
  const file = join(dir, 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const env = { AUTH_STATE_DIR: dir, AUTH_ACCESS_FILE: file }
  const config = await loadConfig({ env, file: fileURLToPath(new URL('./site.config.mjs', import.meta.url)), log: quiet })
  const secret = randomBytes(32).toString('hex')
  const access = accessHandlers({ file, secret })
  const server = await createSiteServer({ config, env, api: access.api, log: quiet, app: () => assert.fail('upstream reached'),
    fetcher: () => assert.fail('network reached') })
  access.attach(server)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const origin = `http://127.0.0.1:${server.address().port}`
  const headers = { accept: 'application/json', authorization: 'Bearer ' + secret }
  for (const path of ['/api/access-requests', '/api/admin/access', '/api/worker/access-requests/extra']) {
    assert.equal((await fetch(origin + path, { headers })).status, 401)
  }
  assert.equal((await fetch(origin + '/api/worker/access-requests')).status, 401)
  assert.deepEqual(await (await fetch(origin + '/api/worker/access-requests', { headers })).json(), { requests: [], next: null })
})

test('an access request emails each current admin, and only them, a link that fills in the invite', async t => {
  const file = join(folder(t), 'access.json')
  writeFileSync(file, JSON.stringify({ admins: ['boss@baseten.co', 'Second@Blaxel.ai'], emails: ['guest@partner.io'], domains: ['baseten.co'] }))
  const sent = []
  const mailer = { send: async message => { sent.push(message) } }
  const hook = accessRequests({ file, origin: 'https://eval.example', mailer, log: quiet })
  await hook({ email: 'new+eval@gmail.com' })
  assert.deepEqual(sent.map(m => m.to), ['boss@baseten.co', 'second@blaxel.ai'], 'admins only: never invited people, domains or the requester')
  assert.equal(sent[0].subject, 'Eval Sandbox: new+eval@gmail.com asked for access')
  assert.ok(sent[0].text.includes('https://eval.example/#/access?invite=new%2Beval%40gmail.com'))
  assert.equal(inviteLink('https://eval.example', 'a@b.io'), 'https://eval.example/#/access?invite=a%40b.io')

  // The file as it is now decides: a new admin gets the next request, a removed one doesn't.
  writeFileSync(file, JSON.stringify({ admins: ['third@baseten.co'] }))
  sent.length = 0
  await hook({ email: 'other@gmail.com' })
  assert.deepEqual(sent.map(m => m.to), ['third@baseten.co'])
})

test('an access request fails, so the person can ask again, only when no admin was reached', async t => {
  const file = join(folder(t), 'access.json')
  writeFileSync(file, JSON.stringify({ admins: ['a@baseten.co', 'b@baseten.co'] }))
  const down = new Set(['a@baseten.co'])
  const mailer = { send: async ({ to }) => { if (down.has(to)) throw new Error('rejected') } }
  const hook = accessRequests({ file, origin: 'https://eval.example', mailer, log: quiet })
  await hook({ email: 'x@gmail.com' }) // one admin reached is enough
  down.add('b@baseten.co')
  await assert.rejects(hook({ email: 'x@gmail.com' }), /no admin could be emailed/)
  writeFileSync(file, '{"admins": [')
  await assert.rejects(hook({ email: 'x@gmail.com' }), /access file can't be read/)
  writeFileSync(file, JSON.stringify({ admins: [], emails: ['x@y.io'] }))
  await assert.rejects(hook({ email: 'x@gmail.com' }), /no admin/)
})

test('the Resend mailer sends one plain-text message per admin, and a refusal throws', async () => {
  const calls = []
  let status = 200
  const fetcher = async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status } }
  const mailer = resendMailer({ key: 'test-key', from: 'Eval Sandbox <eval@example.com>', fetcher })
  await mailer.send({ to: 'boss@baseten.co', subject: 's', text: 't' })
  assert.equal(calls[0].url, 'https://api.resend.com/emails')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key')
  assert.deepEqual(JSON.parse(calls[0].init.body), { from: 'Eval Sandbox <eval@example.com>', to: ['boss@baseten.co'], subject: 's', text: 't' })
  status = 403
  await assert.rejects(mailer.send({ to: 'boss@baseten.co', subject: 's', text: 't' }), /Resend answered 403/)
  assert.throws(() => resendMailer({ from: 'x@y.io' }), /needs a key/)
})
