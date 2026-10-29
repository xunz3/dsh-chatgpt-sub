import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError, resolveRetryPolicy, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatGPTAdapter } from '../src/adapter/index.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth, SCOPES } from '../src/auth/oauth.js'
import { memoryStore } from './helpers.js'
import type { Fetch } from '../src/network/fetch.js'

const options: GenerateOptions = { provider: 'chatgpt-sub', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Test request' }] }] }
const headers = { 'Content-Type': 'text/event-stream', 'x-request-id': 'req_stream-test', 'set-cookie': 'private-cookie' }
const policy = resolveRetryPolicy(undefined, 'chatgpt-sub')
function retryable(error: LlmError) { return policy.mode === 'normal' && policy.retryableCodes.includes(error.code) }
function sse(event: unknown) { return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`) }
function reset() { return new TypeError('private endpoint and prompt', { cause: Object.assign(new Error('private proxy credential'), { code: 'ECONNRESET' }) }) }

function fixture(respond: () => Response, prepare?: () => never) {
  const store = memoryStore({ version: 1, hostId: 'test-host', activeId: 'test-account', accounts: [{ id: 'test-account', clientId: 'test-client', subject: 'test-subject', email: 'test@example.com', tokens: { access: 'private-access', idToken: 'private-id', expiresAt: Date.now() + 3_600_000, scopes: SCOPES.split(' ') } }] })
  let inferences = 0
  const fetcher: Fetch = async input => {
    if (String(input) === 'https://api.openai.com/v1/models') return Response.json({ models: [{ visibility: 'list', slug: options.model }] })
    assert.equal(String(input), 'https://api.openai.com/v1/responses')
    inferences++
    return respond()
  }
  const auth = new AuthService(store, new OAuth(fetcher), { callbackPort: 0 })
  return { auth, adapter: new ChatGPTAdapter(auth, fetcher, () => { prepare?.(); return {} }), inferences: () => inferences }
}

async function failed(adapter: ChatGPTAdapter, chunks: StreamChunk[] = []) {
  try { for await (const chunk of adapter.stream(options)) chunks.push(chunk) }
  catch (error) { assert.ok(error instanceof LlmError); return error }
  throw new Error('Expected a failed request')
}

test('real SDK stream failures retain safe response diagnostics before output', async () => {
  const f = fixture(() => new Response(new ReadableStream({ pull(controller) { controller.error(reset()) } }), { headers }))
  try {
    const error = await failed(f.adapter)
    assert.equal(error.code, 'TRANSPORT')
    assert.equal(error.failure.requestId, 'req_stream-test')
    assert.match(error.message, /phase stream/)
    assert.match(error.message, /ECONNRESET/)
    assert.ok(retryable(error))
    assert.equal(f.inferences(), 1, 'SDK retries remain disabled; Harness owns retry decisions')
    assert.ok(!JSON.stringify(error).includes('private'))
  } finally { f.auth.dispose() }
})

test('partial SDK output survives a network failure without automatic whole-request retry', async () => {
  const f = fixture(() => {
    let reads = 0
    return new Response(new ReadableStream({ pull(controller) {
      if (reads++ === 0) controller.enqueue(sse({ type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Already visible' }))
      else controller.error(reset())
    } }), { headers })
  })
  try {
    const chunks: StreamChunk[] = []
    const error = await failed(f.adapter, chunks)
    assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Already visible'))
    assert.equal(error.code, 'INTERRUPTED_STREAM')
    assert.equal(error.failure.requestId, 'req_stream-test')
    assert.match(error.message, /phase stream/)
    assert.match(error.message, /ECONNRESET/)
    assert.equal(retryable(error), false)
    assert.equal(chunks.some(chunk => chunk.type === 'finish'), false)
    assert.equal(f.inferences(), 1)
    assert.ok(!JSON.stringify(error).includes('private'))
  } finally { f.auth.dispose() }
})

test('metadata-only SDK EOF reaches Harness as a retryable empty response', async () => {
  const f = fixture(() => new Response(sse({ type: 'response.created', response: { status: 'in_progress' } }), { headers }))
  try {
    const error = await failed(f.adapter)
    assert.equal(error.code, 'EMPTY_RESPONSE')
    assert.equal(error.failure.requestId, 'req_stream-test')
    assert.match(error.message, /phase stream/)
    assert.ok(retryable(error))
    assert.equal(f.inferences(), 1)
  } finally { f.auth.dispose() }
})

test('local preparation bugs stop before inference and do not masquerade as proxy failures', async () => {
  const f = fixture(() => { throw new Error('No inference expected') }, () => { throw new TypeError('private attachment input') })
  try {
    const error = await failed(f.adapter)
    assert.equal(error.code, 'INTERNAL')
    assert.match(error.message, /phase preparation/)
    assert.equal(error.failure.requestId, undefined)
    assert.equal(retryable(error), false)
    assert.equal(f.inferences(), 0)
    assert.ok(!JSON.stringify(error).includes('private'))
  } finally { f.auth.dispose() }
})

test('malformed SDK stream data cannot leak through diagnostics or the SDK logger', async t => {
  const logged: unknown[][] = []
  for (const level of ['debug', 'info', 'warn', 'error'] as const) t.mock.method(console, level, (...args: unknown[]) => { logged.push(args) })
  const previous = process.env.OPENAI_LOG
  process.env.OPENAI_LOG = 'debug'
  const f = fixture(() => new Response('data: {private-invalid-payload\n\n', { headers }))
  try {
    const error = await failed(f.adapter)
    assert.equal(error.code, 'INTERNAL')
    assert.match(error.message, /phase stream/)
    assert.match(error.message, /SyntaxError/)
    assert.equal(error.failure.requestId, 'req_stream-test')
    assert.equal(retryable(error), false)
    assert.deepEqual(logged, [])
    assert.ok(!JSON.stringify(error).includes('private'))
  } finally {
    if (previous === undefined) delete process.env.OPENAI_LOG
    else process.env.OPENAI_LOG = previous
    f.auth.dispose()
  }
})

test('pre-response connection failures retain request phase and remain eligible for host retry', async () => {
  const f = fixture(() => { throw reset() })
  try {
    const error = await failed(f.adapter)
    assert.equal(error.code, 'TRANSPORT')
    assert.match(error.message, /phase request/)
    assert.match(error.message, /ECONNRESET/)
    assert.ok(retryable(error))
    assert.equal(f.inferences(), 1)
    assert.ok(!JSON.stringify(error).includes('private'))
  } finally { f.auth.dispose() }
})
