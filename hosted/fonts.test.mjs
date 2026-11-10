import test from 'node:test'
import assert from 'node:assert/strict'
import { beausiteFaces } from './fonts.mjs'

const BASE = 'https://www.baseten.co/_next/static/chunks/site.css'

test('beausiteFaces reads each Beausite weight and resolves it against the stylesheet', () => {
  const css = `
    @font-face{font-family:"Beausite Classic";src:url(../media/light.woff2) format("woff2");font-weight:350}
    @font-face{font-family:'Beausite Classic';src:url("/fonts/regular.woff2") format("woff2");font-weight:400}
    @font-face{font-family:Geist Mono;src:url(/fonts/mono.woff2) format("woff2");font-weight:400}`
  assert.deepEqual(beausiteFaces(css, BASE), {
    350: 'https://www.baseten.co/_next/static/media/light.woff2',
    400: 'https://www.baseten.co/fonts/regular.woff2',
  })
})

test('beausiteFaces never takes a font from another origin, plain http, or another format', () => {
  const css = `
    @font-face{font-family:"Beausite Classic";src:url(https://evil.example/b.woff2);font-weight:350}
    @font-face{font-family:"Beausite Classic";src:url(//cdn.example/b.woff2);font-weight:400}
    @font-face{font-family:"Beausite Classic";src:url(http://www.baseten.co/b.woff2);font-weight:500}
    @font-face{font-family:"Beausite Classic";src:url(/fonts/b.ttf);font-weight:600}`
  assert.deepEqual(beausiteFaces(css, BASE), {})
})
