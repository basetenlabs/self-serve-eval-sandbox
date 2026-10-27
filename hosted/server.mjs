// The hosted eval page: "Sign in with Blaxel" (@blaxel/sign-in) in front of `pr-eval serve`.
//
// `pr-eval serve` only answers 127.0.0.1, so this server is the one public door. A signed-in,
// allowed person's requests reach the page with their email in X-Forwarded-Email (whatever the
// browser sent in it is dropped first), and every write has already passed the exact-origin check.
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createSiteServer, listen, loadConfig, proxySite, runMain, stopOnSignals } from '@blaxel/sign-in'

/** Whether a `pr-eval run` process is going in this sandbox (the page starts them as `python -m eval_sandbox run`). */
async function running() {
  for (const pid of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue
    const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).split('\0')
    if (args[1] === '-m' && args[2] === 'eval_sandbox' && args[3] === 'run') return true
  }
  return false
}

/**
 * On Blaxel a sandbox goes to standby soon after its last connection. While a run is going, hold a
 * keep-alive process through the sandbox's own process API, so closing the tab doesn't freeze it.
 */
function keepAwake(sandboxApi) {
  let held
  const call = (path, init) => fetch(sandboxApi + path, { ...init, signal: AbortSignal.timeout(10_000) })
  setInterval(async () => {
    try {
      const busy = await running()
      if (busy && !held) {
        held = `pr-eval-keepalive-${Date.now()}` // bounded: a missed release still ends after 6 hours
        await call('/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: held, command: 'sleep 21600', keepAlive: true, timeout: 21600, waitForCompletion: false }) })
        console.log('[eval] a run is going; keeping the sandbox awake')
      } else if (!busy && held) {
        const name = held
        held = undefined
        await call(`/process/${name}/kill`, { method: 'DELETE' })
        console.log('[eval] no run is going; the sandbox may sleep')
      }
    } catch (error) { console.warn(`[eval] keep-alive: ${error.message}`) }
  }, 15_000).unref()
}

runMain(async () => {
  const page = Number(process.env.PR_EVAL_PORT ?? 8765)
  const config = await loadConfig({ file: fileURLToPath(new URL('./site.config.mjs', import.meta.url)) })
  const app = proxySite(`http://127.0.0.1:${page}`, { websockets: false, ...config.proxy })
  const server = await createSiteServer({ config, app })
  await listen(server, config, ` in front of 127.0.0.1:${page}`)
  stopOnSignals(server)
  if (process.env.BL_SANDBOX_API) keepAwake(process.env.BL_SANDBOX_API)
})
