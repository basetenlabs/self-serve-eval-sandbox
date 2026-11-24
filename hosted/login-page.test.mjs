import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderLogin } from './login-page.mjs'

const brand = { name: 'Some Site', company: 'Baseten', tagline: 'What the site does.' }
const signOut = 'https://app.blaxel.ai/logout'
const text = html => html.replace(/<head>[\s\S]*<\/head>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

test('the sign-in page shows only the site name and one button', () => {
  const html = renderLogin({ brand, next: '/x', blaxelSignOut: signOut })
  assert.equal(text(html), 'Some Site Continue with Baseten')
  assert.match(html, /<title>Some Site<\/title>/)
  assert.match(html, /href="\/auth\/start\?next=%2Fx"/)
})

test('the sign-in page follows the system\'s light or dark setting, with the logo to match', () => {
  const html = renderLogin({ brand })
  assert.match(html, /<html lang="en" data-theme="auto">/)
  assert.match(html, /<meta name="color-scheme" content="light dark">/)
  assert.match(html, /<source srcset="\/auth\/brand\/logo-dark" media="\(prefers-color-scheme: dark\)">/)
})

test('the sign-in page names the site\'s own address, so an old preview link can move there', () => {
  const html = renderLogin({ brand, origin: 'https://eval.example' })
  assert.match(html, /data-origin="https:\/\/eval\.example"/)
})

test('link previews carry the name, the description and the public card', () => {
  const html = renderLogin({ brand: { ...brand, card: { type: 'image/png' } }, origin: 'https://site.example' })
  assert.match(html, /<meta property="og:title" content="Some Site">/)
  assert.match(html, /<meta property="og:description" content="What the site does.">/)
  assert.match(html, /<meta property="og:image" content="https:\/\/site\.example\/auth\/brand\/card">/)
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/)
})

test('an open source site links its repository under the button on every state of the page', () => {
  const source = 'https://github.com/basetenlabs/self-serve-eval-sandbox'
  const refused = { code: 'not_allowed', request: { token: 'sealed' } }
  for (const state of [{}, { code: 'signed_out' }, { code: 'session_ended' }, { code: 'expired' }, refused]) {
    const html = renderLogin({ brand, state, blaxelSignOut: signOut, source })
    assert.match(text(html), /Continue with Baseten View the open source repository$/)
    assert.match(html, /<a class="bt-link bt-external source" href="https:\/\/github\.com\/basetenlabs\/self-serve-eval-sandbox" target="_blank" rel="noopener">/)
  }
  assert.doesNotMatch(renderLogin({ brand }), /open source/)
})

test('signed-out and failed sign-ins add at most one short line', () => {
  for (const code of ['signed_out', 'session_ended']) assert.equal(text(renderLogin({ brand, state: { code } })), 'Some Site Continue with Baseten')
  assert.equal(text(renderLogin({ brand, state: { code: 'expired', message: 'secret detail' } })), 'Some Site Sign-in didn&#39;t finish. Try again. Continue with Baseten')
  const refused = renderLogin({ brand, state: { code: 'not_allowed', message: 'a@b.co is not on the list of @baseten.co', request: { token: 'sealed' } }, blaxelSignOut: signOut })
  assert.equal(text(refused), 'Some Site This account doesn&#39;t have access. Use a different account Request access Continue with Baseten')
  assert.doesNotMatch(refused, /baseten\.co|a@b\.co/)
})

test('the public pages take the site stylesheet and textures the app builds with, and never Beausite', async () => {
  const { readFile } = await import('node:fs/promises')
  const here = new URL('.', import.meta.url)
  const { publicAssets } = await import('./public.mjs')
  const assets = await publicAssets()
  const release = await readFile(new URL('deploy.py', here), 'utf8')
  for (const [path, source] of [['/auth/baseten.css', 'web/src/styles/baseten.css'], ['/auth/texture.png', 'web/src/styles/texture.png'], ['/auth/texture-dark.png', 'web/src/styles/texture-dark.png'], ['/auth/icons/external-link.svg', 'web/src/styles/icons/external-link.svg']]) {
    assert.deepEqual(assets.get(path).body, await readFile(new URL(`../${source}`, here)), `${path} is not ${source}`)
    assert.match(release, new RegExp(`^RELEASE = [^\\]]*"${source}"`, 'm'), `hosted/deploy.py doesn't ship ${source}`)
  }
  // The error pages' theme script, so they follow the system's light or dark setting too.
  assert.deepEqual(assets.get('/auth/theme.js').body, await readFile(new URL('theme.js', here)))
  assert.equal(assets.get('/auth/theme.js').type, 'text/javascript; charset=utf-8')
  // The sign-in package's own login.js says "Opening Blaxel…" on the button once pressed; ours keeps it neutral.
  const login = assets.get('/auth/login.js').body.toString()
  assert.match(login, /Opening sign-in…/)
  assert.doesNotMatch(login, /Blaxel…/)
  const css = await readFile(new URL('login-page.css', here), 'utf8')
  assert.doesNotMatch(css + renderLogin({ brand }), /url\([^)]*beausite/i)
})
