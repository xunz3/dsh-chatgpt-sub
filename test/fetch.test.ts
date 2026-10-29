import assert from 'node:assert/strict'
import test from 'node:test'
import { appFetch } from '../src/network/fetch.js'

test('appFetch uses the process fetch (and therefore the Harness proxy) with redirects disabled', async t => {
  const original = globalThis.fetch
  let seen: { input: unknown; init?: RequestInit } | undefined
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen = { input, init }
    return new Response('ok')
  }) as typeof globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  const response = await appFetch('https://example.test/a', { headers: { authorization: 'Bearer test' }, redirect: 'follow' })
  assert.equal(await response.text(), 'ok')
  assert.equal(seen?.input, 'https://example.test/a')
  assert.equal(seen?.init?.redirect, 'error')
  assert.equal(new Headers(seen?.init?.headers).get('authorization'), 'Bearer test')
})
