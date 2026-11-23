// @blaxel/sign-in's error pages (renderMessage) load /auth/theme.js before they paint. This copy, served by
// hosted/public.mjs in place of the package's, puts them on the design system's theme as data-theme="auto" does on
// the page and the sign-in page: light or dark with the system. A file, because the CSP forbids inline scripts.
document.documentElement.dataset.theme = 'auto'
