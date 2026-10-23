const form = document.querySelector('.auth-session')
const button = form.querySelector('button')
const status = form.querySelector('[role="status"]')
const csrf = form.querySelector('[name="csrf"]').value
const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('eval-session') : null
let expiryTimer
let checking = false
let leaving = false

function signedOut() {
  if (leaving) return
  leaving = true
  clearTimeout(expiryTimer)
  window.location.replace('/login')
}
if (channel) channel.onmessage = event => { if (event.data === 'signed-out') signedOut() }

async function checkSession() {
  if (checking || leaving || document.hidden) return
  checking = true
  try {
    const response = await fetch('/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    if (response.status === 401 || response.status === 403) { signedOut(); return }
    if (!response.ok) throw new Error('Session check unavailable. Reload before continuing.')
    const { remainingMs } = await response.json()
    if (!Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 30 * 24 * 60 * 60_000) { signedOut(); return }
    clearTimeout(expiryTimer)
    // Browser timers overflow above ~24.8 days; recheck long-lived sessions daily.
    expiryTimer = remainingMs > 86_400_000 ? setTimeout(checkSession, 86_400_000) : setTimeout(signedOut, remainingMs)
    status.textContent = ''
  } catch {
    status.textContent = 'Session check unavailable. Reload before continuing.'
  } finally { checking = false }
}

form.addEventListener('submit', async event => {
  event.preventDefault()
  if (button.disabled || leaving) return
  button.disabled = true
  status.textContent = 'Signing out…'
  try {
    const response = await fetch('/auth/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-CSRF-Token': csrf, Accept: 'application/json' },
    })
    if (response.status !== 204 && response.status !== 401) throw new Error('Sign-out was not confirmed')
    channel?.postMessage('signed-out')
    signedOut()
  } catch {
    status.textContent = 'Sign-out could not be confirmed. Please try again.'
    button.disabled = false
  }
})

window.addEventListener('pageshow', checkSession)
document.addEventListener('visibilitychange', checkSession)
setInterval(checkSession, 60_000)
checkSession()
