import assert from 'node:assert/strict'
import test from 'node:test'
import OpenAI from 'openai'
import { LlmError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { ChatGPTRequestError, mapOpenAIError, responseError, retryAfterMs } from '../src/adapter/errors.js'
import { ChatGPTAdapter } from '../src/adapter/index.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth, OAuthError, SCOPES } from '../src/auth/oauth.js'
import type { State } from '../src/auth/store.js'
import { memoryStore } from './helpers.js'

const config = { callbackPort: 0 }
function accountState(): State {
  return { version: 1, hostId: 'test-host', activeId: 'account', accounts: [{ id: 'account', clientId: 'client', subject: 'subject', email: 'test@example.com', tokens: {
    access: 'private-access', refresh: 'private-refresh', idToken: 'private-id-token', expiresAt: Date.now() + 3_600_000, scopes: SCOPES.split(' '),
  } }] }
}

test('subscription error codes choose actionable recovery without treating usage-unavailable as exhausted quota', () => {
  const examples = [
    ['subscription_sharing_usage_limit_exceeded', 429, 'QUOTA'],
    ['subscription_sharing_usage_unavailable', 503, 'SERVER'],
    ['subscription_sharing_user_unavailable', 503, 'SERVER'],
    ['subscription_sharing_user_not_eligible', 403, 'PERMISSION'],
    ['subscription_sharing_unsupported_capability', 400, 'UNSUPPORTED_CONTENT'],
    ['subscription_sharing_route_not_supported', 403, 'CONFIGURATION'],
    ['subscription_sharing_invalid_user', 401, 'AUTH'],
    ['chatpass_v2_scope_not_authorized', 403, 'PERMISSION'],
    ['chatpass_v2_invalid_authorization_context', 403, 'PERMISSION'],
  ] as const
  const policy = resolveRetryPolicy(undefined, 'test')
  assert.equal(policy.mode, 'normal')
  for (const [code, status, kind] of examples) {
    const error = mapOpenAIError({ error: { code, param: 'tools[0].type', message: 'private provider text' } }, { status })
    assert.equal(error.code, kind)
    assert.equal(error.failure.status, status)
    assert.ok(error instanceof ChatGPTRequestError)
    assert.ok(error.message.includes(`${code}; parameter tools[0].type`))
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes(error.code), kind === 'SERVER')
    assert.ok(!JSON.stringify(error).includes('private provider text'))
    assert.ok(!error.message.includes('private provider text'))
  }
})

test('HTTP, SDK and streaming errors preserve only validated routing and request diagnostics', async () => {
  const headers = new Headers({ 'x-request-id': 'req_123-test', 'retry-after': '2.5', 'set-cookie': 'session=private' })
  const sdk = OpenAI.APIError.generate(429, { error: { code: 'rate_limit_exceeded', message: 'Bearer private-secret' } }, undefined, headers)
  const error = mapOpenAIError(sdk)
  assert.equal(error.code, 'RATE_LIMIT')
  assert.deepEqual(error.failure, { message: error.message, code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 2500, requestId: 'req_123-test' })
  assert.equal(error.cause, undefined)
  assert.ok(!JSON.stringify(error).includes('private'))
  const detail = await responseError(Response.json({ detail: 'private admission detail' }, { status: 403, headers }))
  assert.equal(detail.code, 'PERMISSION')
  assert.ok(detail instanceof ChatGPTRequestError)
  assert.equal(detail.failure.status, 403)
  assert.equal(detail.failure.requestId, 'req_123-test')
  assert.ok(!detail.message.includes('private'))
  const html = await responseError(new Response('<html>proxy secret</html>', { status: 503, headers }))
  assert.equal(html.code, 'SERVER')
  assert.equal(html.failure.requestId, 'req_123-test')
  const unsafe = mapOpenAIError({ error: { code: 'bad\nsecret', param: 'Bearer secret', message: 'private prompt' } }, { status: 400, requestId: 'Bearer secret' })
  assert.equal(unsafe.failure.requestId, undefined)
  assert.ok(!JSON.stringify(unsafe).includes('secret'))
})

test('context overflow, quota, transport and incomplete responses use Harness recovery codes', () => {
  assert.equal(mapOpenAIError({ error: { code: 'context_length_exceeded' } }).code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(mapOpenAIError({ error: { message: 'Request exceeds the model context window.' } }, { status: 400 }).code, 'CONTEXT_WINDOW_EXCEEDED')
  assert.equal(mapOpenAIError({ error: { code: 'insufficient_quota' } }, { status: 429 }).code, 'QUOTA')
  assert.equal(mapOpenAIError({ code: 'server_error' }).code, 'SERVER')
  assert.equal(mapOpenAIError({ code: 'max_output_tokens' }).code, 'OUTPUT_LIMIT')
  assert.equal(mapOpenAIError({ code: 'content_filter' }).code, 'CONTENT_FILTER')
  assert.equal(mapOpenAIError(new OpenAI.APIConnectionTimeoutError()).code, 'TIMEOUT')
  assert.equal(mapOpenAIError(new TypeError('failed proxy with private credentials')).code, 'INTERNAL')
  const original = new LlmError('Local image requires offloading.', 'IMAGE_OFFLOAD_REQUIRED', { offloadImages: 2 })
  assert.equal(mapOpenAIError(original), original)
})

test('known connection errors retain safe diagnostics and remain retryable without exposing causes', () => {
  const policy = resolveRetryPolicy(undefined, 'test')
  assert.equal(policy.mode, 'normal')
  const headers = new Headers({ 'x-request-id': 'req_stream-123', 'set-cookie': 'private-cookie' })
  for (const [networkCode, kind] of [
    ['ECONNRESET', 'TRANSPORT'], ['ECONNREFUSED', 'TRANSPORT'], ['EAI_AGAIN', 'TRANSPORT'],
    ['UND_ERR_SOCKET', 'TRANSPORT'], ['ETIMEDOUT', 'TIMEOUT'], ['UND_ERR_CONNECT_TIMEOUT', 'TIMEOUT'],
    ['UND_ERR_HEADERS_TIMEOUT', 'TIMEOUT'], ['UND_ERR_BODY_TIMEOUT', 'TIMEOUT'],
  ] as const) {
    const cause = Object.assign(new Error('private socket URL https://user:password@proxy.invalid'), { code: networkCode, address: 'private-address' })
    const error = mapOpenAIError(new TypeError('private fetch message', { cause }), { phase: 'stream', status: 200, headers })
    assert.equal(error.code, kind)
    assert.equal(error.failure.requestId, 'req_stream-123')
    assert.match(error.failure.message, /phase stream; type TypeError/)
    assert.ok(error.failure.message.includes(`network ${networkCode}`))
    assert.equal(error.cause, undefined)
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes(error.code), true)
    assert.doesNotMatch(JSON.stringify(error), /private|password|proxy\.invalid/)
  }
  const sdk = mapOpenAIError(new OpenAI.APIConnectionError({ message: 'private request body' }), { phase: 'request' })
  assert.equal(sdk.code, 'TRANSPORT')
  assert.match(sdk.failure.message, /phase request; type APIConnectionError/)
  assert.doesNotMatch(JSON.stringify(sdk), /private/)
  assert.equal(mapOpenAIError(new DOMException('private timeout', 'TimeoutError')).code, 'TIMEOUT')
})

test('unknown local failures are non-retryable and successful HTTP status does not turn them into API errors', () => {
  const policy = resolveRetryPolicy(undefined, 'test')
  for (const original of [new TypeError('private credentials'), new SyntaxError('private JSON'), new ReferenceError('private path'), 'private thrown value']) {
    const error = mapOpenAIError(original, { phase: 'stream', status: 200, headers: new Headers({ 'x-request-id': 'req_known' }) })
    assert.equal(error.code, 'INTERNAL')
    assert.equal(error.failure.requestId, 'req_known')
    assert.match(error.failure.message, /phase stream/)
    assert.equal(policy.mode === 'normal' && policy.retryableCodes.includes(error.code), false)
    assert.doesNotMatch(JSON.stringify(error), /private/)
  }
  const misleading = Object.assign(new TypeError('context length quota exceeded private'), { code: 'invalid_request_error', name: 'APIConnectionError' })
  assert.equal(mapOpenAIError(misleading).code, 'INTERNAL', 'local exception text and names cannot masquerade as provider failures')
  const custom = Object.assign(new Error('private'), { name: 'PrivateErrorName', code: 'PRIVATE_NETWORK_CODE' })
  assert.doesNotMatch(JSON.stringify(mapOpenAIError(custom)), /PrivateErrorName|PRIVATE_NETWORK_CODE|private/)
})

test('connection cause inspection handles aggregates and cycles within a fixed bound without invoking getters', () => {
  const socket = Object.assign(new Error('private socket'), { code: 'ECONNRESET' })
  const aggregate = new AggregateError([new Error('private DNS'), socket], 'private addresses')
  const wrapped = new OpenAI.APIConnectionError({ cause: new TypeError('private fetch', { cause: aggregate }) })
  const mapped = mapOpenAIError(wrapped)
  assert.equal(mapped.code, 'TRANSPORT')
  assert.match(mapped.failure.message, /network ECONNRESET/)
  assert.doesNotMatch(JSON.stringify(mapped), /private/)

  const cycle = new Error('private cycle')
  cycle.cause = cycle
  assert.equal(mapOpenAIError(cycle).code, 'INTERNAL')
  aggregate.errors.unshift(aggregate)
  assert.equal(mapOpenAIError(aggregate).code, 'TRANSPORT')

  let deep: Error = socket
  for (let index = 0; index < 64; index++) deep = new Error('private chain', { cause: deep })
  const bounded = mapOpenAIError(deep)
  assert.equal(bounded.code, 'INTERNAL')
  assert.doesNotMatch(bounded.failure.message, /ECONNRESET/)

  let reads = 0
  const accessors = new TypeError('private accessor')
  Object.defineProperty(accessors, 'cause', { get() { reads++; throw new Error('private getter') } })
  assert.equal(mapOpenAIError(accessors).code, 'INTERNAL')
  assert.equal(reads, 0)
})

test('HTTP errors preserve safe request facts and phase in the serialized failure', async () => {
  const headers = new Headers({ 'x-request-id': 'req_catalog', 'retry-after-ms': '250', 'set-cookie': 'private' })
  const error = await responseError(Response.json({ error: { code: 'rate_limit_exceeded', message: 'private body' } }, { status: 429, headers }), { phase: 'catalog' })
  assert.equal(error.code, 'RATE_LIMIT')
  assert.deepEqual(error.failure, { message: error.message, code: 'RATE_LIMIT', status: 429, requestId: 'req_catalog', providerRetryAfterMs: 250 })
  assert.match(error.failure.message, /phase catalog/)
  assert.doesNotMatch(JSON.stringify(error), /private/)
  const unsafe = mapOpenAIError(new Error('private'), { phase: 'private invalid phase' as never, requestId: 'https://private.invalid' })
  assert.doesNotMatch(JSON.stringify(unsafe), /private/)
})

test('Retry-After supports seconds, HTTP dates and milliseconds without unbounded or invalid timers', () => {
  const now = Date.parse('2026-10-23T00:00:00Z')
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Fri, 23 Oct 2026 00:00:03 GMT' }), now), 3000)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': '9', 'retry-after-ms': '125.5' })), 126)
  for (const value of ['-1', 'nonsense', 'Infinity', '1e20', '999999999999999']) assert.equal(retryAfterMs(new Headers({ 'retry-after': value }), now), undefined)
  assert.equal(retryAfterMs(new Headers({ 'retry-after': 'Thu, 22 Oct 2026 00:00:00 GMT' }), now), undefined)
})

for (const code of ['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']) {
  test(`terminal refresh ${code} clears tokens, retains registration and invalidates outstanding requests`, async () => {
    const store = memoryStore(accountState())
    const oauth = new OAuth(async () => { throw new Error('unused') })
    oauth.refresh = async () => { throw new OAuthError(code) }
    let changed = 0
    const auth = new AuthService(store, oauth, config, () => { changed++ })
    try {
      const pending = await auth.access()
      await store.update(s => { s.accounts[0].tokens!.expiresAt = 0 })
      await assert.rejects(auth.access(), error => error instanceof OAuthError && error.code === code)
      const state = await store.read()
      assert.equal(state.accounts[0].tokens, undefined)
      assert.equal(state.accounts[0].clientId, 'client')
      assert.equal(state.activeId, 'account')
      assert.equal(pending.signal.aborted, true)
      assert.equal(changed, 1)
      assert.equal((await auth.status()).accounts[0].connected, false)
      assert.match((await auth.status()).notice!, /Reconnect/)
    } finally { auth.dispose() }
  })
}

test('transient refresh and invalid client preserve credentials and expose distinct recovery', async () => {
  for (const [code, status, kind] of [['http_503', 503, 'SERVER'], ['invalid_client', 400, 'CONFIGURATION']] as const) {
    const initial = accountState(); initial.accounts[0].tokens!.expiresAt = 0
    const store = memoryStore(initial)
    let changed = 0
    const oauth = new OAuth(async () => code === 'http_503'
      ? new Response('<html>private proxy diagnostic</html>', { status, headers: { 'retry-after': '5' } })
      : Response.json({ error: { code, message: 'private token' } }, { status }))
    const auth = new AuthService(store, oauth, config, () => { changed++ })
    try {
      await assert.rejects(auth.access(), error => {
        const mapped = mapOpenAIError(error)
        assert.equal(mapped.code, kind)
        assert.equal(mapped.failure.status, status)
        assert.ok(!JSON.stringify(mapped).includes('private'))
        if (status === 503) assert.equal(mapped.failure.providerRetryAfterMs, 5000)
        return true
      })
      assert.deepEqual(await store.read(), initial)
      assert.equal(changed, 0)
    } finally { auth.dispose() }
  }
})

test('cancelled refresh cannot publish a late token result', async () => {
  const initial = accountState(); initial.accounts[0].tokens!.expiresAt = 0
  const store = memoryStore(initial)
  const controller = new AbortController()
  const oauth = new OAuth(async () => { throw new Error('unused') })
  oauth.refresh = async () => { controller.abort(); return { ...initial.accounts[0].tokens!, access: 'late-token' } }
  const auth = new AuthService(store, oauth, config)
  try { await assert.rejects(auth.access(controller.signal)); assert.deepEqual(await store.read(), initial) }
  finally { auth.dispose() }
})

test('refresh rotation is committed when the returned grant disables plan usage', async () => {
  const initial = accountState(); initial.accounts[0].tokens!.expiresAt = 0
  const store = memoryStore(initial)
  const oauth = new OAuth(async () => { throw new Error('unused') })
  oauth.refresh = async () => ({ ...initial.accounts[0].tokens!, access: 'new-access', refresh: 'rotated-refresh', expiresAt: Date.now() + 3_600_000, scopes: ['openid'] })
  let changed = 0
  const auth = new AuthService(store, oauth, config, () => { changed++ })
  try {
    await assert.rejects(auth.access(), error => error instanceof OAuthError && error.code === 'plan_permission_required')
    const state = await store.read()
    assert.equal(state.accounts[0].tokens!.refresh, 'rotated-refresh')
    assert.equal((await auth.status()).accounts[0].connected, true)
    assert.equal((await auth.status()).accounts[0].sharing, false)
    assert.equal(changed, 1)
    assert.match((await auth.status()).notice!, /plan usage is disabled/)
  } finally { auth.dispose() }
})

test('logout during adapter authorization preserves internal cancellation instead of a retryable transport error', async () => {
  const initial = accountState(); initial.accounts[0].tokens!.expiresAt = 0
  const store = memoryStore(initial)
  const oauth = new OAuth(async () => { throw new Error('unused') })
  let started!: () => void
  const refreshing = new Promise<void>(resolve => { started = resolve })
  oauth.refresh = async (_account, signal) => new Promise((_resolve, reject) => {
    signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    started()
  })
  oauth.revoke = async () => {}
  const auth = new AuthService(store, oauth, config)
  let requests = 0
  const adapter = new ChatGPTAdapter(auth, async () => { requests++; throw new Error('No request may be dispatched') })
  const caller = new AbortController()
  try {
    const pending = adapter.prepareCall('chatgpt-sub', 'model', caller.signal)
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError' && !(error instanceof LlmError))
    await refreshing
    await auth.logout('account')
    await rejected
    assert.equal(caller.signal.aborted, false, 'the cancellation came from the account session, not the caller')
    assert.equal(requests, 0)
  } finally { auth.dispose() }
})
