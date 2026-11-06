import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderLogin } from './login-page.mjs'

const brand = { name: 'Some Site', company: 'Baseten', tagline: 'What the site does.' }
const signOut = 'https://app.blaxel.ai/logout'
const text = html => html.replace(/<head>[\s\S]*<\/head>/, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

test('the sign-in page shows only the site name and one button', () => {
  const html = renderLogin({ brand, next: '/x', blaxelSignOut: signOut })
  assert.equal(text(html), 'Some Site Continue with Blaxel')
  assert.match(html, /<title>Some Site<\/title>/)
  assert.match(html, /href="\/auth\/start\?next=%2Fx"/)
})

test('link previews carry the name, the description and the public card', () => {
  const html = renderLogin({ brand: { ...brand, card: { type: 'image/png' } }, origin: 'https://site.example' })
  assert.match(html, /<meta property="og:title" content="Some Site">/)
  assert.match(html, /<meta property="og:description" content="What the site does.">/)
  assert.match(html, /<meta property="og:image" content="https:\/\/site\.example\/auth\/brand\/card">/)
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/)
})

test('signed-out and failed sign-ins add at most one short line', () => {
  for (const code of ['signed_out', 'session_ended']) assert.equal(text(renderLogin({ brand, state: { code } })), 'Some Site Continue with Blaxel')
  assert.equal(text(renderLogin({ brand, state: { code: 'expired', message: 'secret detail' } })), 'Some Site Sign-in didn&#39;t finish. Try again. Continue with Blaxel')
  const refused = renderLogin({ brand, state: { code: 'not_allowed', message: 'a@b.co is not on the list of @baseten.co', request: { token: 'sealed' } }, blaxelSignOut: signOut })
  assert.equal(text(refused), 'Some Site This account doesn&#39;t have access. Use a different account Request access Continue with Blaxel')
  assert.doesNotMatch(refused, /baseten\.co|a@b\.co/)
})
