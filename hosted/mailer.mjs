// Sends the access-request emails through Resend's HTTP API with a send-only key. The key reaches
// only the sign-in process (deploy.py hands it over from the Keychain); without it there is no mailer
// and the refused page shows no "Request access" button.

/** A mailer for requests.mjs: `send({ to, subject, text })` delivers one message or throws. */
export function resendMailer({ key, from, fetcher = fetch }) {
  if (!key) throw new Error('resendMailer needs a key')
  if (!from) throw new Error('resendMailer needs a from address')
  return {
    async send({ to, subject, text }) {
      const res = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], subject, text }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`Resend answered ${res.status}`)
    },
  }
}
