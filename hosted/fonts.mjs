// Fetches Baseten's brand face, Beausite Classic (350, 400, 500), from www.baseten.co into hosted/fonts, which
// hosted/deploy.py uploads with the release. The face is licensed to Baseten: hosted/fonts is never committed, and
// `pr-eval serve` hands it (and declares it in the page) only to a person the hosted sign-in let in. Best effort:
// without the files the page sets in Geist, as it does locally and in a report opened from disk.
//   node hosted/fonts.mjs        fetch what is missing; never fails the deploy
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SITE = 'https://www.baseten.co/'
const OUT = fileURLToPath(new URL('./fonts/', import.meta.url))
const WEIGHTS = ['350', '400', '500']
const file = weight => join(OUT, `BeausiteClassic-${weight}.woff2`)

const get = async url => {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response
}

/** The woff2 URL of each Beausite weight, read from the @font-face rules in one of the site's stylesheets.
 *  Only files on the stylesheet's own origin count: a font the page pulls from anywhere else is never fetched. */
export function beausiteFaces(css, base) {
  const faces = {}
  for (const [, block] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const family = /font-family:\s*["']?([^;"']+)/.exec(block)?.[1].trim().toLowerCase()
    const source = /url\(["']?([^)"']+\.woff2)["']?\)/.exec(block)?.[1]
    if (!family?.startsWith('beausite') || !source) continue
    const url = new URL(source, base)
    if (url.origin !== new URL(base).origin || url.protocol !== 'https:') continue
    faces[/font-weight:\s*(\d+)/.exec(block)?.[1] ?? '400'] = url.href
  }
  return faces
}

export async function fetchFonts({ log = console.log } = {}) {
  const missing = []
  for (const weight of WEIGHTS) if (!(await stat(file(weight)).catch(() => null))?.size) missing.push(weight)
  if (!missing.length) return true
  const html = await (await get(SITE)).text()
  const faces = {}
  for (const [, href] of html.matchAll(/href="([^"]+\.css[^"]*)"/g)) {
    const url = new URL(href, SITE)
    if (url.origin !== new URL(SITE).origin) continue
    Object.assign(faces, beausiteFaces(await (await get(url)).text().catch(() => ''), url))
  }
  await mkdir(OUT, { recursive: true })
  for (const weight of missing) {
    if (!faces[weight]) throw new Error(`no Beausite ${weight} @font-face on ${SITE}`)
    const bytes = Buffer.from(await (await get(faces[weight])).arrayBuffer())
    if (bytes.subarray(0, 4).toString('latin1') !== 'wOF2') throw new Error(`${faces[weight]} is not a woff2 file`)
    await writeFile(file(weight), bytes)
    log(`fonts: Beausite Classic ${weight}`)
  }
  return true
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await fetchFonts().catch(error => console.warn(`fonts: Beausite not fetched (${error.message}); the page falls back to Geist`))
}
