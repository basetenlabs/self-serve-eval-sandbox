// Polish for the sign-in page, in place of @blaxel/sign-in's own public/login.js (served as /auth/login.js by
// hosted/public.mjs): the same, but the button says Baseten while it works, as it does before. Signing in itself
// is a plain link to /auth/start, which sends you to the sign-in page and brings you back to the page you asked for.
const root = document.querySelector('[data-auth]')
const signin = document.getElementById('signin')
const label = signin.querySelector('.btn-label')
const idleLabel = label.textContent
const next = root.dataset.next || '/'

// The page has its own address (PR_EVAL_PUBLIC_ORIGIN, hosted/deploy.py): opened at the old preview one, go there.
let home = ''
try { home = new URL(root.dataset.origin).origin } catch { /* none given: stay */ }
if (home.startsWith('https://') && location.origin !== home) location.replace(home + location.pathname + location.search)

// Results are rendered at /auth/callback; show a clean, reload-safe address instead.
if (location.pathname !== '/login') history.replaceState(null, '', '/login' + (next === '/' ? '' : '?next=' + encodeURIComponent(next)))

signin.addEventListener('click', event => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
  if (root.dataset.state === 'redirecting') { event.preventDefault(); return }
  root.dataset.state = 'redirecting'
  signin.setAttribute('aria-busy', 'true')
  label.textContent = 'Opening sign-in…'
})

// Coming back with the Back button restores this page from the cache: reset it.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return
  root.dataset.state = 'idle'
  signin.removeAttribute('aria-busy')
  label.textContent = idleLabel
})

// Signed in from another tab meanwhile? Continue without asking again.
async function continueIfSignedIn() {
  if (document.hidden || root.dataset.state === 'redirecting') return
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    if (response.ok) location.replace(next)
  } catch { /* Offline: the button still works. */ }
}
window.addEventListener('focus', continueIfSignedIn)
document.addEventListener('visibilitychange', continueIfSignedIn)
