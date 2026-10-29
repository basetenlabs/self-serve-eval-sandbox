// Who may sign in to the hosted eval page and how its sign-in page reads.

/** @type {import('@blaxel/sign-in/types').SiteConfig} */
export default {
  // Blaxel accounts with a verified email at exactly these domains.
  access: { domains: ['baseten.co', 'blaxel.ai'] },
  brand: {
    name: 'Eval Sandbox',
    company: 'Baseten',
    tagline: 'Run coding models on real pull requests and compare what they solve and what it costs.',
    login: { eyebrow: 'Internal preview', title: 'Sign in to Eval Sandbox' },
    mark: 'mark.svg',
    // The link-preview image (Slack, X, LinkedIn): 1200 x 630, served to signed-out crawlers.
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
