const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const LOCK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
const ARROW = '<svg class="auth-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>'
const DESCRIPTION = 'Run coding models on real pull requests and compare what they solve and what it costs. Internal preview: sign in with a Blaxel account.'

// Link unfurl crawlers never sign in: the sign-in page carries the preview metadata.
function previewMeta(origin) {
  return `<meta name="description" content="${DESCRIPTION}"><meta property="og:type" content="website"><meta property="og:site_name" content="Baseten"><meta property="og:title" content="Eval Sandbox · Baseten"><meta property="og:description" content="${DESCRIPTION}"><meta property="og:url" content="${escape(origin)}/"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="Eval Sandbox · Baseten"><meta name="twitter:description" content="${DESCRIPTION}">`
}

/**
 * The sign-in page, also rendered at /auth/callback when a sign-in is refused.
 * Signing in is a plain link to /auth/start; login.js only adds polish.
 */
export function renderLogin({ origin, domains, sessionDays, accountUrl, next = '/', error }) {
  const allowed = domains.map(domain => `<strong>@${escape(domain)}</strong>`).join(' or ')
  const start = '/auth/start' + (next === '/' ? '' : '?next=' + encodeURIComponent(next))
  const switchable = error && ['not_allowed', 'unverified'].includes(error.code)
  const alert = error ? `<div class="auth-alert" role="alert"><p>${escape(error.message)}</p>${switchable ? `<p class="auth-alert-actions"><a href="${escape(accountUrl)}" target="_blank" rel="noopener noreferrer">Switch accounts in Blaxel</a></p>` : ''}</div>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Sign in · Eval Sandbox</title>${previewMeta(origin)}<link rel="stylesheet" href="/auth/style.css"><script src="/auth/login.js" defer></script></head>` +
    `<body class="auth-page"><main class="auth-card" data-auth data-state="idle" data-next="${escape(next)}"${error ? ` data-error="${escape(error.code)}"` : ''}>` +
    '<img class="auth-logo" src="/auth/logo.svg" alt="Blaxel, a baseten company" width="119" height="44">' +
    '<div class="auth-eyebrow">Internal preview</div>' +
    `<h1>${error ? 'Let&#39;s try that again' : 'Sign in to Eval Sandbox'}</h1>` +
    `<p>Eval Sandbox is open to Blaxel accounts with a verified ${allowed} email.</p>` +
    alert +
    `<a id="signin" class="auth-button" href="${escape(start)}"><span class="auth-button-label">${error ? 'Try again with Blaxel' : 'Continue with Blaxel'}</span>${ARROW}<span class="auth-spinner" aria-hidden="true"></span></a>` +
    `<p class="auth-trust">${LOCK}<span>You'll sign in on Blaxel's own page. This site only learns your name and email.</span></p>` +
    `<small>You stay signed in on this browser for ${sessionDays} days. On a shared computer, use Sign out when you're done.</small>` +
    '</main></body></html>'
}
