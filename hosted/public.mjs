// The few files the public pages need before anyone signs in: the sign-in page's stylesheet, the brand stylesheet
// it imports, the page texture, light and dark, and the external-link arrow baseten.css draws (web/src/styles'
// baseten.css, texture.png, texture-dark.png and icons/external-link.svg, the /baseten-design skill's files,
// read in place so the sign-in pages always take the stylesheet the app builds with; hosted/deploy.py ships them).
// Everything else, the page included, stays behind sign-in.
// /auth/login.css and /auth/theme.js replace @blaxel/sign-in's own, so its error pages (renderMessage) take the same
// look as our sign-in page, dark included.
// Beausite is never served here: before sign-in the pages set in Geist, which the sign-in package serves.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const FILES = {
  '/auth/login.css': ['login-page.css', 'text/css; charset=utf-8'],
  '/auth/baseten.css': ['../web/src/styles/baseten.css', 'text/css; charset=utf-8'],
  '/auth/texture.png': ['../web/src/styles/texture.png', 'image/png'],
  '/auth/texture-dark.png': ['../web/src/styles/texture-dark.png', 'image/png'],
  '/auth/icons/external-link.svg': ['../web/src/styles/icons/external-link.svg', 'image/svg+xml'],
  '/auth/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
}

/** path -> { type, body }, read once at startup. */
export async function publicAssets() {
  const assets = new Map()
  for (const [path, [file, type]] of Object.entries(FILES)) assets.set(path, { type, body: await readFile(join(root, file)) })
  return assets
}

/** Puts `assets` in front of the site server's own handler: GET or HEAD on one of them answers it, anything else
 *  goes on to sign-in as before. `headers` are the server's base headers (CSP and the rest). */
export function servePublicAssets(server, assets, headers) {
  const [signedIn] = server.listeners('request')
  server.removeListener('request', signedIn)
  server.on('request', (req, res) => {
    const asset = (req.method === 'GET' || req.method === 'HEAD') && assets.get(req.url.split('?')[0])
    if (!asset) return signedIn(req, res)
    res.writeHead(200, { ...headers, 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-cache' })
    res.end(req.method === 'HEAD' ? undefined : asset.body)
  })
}
