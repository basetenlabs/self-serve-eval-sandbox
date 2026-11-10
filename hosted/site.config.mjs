// Who may sign in to the hosted eval page and how its sign-in page reads.

/** @type {import('@blaxel/sign-in/types').SiteConfig} */
export default {
  // Blaxel accounts with a verified email that data/access.json allows: its admins, single invited
  // addresses and whole domains. Admins edit it on the page; the sign-in re-reads it on every change.
  // server.mjs creates it on first start (see SEED in access.mjs).
  access: { file: '../data/access.json' },
  brand: {
    name: 'Self-Serve Model Eval Sandbox',
    askForAccess: 'Ask an Eval Sandbox admin to add you.',
    company: 'Baseten',
    tagline: 'Run coding models on real pull requests and compare what they solve and what it costs.',
    // The /baseten-design skill's assets/logo files, unchanged: /auth/brand/logo-light and /auth/brand/mark serve them.
    logo: 'brand/baseten-logo.svg',
    mark: 'brand/favicon.png',
    // Link previews (Slack, X, iMessage): 2400 x 1260 (1200 x 630 at 2x), public, since crawlers never sign in.
    card: 'card.png',
  },
  security: {
    // The page's writes are JSON from this origin, which the page checks again; it sends no CSRF token.
    csrf: 'origin',
    // The page is one built file with inline scripts and styles, so the strict default would block it.
    contentSecurityPolicy: "base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'",
  },
  // The page sets no cookies, and its largest request (a run's settings) is a few KB.
  proxy: { appCookies: false, maxBodyMb: 0.0625 },
}
