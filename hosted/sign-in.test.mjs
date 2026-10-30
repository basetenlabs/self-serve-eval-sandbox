import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPolicy, loadBrand, renderLogin } from '@blaxel/sign-in'
import config from './site.config.mjs'

test('a refused account gets the shared access instructions from sign-in 0.2.0', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)))
  assert.equal(pkg.dependencies['@blaxel/sign-in'], 'npm:@blaxel-ai/sign-in@0.2.0')
  const html = renderLogin({
    brand: loadBrand(config.brand, fileURLToPath(new URL('./', import.meta.url))),
    policy: createPolicy(config.access),
    origin: 'http://localhost',
    state: { code: 'not_allowed', message: 'This account is not on the list.' },
    blaxelSignOut: 'https://app.blaxel.ai/logout',
  })
  assert.match(html, /This account can&#39;t get in/)
  assert.match(html, /Ask Michael Stolarz on Slack to add you\./)
})
