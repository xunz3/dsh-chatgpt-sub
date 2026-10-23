import assert from 'node:assert/strict'
import test from 'node:test'
import { metadata, releasePlan } from '../scripts/release.js'

const empty = { versions: {}, 'dist-tags': {} }
test('release planning skips existing versions and separates stable and prerelease tags', () => {
  assert.deepEqual(releasePlan('0.1.0', empty), { publish: true, tag: 'latest' })
  assert.deepEqual(releasePlan('0.2.0-rc.1', empty), { publish: true, tag: 'next' })
  assert.deepEqual(releasePlan('0.1.0', { versions: { '0.1.0': {} }, 'dist-tags': { latest: '0.2.0' } }), { publish: false, tag: 'latest' })
})
test('unpublished older stable releases cannot roll latest back', () => {
  const registry = { versions: {}, 'dist-tags': { latest: '0.9.0' } }
  assert.throws(() => releasePlan('0.8.1', registry), /backwards/)
  assert.equal(releasePlan('0.10.0', registry).publish, true)
  for (const version of ['01.0.0', '1.0', 'v1.0.0', '1.0.0-01', '1.0.0+build']) assert.throws(() => releasePlan(version, empty))
})
test('registry outages and malformed metadata never become permission to publish', async () => {
  const fetcher = (response: Response) => (async () => response) as typeof fetch
  assert.deepEqual(await metadata('@xunz/example', fetcher(new Response(null, { status: 404 }))), empty)
  for (const status of [401, 429, 500]) await assert.rejects(metadata('@xunz/example', fetcher(new Response(null, { status }))), /HTTP/)
  await assert.rejects(metadata('@xunz/example', fetcher(Response.json({}))), /Invalid npm metadata/)
  await assert.rejects(metadata('@xunz/example', async () => { throw new Error('Network unavailable') }), /Network unavailable/)
})
