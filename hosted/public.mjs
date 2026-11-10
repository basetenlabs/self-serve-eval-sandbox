// The few files the public pages need before anyone signs in: the sign-in page's stylesheet, the brand stylesheet
// it imports and the page texture (copies of web/src/styles' baseten.css and texture.png, the /baseten-design
// skill's files; a unit test keeps them equal). Everything else, the page included, stays behind sign-in.
// /auth/login.css replaces @blaxel/sign-in's own, so its error pages (renderMessage) take the same look as our
// sign-in page.
// Beausite is never served here: before sign-in the pages set in Geist, which the sign-in package serves.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))
const FILES = {
  '/auth/login.css': ['login-page.css', 'text/css; charset=utf-8'],
  '/auth/baseten.css': ['public/baseten.css', 'text/css; charset=utf-8'],
  '/auth/texture.png': ['public/texture.png', 'image/png'],
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
