// "Request access" on the refused sign-in page: @blaxel/sign-in calls the hook below with the email
// Blaxel verified (never one the person typed), once per email until it signs in. The hook emails
// each admin in the access file as it is right now, and nobody else: never the person asking.
import { readFile } from 'node:fs/promises'
import { checkAccessList } from '@blaxel/sign-in'

/** The Access page with `email` filled in for the invite list. */
export const inviteLink = (origin, email) => `${origin}/#/access?invite=${encodeURIComponent(email)}`

/** The message one admin gets. Plain text: it carries an address and a link, nothing else. */
export function requestMessage({ origin, email, to }) {
  const link = inviteLink(origin, email)
  return {
    to,
    subject: `Eval Sandbox: ${email} asked for access`,
    text: [
      `${email} signed in to Eval Sandbox with a verified Blaxel account that isn't on the list, and asked for access.`,
      '',
      `Add them: ${link}`,
      '',
      'The link opens the Access page with their address filled in under Invited people. Nothing changes until you press Add.',
      '',
      `You get this as an Eval Sandbox admin: ${origin}`,
    ].join('\n'),
  }
}

/**
 * The `requestAccess` hook for createSiteServer. `mailer.send({ to, subject, text })` delivers one
 * message. It throws when the access file can't be read, lists no admin, or no admin could be
 * reached, so the sign-in records nothing and the person can ask again.
 */
export function accessRequests({ file, origin, mailer, log = console }) {
  return async ({ email }) => {
    let admins
    try {
      admins = checkAccessList(JSON.parse(await readFile(file, 'utf8'))).admins
    } catch (error) {
      throw new Error(`the access file can't be read: ${error.message}`)
    }
    if (!admins.length) throw new Error('the access file lists no admin')
    const results = await Promise.allSettled(admins.map(to => mailer.send(requestMessage({ origin, email, to }))))
    const failed = results.flatMap((result, i) => result.status === 'rejected' ? [`${admins[i]}: ${result.reason?.message ?? result.reason}`] : [])
    for (const line of failed) log.warn?.(`[access] request email to ${line}`)
    if (failed.length === admins.length) throw new Error('no admin could be emailed')
    log.info?.(`[access] ${email} asked for access; emailed ${admins.length - failed.length} admin(s)`)
  }
}
