import assert from 'node:assert/strict'
import test from 'node:test'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { createStore } from '../src/auth/store.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth } from '../src/auth/oauth.js'

function credentials() {
  let record: CredentialRecord | undefined
  let writes = 0
  let queued = Promise.resolve()
  const provider = {
    readRecord: async () => structuredClone(record),
    modifyRecord: (_key: unknown, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const operation = queued.then(async () => {
        const next = await mutate(structuredClone(record))
        // DSH emits record-updated on every returned record, even if equal.
        if (next !== undefined) { record = next; writes++ }
        return structuredClone(record)
      })
      queued = operation.then(() => {}, () => {})
      return operation
    },
  }
  return { provider, get writes() { return writes } }
}

test('reads never create a record; concurrent ensure persists one installation identity', async () => {
  const c = credentials()
  const stores = [createStore(c.provider), createStore(c.provider)]
  const empty = await Promise.all(stores.map(store => store.read()))
  assert.equal(empty[0].hostId, '')
  assert.equal(empty[1].hostId, '')
  assert.equal(c.writes, 0, 'reading the connection status must not write credentials')
  const states = await Promise.all(stores.map(store => store.ensure()))
  assert.match(states[0].hostId, /^urn:uuid:[0-9a-f-]{36}$/)
  assert.equal(states[0].hostId, states[1].hostId)
  assert.equal(c.writes, 1)
  await stores[0].update(() => {})
  assert.equal(c.writes, 1)
  await stores[0].update(state => { state.pendingClientId = 'registered-client' })
  assert.equal(c.writes, 2)
  await stores[1].update(state => { state.pendingClientId = 'registered-client' })
  assert.equal(c.writes, 2)
})

test('valid token reads do not publish credential changes; concurrent refresh commits exactly once', async () => {
  const c = credentials()
  const store = createStore(c.provider)
  await store.update(state => {
    state.activeId = 'account'
    state.accounts.push({ id: 'account', clientId: 'client', subject: 'subject', email: 'test@example.com', tokens: {
      access: 'access', refresh: 'refresh', idToken: 'id', expiresAt: Date.now() + 3600_000,
      scopes: ['chatgpt.tokens.use.direct', 'resource.invoke'],
    } })
  })
  let refreshes = 0
  const oauth = new OAuth(async () => { throw new Error('Unexpected network request') })
  oauth.refresh = async account => {
    refreshes++
    return { ...account.tokens!, access: 'rotated', refresh: 'rotated-refresh', expiresAt: Date.now() + 3600_000 }
  }
  const auth = new AuthService(store, oauth, { callbackPort: 0 })
  try {
    await Promise.all(Array.from({ length: 10 }, () => auth.access()))
    assert.equal(c.writes, 1, 'reading valid tokens must not invalidate the model catalog')
    assert.equal(refreshes, 0)
    await store.update(state => { state.accounts[0].tokens!.expiresAt = 0 })
    const before = c.writes
    const sessions = await Promise.all(Array.from({ length: 10 }, () => auth.access()))
    assert.ok(sessions.every(session => session.token === 'rotated'))
    assert.equal(refreshes, 1)
    assert.equal(c.writes, before + 1, 'only the real token rotation should invalidate the catalog')
  } finally { auth.dispose() }
})
