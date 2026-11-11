// The public sign-in page: on the dotted texture, one White block with the Baseten logo, the site name and one
// "Continue with Blaxel" button, plus a short line after a failed attempt and, for an open source site, a quiet
// link to its repository under the button. It says nothing about how sign-in works,
// who may get in or what the site learns: anyone can load it, so it exposes the minimum. Link previews (Slack, X,
// iMessage) still get the site name, its one-line description and the public preview card from @blaxel/sign-in's
// previewMeta: crawlers never sign in, so this page is all they see. Passed to createSiteServer as `renderLogin`;
// @blaxel/sign-in's own page is the reference for the hooks kept here (#signin, .btn-label, data-auth, data-next for
// /auth/login.js). The look is the /baseten-design skill's (bt-* parts from /auth/baseten.css) set in Geist, with this
// page's own parts in hosted/login-page.css (served as /auth/login.css by hosted/public.mjs, before sign-in).
// The same files ship in every internal site; change them together.
import { previewMeta } from '@blaxel/sign-in'

// The site's button chevron: a small solid triangle (the skill's assets/icons/chevron-right.svg).
const CHEVRON = '<svg width="5" height="10" viewBox="0 0 5 10" fill="none"><path d="M5 5L0 0V10L5 5Z" fill="currentColor"/></svg>'

// The skill's external-link arrow (assets/icons/external-link.svg): .bt-external grows it in on hover.
const ARROW = '<svg width="6" height="6" viewBox="0 0 6.85355 6.85355" fill="none"><path d="M0.353553 6.5L6.35355 0.5M6.35355 6.5V0.5H0.353553" stroke="currentColor"/></svg>'

const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** The line under the site name for each result code, and the button label. Nothing for a first visit. */
function result(code) {
  switch (code) {
    case undefined: case 'signed_out': case 'session_ended': case 'request_granted': return {}
    case 'not_allowed': return { line: 'This account doesn\'t have access.', tone: 'error', other: true }
    case 'unverified': return { line: 'Verify your email, then try again.', tone: 'error' }
    case 'requested': return { line: 'Request sent.', tone: 'info' }
    case 'canceled': return { line: 'Sign-in canceled.', tone: 'info' }
    case 'busy': return { line: 'Try again in a minute.', tone: 'error' }
    default: return { line: 'Sign-in didn\'t finish. Try again.', tone: 'error' }
  }
}

/** `renderLogin` for createSiteServer: gets { brand, origin, next, state, blaxelSignOut } among others. `source`, the
 *  site's own addition, is its public repository: shown as a link under the button on every state of the page. */
export function renderLogin({ brand, origin = '', next = '/', state = {}, blaxelSignOut, source }) {
  const name = escape(brand.name)
  const { line, tone, other } = result(state.code)
  const start = '/auth/start' + (next === '/' ? '' : '?next=' + encodeURIComponent(next))
  const extra = []
  if (other && blaxelSignOut) extra.push(`<a class="bt-link" href="${escape(blaxelSignOut)}" target="_blank" rel="noopener noreferrer">Use a different account</a>`)
  // "Request access" sends only the sealed token from the refused sign-in; the server reads the email from it.
  if (state.request?.token) extra.push(`<form class="request" method="post" action="/auth/request-access"><input type="hidden" name="token" value="${escape(state.request.token)}"><button class="bt-button tertiary" type="submit"><span><span class="label">Request access</span></span></button></form>`)
  const notice = line ? `<div class="bt-notice ${tone}" role="${tone === 'error' ? 'alert' : 'status'}"><p>${escape(line)}</p>${extra.length ? `<div class="actions">${extra.join('')}</div>` : ''}</div>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${name}</title>
${previewMeta({ brand, origin })}
<link rel="icon" href="/auth/brand/mark">
<link rel="stylesheet" href="/auth/login.css">
<script src="/auth/login.js" defer></script>
</head>
<body class="sb-auth bt-page">
<div class="frame" data-auth data-state="idle" data-next="${escape(next)}">
<main class="panel" id="main">
  <div class="card">
    <img class="logo" src="/auth/brand/logo-light" alt="${escape(brand.company ?? 'Baseten')}" width="117" height="22">
    <h1>${name}</h1>
    ${notice}
    <a id="signin" class="bt-button has-chevron full" href="${escape(start)}"><span><span class="label btn-label">Continue with Blaxel</span><span class="chevron" aria-hidden="true">${CHEVRON}</span></span></a>
    ${source ? `<a class="bt-link bt-external source" href="${escape(source)}" target="_blank" rel="noopener">View the open source repository<span class="arrow" aria-hidden="true">${ARROW}</span></a>` : ''}
  </div>
</main>
</div>
</body>
</html>`
}
