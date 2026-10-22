import test from 'node:test'
import assert from 'node:assert/strict'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { OAuth, OAuthError, ISSUER, SCOPES } from '../src/auth/oauth.js'
import { connect } from 'node:net'
import { AuthService } from '../src/auth/service.js'
import { listenCallback } from '../src/auth/callback.js'
import type { Fetch } from '../src/network/transport.js'
import { memoryStore, eventually } from './helpers.js'

const config = { proxyMode: 'direct' as const, proxyUrlEnv: 'CHATGPT_PROXY_URL', callbackPort: 0 }
async function fixture() {
  const pair = await generateKeyPair('RS256')
  const jwk = { ...await exportJWK(pair.publicKey), kid: 'test-key' }
  let nonce = ''
  let issuer = ISSUER, audience = 'client-test', subject = 'subject-test', expires = '1h', signingNonce: string | undefined
  let refreshes = 0, revoked = 0
  const bodies: URLSearchParams[] = []
  const fetcher: Fetch = async (url, init) => {
    if (String(url).endsWith('openid-configuration')) return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/jwks`, revocation_endpoint: `${ISSUER}/revoke` })
    if (String(url).endsWith('/jwks')) return Response.json({ keys: [jwk] })
    if (String(url).endsWith('/revoke')) { revoked++; return new Response('') }
    const body = new URLSearchParams(String(init?.body)); bodies.push(body)
    if (body.get('grant_type') === 'refresh_token') { refreshes++; await new Promise(r => setTimeout(r, 20)) }
    const idToken = await new SignJWT({ nonce: signingNonce ?? nonce, email: 'user@example.com' }).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(issuer).setAudience(audience).setSubject(subject).setIssuedAt().setExpirationTime(expires).sign(pair.privateKey)
    return Response.json({ access_token: 'secret-access', refresh_token: 'rotated-refresh', id_token: idToken, token_type: 'Bearer', expires_in: 3600, scope: SCOPES })
  }
  const oauth = new OAuth(fetcher)
  const store = memoryStore()
  const auth = new AuthService(store, oauth, config)
  return { auth, oauth, store, bodies, get refreshes() { return refreshes }, get revoked() { return revoked },
    invalid: (claim: string) => { if (claim === 'issuer') issuer = 'https://evil.example'; if (claim === 'audience') audience = 'wrong'; if (claim === 'nonce') signingNonce = 'wrong'; if (claim === 'expiry') expires = '-1h'; if (claim === 'subject') subject = 'wrong' },
    async begin(accountId?: string) {
      const status = await auth.login(accountId)
      const url = new URL(status.flow.url!)
      nonce = url.searchParams.get('nonce')!
      const callback = new URL(status.flow.callback!)
      callback.search = new URLSearchParams({ state: url.searchParams.get('state')!, code: 'valid-code', client_id: 'client-test' }).toString()
      return { url, callback }
    },
    async connect() { const { callback } = await this.begin(); assert.equal((await fetch(callback)).status, 200); await eventually(async () => (await auth.status()).flow.phase === 'done'); return (await auth.status()).activeId! },
  }
}

test('OAuth dynamic registration, verified identity, retained registration and revocation', async () => {
  const f = await fixture()
  try {
    const { url, callback } = await f.begin()
    assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
    assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1')
    assert.equal(url.searchParams.get('ext_agent_host_id'), (await f.store.read()).hostId)
    const bad = new URL(callback); bad.searchParams.set('state', 'wrong')
    assert.equal((await fetch(bad)).status, 400)
    assert.equal(f.bodies.length, 0)
    assert.equal((await fetch(callback)).status, 200)
    await eventually(async () => (await f.auth.status()).flow.phase === 'done')
    const status = await f.auth.status()
    assert.equal(status.accounts[0].email, 'user@example.com')
    assert.equal(status.accounts[0].sharing, true)
    assert.ok(!JSON.stringify(status).includes('secret-access'))
    assert.equal(f.bodies[0].get('client_id'), 'client-test')
    assert.equal(f.bodies[0].get('redirect_uri'), callback.origin + callback.pathname)
    assert.equal(f.bodies[0].get('code_verifier')?.length, 43)
    const hostId = (await f.store.read()).hostId
    await f.auth.logout(status.activeId!)
    assert.equal(f.revoked, 1)
    assert.equal((await f.store.read()).accounts[0].tokens, undefined)
    assert.equal((await f.store.read()).hostId, hostId)
    const returning = await f.begin(status.activeId)
    assert.equal(returning.url.searchParams.get('client_id'), 'client-test')
    assert.equal(returning.url.searchParams.get('agent_name_hint'), null)
    returning.callback.searchParams.delete('client_id')
    await fetch(returning.callback)
    await eventually(async () => (await f.auth.status()).flow.phase === 'done')
    assert.equal((await f.store.read()).accounts.length, 1)
  } finally { f.auth.dispose() }
})
for (const claim of ['issuer', 'audience', 'nonce', 'expiry']) test(`rejects invalid ID token ${claim} without persisting credentials`, async () => {
  const f = await fixture(); f.invalid(claim)
  try {
    const { callback } = await f.begin(); await fetch(callback)
    await eventually(async () => (await f.auth.status()).flow.phase === 'error')
    assert.equal((await f.store.read()).accounts.length, 0)
    assert.equal((await f.store.read()).pendingClientId, 'client-test')
  } finally { f.auth.dispose() }
})
test('returning login rejects changed identity and leaves active credentials untouched', async () => {
  const f = await fixture()
  try {
    const id = await f.connect(); f.invalid('subject')
    const { callback } = await f.begin(id); await fetch(callback)
    await eventually(async () => (await f.auth.status()).flow.phase === 'error')
    assert.equal((await f.store.read()).accounts[0].subject, 'subject-test')
  } finally { f.auth.dispose() }
})
test('concurrent requests refresh once; logout aborts outstanding request signals', async () => {
  const f = await fixture()
  try {
    const id = await f.connect()
    await f.store.update(s => { s.accounts[0].tokens!.expiresAt = 0 })
    const sessions = await Promise.all(Array.from({ length: 8 }, () => f.auth.access()))
    assert.equal(f.refreshes, 1)
    assert.ok(sessions.every(s => s.token === 'secret-access'))
    await f.auth.logout(id)
    assert.ok(sessions.every(s => s.signal.aborted))
    await assert.rejects(f.auth.access(), /login_required/)
  } finally { f.auth.dispose() }
})
test('callback rejects changed client, checks state on error, aborts and releases port', async () => {
  const controller = new AbortController()
  const listener = await listenCallback('state', 'registered-client', controller.signal)
  const port = Number(new URL(listener.redirectUri).port)
  assert.equal((await fetch(`${listener.redirectUri}?state=bad&error=access_denied`)).status, 400)
  assert.equal((await fetch(`${listener.redirectUri}?state=state&code=code&client_id=other`)).status, 400)
  controller.abort()
  await assert.rejects(listener.result, /cancelled/)
  listener.close()
  const another = await listenCallback('next', undefined, new AbortController().signal, port)
  another.close()
})
test('cancelled pending login cannot publish credentials', async () => {
  const f = await fixture()
  try {
    await f.begin(); await f.auth.cancel()
    assert.equal((await f.auth.status()).flow.phase, 'idle')
    assert.equal((await f.store.read()).accounts.length, 0)
  } finally { f.auth.dispose() }
})

test('malformed callback request cannot crash the host', async () => {
  const listener = await listenCallback('valid', undefined, new AbortController().signal)
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(new URL(listener.redirectUri).port), '127.0.0.1', () => socket.end('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'))
      let text = ''; socket.on('data', chunk => { text += chunk }); socket.on('end', () => resolve(text)); socket.on('error', reject)
    })
    assert.match(reply, /400/)
    assert.equal((await fetch(`${listener.redirectUri}?state=wrong`)).status, 400)
  } finally { listener.close() }
})
test('cancel during token exchange prevents later credential persistence', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const exchange = f.oauth.exchange.bind(f.oauth)
  f.oauth.exchange = async (...args) => { await gate; return exchange(...args) }
  try {
    const { callback } = await f.begin(); await fetch(callback)
    await eventually(async () => (await f.auth.status()).flow.phase === 'exchanging')
    const cancelled = f.auth.cancel(); release(); await cancelled
    assert.equal((await f.store.read()).accounts.length, 0)
    assert.equal((await f.auth.status()).flow.phase, 'idle')
  } finally { release(); f.auth.dispose() }
})
test('cancel during admitted persistence waits and reports the actual completed login', async () => {
  const f = await fixture()
  let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const update = f.store.update.bind(f.store)
  f.store.update = async mutate => { const state = await update(mutate); if (state.accounts.length) await gate; return state }
  try {
    const { callback } = await f.begin(); await fetch(callback)
    await eventually(async () => (await f.store.read()).accounts.length > 0)
    let settled = false
    const cancelled = f.auth.cancel().then(value => { settled = true; return value })
    await new Promise(r => setTimeout(r, 20)); assert.equal(settled, false)
    release()
    assert.equal((await cancelled).flow.phase, 'done')
  } finally { release(); f.auth.dispose() }
})
test('invalid refresh clears renewable credentials and requires sign-in', async () => {
  const f = await fixture()
  try {
    await f.connect(); await f.store.update(s => { s.accounts[0].tokens!.expiresAt = 0 })
    f.oauth.refresh = async () => { throw new OAuthError('invalid_grant') }
    await assert.rejects(f.auth.access(), /invalid_grant/)
    assert.equal((await f.store.read()).accounts[0].tokens, undefined)
  } finally { f.auth.dispose() }
})
test('OpenID discovery receives and honors cancellation', async () => {
  let received: AbortSignal | null | undefined
  const oauth = new OAuth(async (_url, init) => new Promise<Response>((_resolve, reject) => {
    received = init?.signal
    received?.addEventListener('abort', () => reject(received?.reason), { once: true })
  }))
  const controller = new AbortController()
  const pending = oauth.verify('unused', 'client', 'nonce', controller.signal)
  controller.abort()
  await assert.rejects(pending)
  assert.equal(received?.aborted, true)
})
