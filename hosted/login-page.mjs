// The public sign-in page: the site name and one "Continue with Blaxel" button, plus a short
// line after a failed attempt. It says nothing about how sign-in works, who may get in or what
// the site learns: anyone can load it, so it exposes the minimum. Link previews (Slack, X,
// iMessage) still get the site name, its one-line description and the public preview card from
// @blaxel/sign-in's previewMeta: crawlers never sign in, so this page is all they see.
// Passed to createSiteServer as `renderLogin`; @blaxel/sign-in's own page is the reference for
// the hooks kept here (#signin, data-auth, data-next for /auth/login.js).
import { previewMeta } from '@blaxel/sign-in'

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

/** `renderLogin` for createSiteServer: gets { brand, origin, next, state, blaxelSignOut } among others. */
export function renderLogin({ brand, origin = '', next = '/', state = {}, blaxelSignOut }) {
  const name = escape(brand.name)
  const { line, tone, other } = result(state.code)
  const start = '/auth/start' + (next === '/' ? '' : '?next=' + encodeURIComponent(next))
  const extra = []
  if (other && blaxelSignOut) extra.push(`<p><a href="${escape(blaxelSignOut)}" target="_blank" rel="noopener noreferrer">Use a different account</a></p>`)
  // "Request access" sends only the sealed token from the refused sign-in; the server reads the email from it.
  if (state.request?.token) extra.push(`<form class="request" method="post" action="/auth/request-access"><input type="hidden" name="token" value="${escape(state.request.token)}"><button class="btn secondary" type="submit"><span class="btn-label">Request access</span></button></form>`)
  const notice = line ? `<div class="notice" data-tone="${tone}" role="${tone === 'error' ? 'alert' : 'status'}"><p>${escape(line)}</p>${extra.join('')}</div>` : ''
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${name}</title>
${previewMeta({ brand, origin })}
<link rel="icon" href="/auth/brand/mark">
<link rel="stylesheet" href="/auth/theme.css">
<link rel="stylesheet" href="/auth/login.css">
<script src="/auth/theme.js"></script>
<script src="/auth/login.js" defer></script>
</head>
<body class="sb-auth">
<div class="frame" data-auth data-state="idle" data-next="${escape(next)}">
<span aria-hidden="true"></span>
<main class="panel solo" id="main">
  <div class="card">
    <h1>${name}</h1>
    ${notice}
    <a id="signin" class="btn primary" href="${escape(start)}"><span class="btn-label">Continue with Blaxel</span><span class="spinner" aria-hidden="true"></span></a>
  </div>
</main>
<span aria-hidden="true"></span>
</div>
</body>
</html>`
}
