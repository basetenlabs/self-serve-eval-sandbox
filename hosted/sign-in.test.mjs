import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPolicy, loadBrand, loadConfig, renderLogin } from '@blaxel/sign-in'
import { adminApi, SEED, seedAccess } from './access.mjs'
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
async function serve(t, file) {
  const api = adminApi({ file, log: quiet })
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    if (await api(req, res, { path, session: { user: { email: req.headers['x-test-email'] } } }) === false) res.writeHead(404).end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const base = `http://127.0.0.1:${server.address().port}/api/admin/access`
  return {
    get: async email => { const r = await fetch(base, { headers: { 'x-test-email': email } }); return { status: r.status, body: await r.json() } },
    post: async (email, body) => {
      const r = await fetch(base, { method: 'POST', headers: { 'x-test-email': email, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: r.status, body: await r.json() }
    },
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

test('an invited outside email gets in and an uninvited one does not, live from the file an admin edits', async t => {
  const file = join(folder(t), 'access.json')
  await seedAccess(file, quiet, ADMINS)
  const policy = createPolicy({ file, log: quiet })
  const api = await serve(t, file)
  assert.equal(policy.check('lead@baseten.co'), 'allowed')
  assert.equal(policy.check('someone@blaxel.ai'), 'allowed')
  assert.equal(policy.check('guest@partner.io'), 'refused')

  const added = await api.post('lead@baseten.co', { list: 'emails', value: ' Guest@Partner.io ' })
  assert.equal(added.status, 200)
  assert.deepEqual(added.body.emails, ['guest@partner.io'])
  assert.equal(policy.check('guest@partner.io'), 'allowed')
  assert.equal(policy.check('other@partner.io'), 'refused')

  assert.equal((await api.post('lead@baseten.co', { list: 'domains', value: '@partner.io' })).status, 200)
  assert.equal(policy.check('other@partner.io'), 'allowed')
  assert.equal((await api.post('lead@blaxel.ai', { list: 'domains', value: 'partner.io', remove: true })).status, 200)
  assert.equal((await api.post('lead@blaxel.ai', { list: 'emails', value: 'guest@partner.io', remove: true })).status, 200)
  assert.equal(policy.check('guest@partner.io'), 'refused')
  assert.equal(policy.check('other@partner.io'), 'refused')
  assert.deepEqual(readdirSync(join(file, '..')), ['access.json']) // written by rename: no temporary file left
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
