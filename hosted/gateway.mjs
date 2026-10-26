// The hosted eval page: "Sign in with Blaxel" in front of `pr-eval serve`.
//
// `pr-eval serve` only answers 127.0.0.1, so this gateway is the one public door. It serves the
// sign-in pages, and passes every other request from a signed-in person to the page, as if it came
// from the page's own origin. Runs spend money, so a request that changes anything must also come
// from this site (its Origin header), and it is logged with who sent it.
import { readdir, readFile } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AuthFailure, blaxelAuth } from './auth.mjs'

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const localOrigin = url => url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)
const MAX_BODY = 64 * 1024
// What the page needs from the browser's request; cookies and anything else stay here.
const FORWARD = ['accept', 'accept-encoding', 'content-type', 'if-modified-since', 'if-none-match', 'range']

export async function gateway({ origin, upstream, environment, stateDirectory, fetcher, now = Date.now }) {
  const publicUrl = new URL(origin)
  if ((publicUrl.protocol !== 'https:' && !localOrigin(publicUrl)) || publicUrl.origin !== origin) throw new Error('APP_ORIGIN must be an exact HTTPS origin, or http://localhost for a local run')
  const asset = async (name, type) => [type, await readFile(new URL('./' + name, import.meta.url))]
  const assets = new Map([
    ['/auth/login.js', await asset('login.js', 'text/javascript; charset=utf-8')],
    ['/auth/session.js', await asset('session.js', 'text/javascript; charset=utf-8')],
    ['/auth/style.css', await asset('auth.css', 'text/css; charset=utf-8')],
    ['/auth/geist.woff2', await asset('fonts/geist.woff2', 'font/woff2')],
    ['/auth/geist-mono.woff2', await asset('fonts/geist-mono.woff2', 'font/woff2')],
  ])
  const auth = await blaxelAuth({ origin, environment, stateDirectory, clientName: 'Baseten Eval Sandbox', fetcher, now })
  const pageHost = `127.0.0.1:${upstream}`
  function json(res, code, data) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(data))
  }
  async function body(req) {
    const chunks = []
    let length = 0
    for await (const chunk of req) {
      length += chunk.length
      if (length > MAX_BODY) return undefined
      chunks.push(chunk)
    }
    return Buffer.concat(chunks)
  }
  function forward(req, res, path, viewer, payload) {
    const headers = { host: pageHost }
    for (const name of FORWARD) if (req.headers[name]) headers[name] = req.headers[name]
    headers['x-pr-eval-user'] = viewer.email // who is asking: their GitHub sign-in, favorites and private runs
    if (payload) { headers.origin = `http://${pageHost}`; headers['content-length'] = String(payload.length) }
    const page = path === '/' || path === '/index.html'
    if (page) delete headers['accept-encoding']
    const upstreamRequest = request({ host: '127.0.0.1', port: upstream, method: req.method, path: req.url, headers, timeout: 120_000 }, answer => {
      const out = {}
      for (const [name, value] of Object.entries(answer.headers)) if (!['connection', 'keep-alive', 'transfer-encoding', 'server', 'set-cookie'].includes(name)) out[name] = value
      if (!page || answer.statusCode !== 200) { res.writeHead(answer.statusCode, out); answer.pipe(res); return }
      // The page gets a Sign out button, as on the other signed-in sites.
      const chunks = []
      answer.on('data', chunk => chunks.push(chunk))
      answer.on('end', () => {
        const controls = '<link rel="stylesheet" href="/auth/style.css"><script src="/auth/session.js" defer></script><form class="auth-session" method="post" action="/auth/logout"><span role="status" aria-live="polite"></span><input type="hidden" name="csrf" value="' + escape(viewer.csrf) + '"><button type="submit" title="Signed in as ' + escape(viewer.email) + '">Sign out</button></form>'
        const html = Buffer.from(Buffer.concat(chunks).toString('utf8').replace('</body>', controls + '</body>'))
        delete out['content-length']
        res.writeHead(200, { ...out, 'Content-Length': html.length })
        res.end(req.method === 'HEAD' ? undefined : html)
      })
    })
    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('timed out')))
    upstreamRequest.on('error', error => {
      console.warn(`[eval] page unavailable: ${error.message}`)
      if (res.headersSent) { res.destroy(); return }
      json(res, 502, { error: 'The eval page is starting up. Try again in a moment.' })
    })
    upstreamRequest.end(payload)
  }

  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'")
    try {
      let path
      try { path = decodeURIComponent((req.url ?? '/').split('?')[0]) } catch { res.writeHead(400).end(); return }
      if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('\0') || path.split('/').some(p => p.startsWith('.'))) { res.writeHead(404).end(); return }
      if (req.headers.upgrade) { res.writeHead(400).end(); return }
      const shared = req.method === 'GET' && assets.get(path)
      if (shared) { res.writeHead(200, { 'Content-Type': shared[0], 'Content-Length': shared[1].length }).end(shared[1]); return }
      if (await auth.handle(req, res, path)) return
      // One authorization boundary covers every other route and method.
      const viewer = auth.require(req, res, path)
      if (!viewer) return
      if (req.method === 'GET' || req.method === 'HEAD') { forward(req, res, path, viewer); return }
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end(); return }
      if (req.headers.origin !== origin) { json(res, 403, { error: 'Reload this page and try again.' }); return }
      const payload = await body(req)
      if (!payload) { json(res, 413, { error: 'That request is too large.' }); return }
      console.log(`[eval] ${viewer.email} POST ${path}`)
      forward(req, res, path, viewer, payload)
    } catch (error) {
      // Storage and upstream failures deny the request without page content.
      if (!(error instanceof AuthFailure)) console.error('[eval]', error?.message ?? error)
      if (res.headersSent) { res.destroy(); return }
      res.removeHeader('Set-Cookie')
      json(res, error instanceof AuthFailure ? error.status : 503, { error: error instanceof AuthFailure ? error.message : 'The page could not be loaded. Please try again.' })
    }
  })
  server.headersTimeout = 10_000
  server.maxConnections = 128
  server.on('upgrade', (_req, socket) => socket.destroy())
  server.on('close', () => auth.close())
  return server
}

/** Whether a `pr-eval run` process is going in this sandbox (the page starts them as `python -m eval_sandbox run`). */
async function running() {
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0')
    if (args[1] === '-m' && args[2] === 'eval_sandbox' && args[3] === 'run') return true
  }
  return false
}

/**
 * On Blaxel a sandbox goes to standby soon after its last connection. While a run is going, hold a
 * keep-alive process through the sandbox's own process API, so closing the tab doesn't freeze it.
 */
function keepAwake(sandboxApi) {
  let held
  const call = (path, init) => fetch(sandboxApi + path, { ...init, signal: AbortSignal.timeout(10_000) })
  setInterval(async () => {
    try {
      const busy = await running()
      if (busy && !held) {
        held = `pr-eval-keepalive-${Date.now()}` // bounded: a missed release still ends after 6 hours
        await call('/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: held, command: 'sleep 21600', keepAlive: true, timeout: 21600, waitForCompletion: false }) })
        console.log('[eval] a run is going; keeping the sandbox awake')
      } else if (!busy && held) {
        const name = held
        held = undefined
        await call(`/process/${name}/kill`, { method: 'DELETE' })
        console.log('[eval] no run is going; the sandbox may sleep')
      }
    } catch (error) { console.warn(`[eval] keep-alive: ${error.message}`) }
  }, 15_000).unref()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000)
  const upstream = Number(process.env.PR_EVAL_PORT ?? 8765)
  for (const value of [port, upstream]) if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid port')
  const origin = process.env.APP_ORIGIN
  const local = localOrigin(new URL(origin))
  const server = await gateway({
    origin, upstream,
    environment: process.env.BLAXEL_ENV ?? 'prod',
    // Private and durable: the OAuth client, the session key and sessions, on the hosted sandbox's volume.
    stateDirectory: process.env.AUTH_STATE_DIR ?? resolve('.auth-state'),
  })
  if (process.env.BL_SANDBOX_API) keepAwake(process.env.BL_SANDBOX_API)
  server.listen(port, local ? '127.0.0.1' : '0.0.0.0', () => process.stdout.write(`Eval Sandbox gateway on port ${port}, in front of 127.0.0.1:${upstream}\n`))
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close())
}
