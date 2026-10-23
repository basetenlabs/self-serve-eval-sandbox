// Polish for the sign-in page. Signing in itself is a plain link to /auth/start,
// which redirects to Blaxel and comes straight back to the page you were on.
const root = document.querySelector('[data-auth]')
const signin = document.getElementById('signin')
const label = signin.querySelector('.auth-button-label')
const idle = label.textContent
const next = root.dataset.next || '/'

// A refused sign-in renders this page at /auth/callback; keep the address bar clean and reload-safe.
if (location.pathname !== '/login') history.replaceState(null, '', '/login' + (next === '/' ? '' : '?next=' + encodeURIComponent(next)))

signin.addEventListener('click', event => {
  // Opening the link in another tab leaves this page as it is.
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (root.dataset.state === 'redirecting') { event.preventDefault(); return }
  root.dataset.state = 'redirecting'
  signin.setAttribute('aria-busy', 'true')
  label.textContent = 'Opening Blaxel…'
})

// Coming back with the browser's Back button restores this page from cache; reset it.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return
  root.dataset.state = 'idle'
  signin.removeAttribute('aria-busy')
  label.textContent = idle
})

// Signed in from another tab meanwhile? Continue without asking again.
async function alreadySignedIn() {
  if (document.hidden || root.dataset.state === 'redirecting') return
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    if (response.ok) location.replace(next)
  } catch { /* Offline; the button still works. */ }
}
window.addEventListener('focus', alreadySignedIn)
document.addEventListener('visibilitychange', alreadySignedIn)
