// The one place GSAP is named. Everything in assets/motion imports it from here.
// As committed it re-exports the bare specifier, which a bundler or the page's import map resolves.
// A page that may only load its own files and cannot carry an import map (script-src 'self'):
//   python3 scripts/fetch_vendor.py <vendor dir> --link <this folder's parent>
// downloads the library and rewrites this file to point at it by relative path.
export { default } from 'gsap'
export * from 'gsap'
