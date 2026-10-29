import test from 'node:test'
import assert from 'node:assert/strict'
import { EMPTY_RESPONSE_CODE, LlmError, ReasoningEffortId, resolveRetryPolicy, type GenerateOptions, type StreamChunk, type MessageId, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { buildRequest } from '../src/adapter/request.js'
import { convertStream } from '../src/adapter/stream.js'
import { ChatGPTAdapter } from '../src/adapter/index.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth, SCOPES } from '../src/auth/oauth.js'
import { memoryStore } from './helpers.js'
import type { Fetch } from '../src/network/fetch.js'
import { ChatGPTRequestError } from '../src/adapter/errors.js'

async function* events(values: unknown[]) { for (const value of values) yield value as ResponseStreamEvent }
const completed = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] }], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 5 } } } }
test('stream preserves tools, reasoning replay, disjoint usage and terminal finish', async () => {
  const result: StreamChunk[] = []
  for await (const chunk of convertStream(events([
    { type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Checking.' },
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-1', call_id: 'call-1', name: 'read_file', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-1', delta: '{"path":"README.md"}' }, completed,
  ]))) result.push(chunk)
  assert.equal(result.filter(c => c.type === 'block-start').length, 2)
  assert.equal(result.filter(c => c.type === 'block-end').length, 2)
  assert.deepEqual(result.find(c => c.type === 'usage'), { type: 'usage', usage: { inputTokens: 70, outputTokens: 20, totalTokens: 120, cacheReadTokens: 30, reasoningTokens: 5 } })
  const last = result.at(-1)
  assert.equal(last?.type, 'finish')
  if (last?.type === 'finish') { assert.equal(last.reason.kind, 'tool-calls'); assert.deepEqual(last.replayState?.response, { output: completed.response.output }) }
})
test('partial text followed by EOF, incomplete, or usage failure never succeeds', async () => {
  for (const terminal of [undefined, { type: 'response.incomplete', response: {} }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]) {
    const stream = convertStream(events([{ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Partial' }, ...terminal ? [terminal] : []]))
    const chunks: StreamChunk[] = []
    await assert.rejects(async () => { for await (const chunk of stream) chunks.push(chunk) })
    assert.equal(chunks.some(c => c.type === 'finish'), false)
  }
})
test('EOF before output permits Harness retry and retains request diagnostics', async () => {
  const policy = resolveRetryPolicy(undefined, 'test')
  for (const values of [[], [
    { type: 'response.created', response: { output: [] } },
    { type: 'response.in_progress', response: { output: [] } },
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: '' },
  ]]) {
    await assert.rejects(async () => { for await (const _chunk of convertStream(events(values), 'one', { phase: 'stream', headers: new Headers({ 'x-request-id': 'req_empty' }) })) {} }, error => {
      assert.ok(error instanceof ChatGPTRequestError)
      assert.equal(error.code, EMPTY_RESPONSE_CODE)
      assert.equal(error.failure.requestId, 'req_empty')
      assert.match(error.message, /phase stream/)
      assert.ok(policy.mode === 'normal' && policy.retryableCodes.includes(error.code))
      return true
    })
  }
})
test('EOF after text, reasoning, opaque output or a hosted action never permits default retry', async () => {
  const policy = resolveRetryPolicy(undefined, 'test')
  const partial = [
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Partial' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r', summary_index: 0, delta: 'Thinking' },
    { type: 'response.refusal.delta', item_id: 'm', content_index: 0, delta: 'Cannot' },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [], status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'tool', call_id: 'call', name: 'read_file', arguments: '' } },
    { type: 'response.web_search_call.in_progress', item_id: 'search' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search', query: 'Query' } } },
  ]
  for (const value of partial) {
    await assert.rejects(async () => { for await (const _chunk of convertStream(events([value]))) {} }, error => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'INTERRUPTED_STREAM', value.type)
      assert.ok(policy.mode === 'normal' && !policy.retryableCodes.includes(error.code))
      return true
    })
  }
})
test('a transient stream exception is retryable only before output, with safe diagnostics preserved', async () => {
  for (const partial of [undefined, { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Partial' }, { type: 'response.web_search_call.in_progress', item_id: 'search' }]) {
    async function* broken() {
      if (partial) yield partial as ResponseStreamEvent
      throw new TypeError('private transport details', { cause: Object.assign(new Error('private socket details'), { code: 'ECONNRESET' }) })
    }
    await assert.rejects(async () => { for await (const _chunk of convertStream(broken(), undefined, { phase: 'stream', headers: new Headers({ 'x-request-id': 'req_broken', 'retry-after': '2' }) })) {} }, error => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, partial ? 'INTERRUPTED_STREAM' : 'TRANSPORT')
      assert.equal(error.failure.requestId, 'req_broken')
      assert.equal(error.failure.providerRetryAfterMs, 2000)
      assert.match(error.message, /phase stream/)
      assert.match(error.message, /ECONNRESET/)
      assert.equal(JSON.stringify(error).includes('private'), false)
      assert.equal(error.cause, undefined)
      return true
    })
  }
})
test('stream failures preserve nonretryable codes and cancellation while suppressing retries after partial output', async () => {
  const first = { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Partial' }
  for (const [providerCode, expected] of [['server_error', 'INTERRUPTED_STREAM'], ['rate_limit_exceeded', 'INTERRUPTED_STREAM'], ['subscription_sharing_usage_limit_exceeded', 'QUOTA'], ['content_filter', 'CONTENT_FILTER']] as const) {
    await assert.rejects(async () => { for await (const _chunk of convertStream(events([first, { type: 'response.failed', response: { error: { code: providerCode } } }]))) {} }, error => error instanceof LlmError && error.code === expected)
  }
  const abort = new DOMException('Cancelled', 'AbortError')
  async function* cancelled() { yield first as ResponseStreamEvent; throw abort }
  await assert.rejects(async () => { for await (const _chunk of convertStream(cancelled())) {} }, error => error === abort)
  const chunks: StreamChunk[] = []
  for await (const chunk of convertStream(events([{ type: 'response.completed', response: { status: 'completed', output: [] } }]))) chunks.push(chunk)
  assert.equal(chunks.at(-1)?.type, 'finish', 'an explicit completed response retains its existing terminal behavior')
})
test('GPT-5.6 and GPT-6 cache writes are disjoint from reads and ordinary input', async () => {
  for (const details of [{ cached_tokens: 0, cache_write_tokens: 100 }, { cached_tokens: 70, cache_write_tokens: 20 }]) {
    const response = { ...completed.response, usage: { ...completed.response.usage, input_tokens_details: details } }
    const chunks: StreamChunk[] = []
    for await (const chunk of convertStream(events([{ type: 'response.completed', response }]))) chunks.push(chunk)
    const usage = chunks.find(chunk => chunk.type === 'usage')
    assert.equal(usage?.type, 'usage')
    if (usage?.type !== 'usage') throw new Error('No usage chunk')
    assert.equal(usage.usage.inputTokens + usage.usage.cacheReadTokens! + usage.usage.cacheWriteTokens!, 100)
    assert.equal(usage.usage.cacheReadTokens, details.cached_tokens)
    assert.equal(usage.usage.cacheWriteTokens, details.cache_write_tokens)
    assert.equal(usage.usage.totalTokens, 120)
  }
})
test('usage distinguishes an unreported cache read count from an explicit zero', async () => {
  for (const details of [undefined, {}, { cache_write_tokens: 20 }, { cached_tokens: 0 }]) {
    const response = { ...completed.response, usage: { ...completed.response.usage, input_tokens_details: details } }
    const chunks: StreamChunk[] = []
    for await (const chunk of convertStream(events([{ type: 'response.completed', response }]))) chunks.push(chunk)
    const usage = chunks.find(chunk => chunk.type === 'usage')
    if (usage?.type !== 'usage') throw new Error('No usage chunk')
    assert.equal(usage.usage.cacheReadTokens, details?.cached_tokens)
    assert.equal(Object.hasOwn(usage.usage, 'cacheReadTokens'), details?.cached_tokens !== undefined)
    assert.equal(usage.usage.inputTokens, 100 - (details?.cache_write_tokens ?? 0))
    assert.equal(usage.usage.outputTokens, 20)
    assert.equal(usage.usage.totalTokens, 120)
  }
})
test('stream replays completed items when terminal response output is empty', async () => {
  const output = [
    { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] },
    { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Remembered answer', annotations: [], logprobs: [] }] },
  ]
  const chunks: StreamChunk[] = []
  for await (const chunk of convertStream(events([
    { type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Remembered answer' },
    { type: 'response.output_item.done', output_index: 1, item: output[1] },
    { type: 'response.output_item.done', output_index: 0, item: output[0] },
    { type: 'response.completed', response: { ...completed.response, output: [] } },
  ]), 'account')) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type === 'finish') assert.deepEqual(finish.replayState?.response, { output, accountId: 'account' })
})
test('empty replay output falls back to visible assistant history', () => {
  const request = buildRequest({ provider: 'chatgpt-sub', model: 'gpt-6-luna', messages: [{
    id: 'm' as MessageId, role: 'assistant', content: [{ type: 'text', text: 'Remembered answer' }],
    source: { kind: 'model', provider: 'chatgpt-sub', model: 'gpt-6-luna', replayState: { response: { output: [], accountId: 'account' } } },
  }] } as GenerateOptions, 'account')
  assert.deepEqual(request.input, [{ role: 'assistant', content: 'Remembered answer' }])
})
test('terminal-only items use announced output positions and matching terminal items replace completed versions once', async () => {
  const reason = { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] }
  const message = { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Remembered answer', annotations: [] }] }
  const call = { type: 'function_call', id: 'function-item', call_id: 'local-call', name: 'checkpoint', arguments: '{}', status: 'completed' }
  const revisedCall = { ...call, arguments: '{"confirmed":true}' }
  const tail = { ...reason, id: 'terminal-only-reason' }
  const { encrypted_content: _encrypted, ...terminalReason } = reason
  const chunks: StreamChunk[] = []
  for await (const chunk of convertStream(events([
    { type: 'response.output_item.added', output_index: 0, item: reason },
    { type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'Remembered answer' },
    { type: 'response.output_item.added', output_index: 2, item: call },
    { type: 'response.output_item.added', output_index: 3, item: tail },
    { type: 'response.output_item.done', output_index: 2, item: call },
    { type: 'response.output_item.done', output_index: 1, item: message },
    { type: 'response.output_item.done', output_index: 0, item: reason },
    { type: 'response.completed', response: { status: 'completed', output: [terminalReason, revisedCall, tail] } },
  ]), 'account')) chunks.push(chunk)
  const finish = chunks.at(-1)
  assert.equal(finish?.type, 'finish')
  if (finish?.type === 'finish') assert.deepEqual(finish.replayState?.response, { output: [reason, message, revisedCall, tail], accountId: 'account' })
})
test('request uses public Responses stateless contract and preserves tool IDs', () => {
  const options = {
    provider: 'chatgpt-sub', model: 'available-model', system: 'Be helpful',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Read a file' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{}' }], source: { kind: 'model', provider: 'chatgpt-sub', model: 'available-model' } },
      { role: 'tool', content: [{ type: 'text', text: 'Contents' }], source: { kind: 'tool', callId: 'call-1' } },
    ], tools: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
  } as GenerateOptions
  const request = buildRequest(options)
  assert.equal(request.stream, true); assert.equal(request.store, false)
  assert.deepEqual(request.include, ['reasoning.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results'])
  assert.ok(Array.isArray(request.input))
  assert.equal(request.input.at(-1)?.type, 'function_call_output')
  assert.throws(() => buildRequest({ ...options, stop: ['END'] }), /stop sequences/)
})
test('ChatGPT OAuth uses developer instructions and omits unsupported sampling and output limits', () => {
  const request = buildRequest({
    provider: 'chatgpt-sub', model: 'gpt-6-luna', system: 'Initial instructions', maxTokens: 12, temperature: 0.2,
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Session instructions' }] },
      { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      { role: 'system', content: [{ type: 'text', text: 'Later instructions' }] },
    ],
  } as GenerateOptions)
  assert.deepEqual(request.input, [
    { role: 'developer', content: 'Initial instructions' },
    { role: 'developer', content: 'Session instructions' },
    { role: 'user', content: 'Question' },
    { role: 'developer', content: 'Later instructions' },
  ])
  for (const field of ['max_output_tokens', 'temperature', 'prompt_cache_retention', 'prompt_cache_options', 'prompt_cache_key']) {
    assert.equal(Object.hasOwn(request, field), false, `${field} must be omitted`)
  }
})
test('prompt cache association is stable per account and session across appended turns', () => {
  const options: GenerateOptions = { provider: 'chatgpt-sub', model: 'gpt-6-luna', sessionId: 'session-one' as NonNullable<GenerateOptions['sessionId']>, messages: [{ role: 'user', content: [{ type: 'text', text: 'Question' }] }] }
  const first = buildRequest(options, 'account-one')
  const second = buildRequest({ ...options, messages: [...options.messages, { role: 'user', content: [{ type: 'text', text: 'Follow up' }] }] }, 'account-one')
  assert.match(first.prompt_cache_key!, /^[a-f0-9]{64}$/)
  assert.equal(second.prompt_cache_key, first.prompt_cache_key)
  assert.notEqual(buildRequest({ ...options, sessionId: 'session-two' as NonNullable<GenerateOptions['sessionId']> }, 'account-one').prompt_cache_key, first.prompt_cache_key)
  assert.notEqual(buildRequest(options, 'account-two').prompt_cache_key, first.prompt_cache_key)
  assert.equal(JSON.stringify(first).includes('account-one'), false)
  assert.equal(JSON.stringify(first).includes('session-one'), false)
})
test('switching models drops tool item IDs but preserves call linkage and encrypted reasoning', () => {
  const options = {
    provider: 'chatgpt-sub', model: 'new-model', messages: [{ id: 'message-id' as MessageId, role: 'assistant', content: [], source: {
      kind: 'model', provider: 'chatgpt-sub', model: 'old-model', replayState: { response: { output: [
        { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] },
        { type: 'function_call', id: 'item', call_id: 'call', name: 'tool', arguments: '{}' },
      ] } },
    } }],
  } as GenerateOptions
  const request = buildRequest(options)
  assert.ok(Array.isArray(request.input))
  assert.deepEqual(request.input[1], { type: 'function_call', namespace: 'harness', call_id: 'call', name: 'tool', arguments: '{}' })
  assert.deepEqual(request.input[0], { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] })
})

test('real OpenAI SSE client uses account catalog, shared transport and required request flags', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (String(url).endsWith('/models')) return Response.json({ models: [
      { visibility: 'hidden', slug: 'hidden-model', display_name: 'Hidden' },
      { visibility: 'list', slug: 'available-model', display_name: 'Available' },
    ] })
    return new Response([
      { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Hello' }, completed,
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const store = memoryStore({ version: 1, hostId: 'urn:uuid:test', activeId: 'one', accounts: ['one', 'two'].map(id => ({ id, clientId: id, subject: id, email: `${id}@example.com`, tokens: { access: `${id}-token`, idToken: 'test', expiresAt: Date.now() + 3600000, scopes: SCOPES.split(' ') } })) })
  const auth = new AuthService(store, new OAuth(fetcher), { proxyMode: 'direct', proxyUrlEnv: '', callbackPort: 0 })
  const adapter = new ChatGPTAdapter(auth, fetcher)
  try {
    assert.deepEqual((await adapter.listModels()).map(m => m.id), ['available-model'])
    const options: GenerateOptions = { provider: 'chatgpt-sub', model: 'available-model', sessionId: 'session-one' as NonNullable<GenerateOptions['sessionId']>, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }
    const chunks = []; for await (const chunk of adapter.stream(options)) chunks.push(chunk)
    assert.equal(chunks.at(-1)?.type, 'finish')
    const request = requests.find(r => r.url.endsWith('/responses'))!
    assert.equal(request.url, 'https://api.openai.com/v1/responses')
    const headers = new Headers(request.init?.headers)
    assert.equal(headers.get('authorization'), 'Bearer one-token')
    assert.match(headers.get('user-agent')!, /deepseek-harness/)
    assert.equal(JSON.parse(String(request.init?.body)).store, false)
    assert.equal(JSON.parse(String(request.init?.body)).stream, true)
    assert.equal(headers.get('session_id'), JSON.parse(String(request.init?.body)).prompt_cache_key)
    assert.match(headers.get('x-client-request-id')!, /^[0-9a-f-]{36}$/)
    for await (const _chunk of adapter.stream(options)) {}
    const repeated = requests.filter(r => r.url.endsWith('/responses')).at(-1)!
    const repeatedHeaders = new Headers(repeated.init?.headers)
    assert.equal(repeatedHeaders.get('session_id'), headers.get('session_id'))
    assert.notEqual(repeatedHeaders.get('x-client-request-id'), headers.get('x-client-request-id'))
    const prepared = await adapter.prepareCall('chatgpt-sub', 'available-model')
    await auth.select('two')
    const count = requests.length
    await assert.rejects(async () => { for await (const _chunk of prepared.stream(options)) {} })
    assert.equal(requests.length, count, 'switching accounts must abort a prepared call before it sends a prompt')
    for await (const _chunk of adapter.stream(options)) {}
    const switched = requests.filter(r => r.url.endsWith('/responses')).at(-1)!
    assert.notEqual(new Headers(switched.init?.headers).get('session_id'), headers.get('session_id'))
  } finally { auth.dispose() }
})
test('encrypted replay from another account is replaced by semantic history', () => {
  const options = { provider: 'chatgpt-sub', model: 'same-model', messages: [{
    id: 'm' as MessageId, role: 'assistant', content: [{ type: 'text', text: 'Visible answer' }],
    source: { kind: 'model', provider: 'chatgpt-sub', model: 'same-model', replayState: { response: { accountId: 'other-account', output: [{ type: 'reasoning', encrypted_content: 'private-encrypted' }] } } },
  }] } as GenerateOptions
  const request = buildRequest(options, 'active-account')
  assert.equal(JSON.stringify(request).includes('private-encrypted'), false)
  assert.equal(JSON.stringify(request).includes('Visible answer'), true)
})
test('another provider cannot supply raw ChatGPT replay even with a matching account', () => {
  const options = { provider: 'chatgpt-sub', model: 'same-model', messages: [{
    id: 'm' as MessageId, role: 'assistant', content: [
      { type: 'text', text: 'Visible answer' },
      { type: 'tool-call', id: 'visible-call', name: 'read_file', arguments: '{"path":"README.md"}' },
    ],
    source: { kind: 'model', provider: 'other-provider', model: 'same-model', replayState: { response: { accountId: 'active-account', output: [
      { type: 'reasoning', id: 'foreign-reasoning', encrypted_content: 'foreign-encrypted', summary: [] },
      { type: 'function_call', id: 'foreign-item', call_id: 'foreign-call', name: 'unrelated_tool', arguments: '{}' },
    ] } } },
  }] } as GenerateOptions
  const original = structuredClone(options)
  for (const account of ['active-account', undefined]) {
    const request = buildRequest(options, account)
    assert.deepEqual(request.input, [
      { role: 'assistant', content: 'Visible answer' },
      { type: 'function_call', namespace: 'harness', call_id: 'visible-call', name: 'read_file', arguments: '{"path":"README.md"}' },
    ])
    assert.equal(JSON.stringify(request).includes('foreign-'), false)
  }
  assert.deepEqual(options, original)
})

test('account model catalog enables only advertised efforts and forwards selection and usage', async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  const usageReports: TokenUsage[] = []
  const fetcher: Fetch = async (url, init) => {
    requests.push({ url: String(url), ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) })
    if (String(url).endsWith('/models')) return Response.json({ models: [
      { visibility: 'list', slug: 'gpt-6-luna', default_reasoning_level: 'medium', supported_reasoning_levels: [
        { effort: 'low', description: 'Fast' }, { effort: 'medium', description: 'Balanced' }, { effort: 'max', description: 'Deep' },
        { effort: 'max', description: 'Duplicate' }, { effort: '' }, null,
      ] },
      { visibility: 'list', slug: 'gpt-5.6-sol', default_reasoning_level: 'unknown', supported_reasoning_levels: [{ effort: 'ultra' }] },
      { visibility: 'list', slug: 'plain-model' },
    ] })
    return new Response(`data: ${JSON.stringify(completed)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const store = memoryStore({ version: 1, hostId: 'urn:uuid:test', activeId: 'one', accounts: [{ id: 'one', clientId: 'one', subject: 'one', email: 'one@example.com', tokens: { access: 'one-token', idToken: 'test', expiresAt: Date.now() + 3600000, scopes: SCOPES.split(' ') } }] })
  const auth = new AuthService(store, new OAuth(fetcher), { proxyMode: 'direct', proxyUrlEnv: '', callbackPort: 0 })
  const adapter = new ChatGPTAdapter(auth, fetcher)
  try {
    const model = await adapter.resolveModel('chatgpt-sub', 'gpt-6-luna')
    assert.deepEqual(model.reasoning, { efforts: [
      { id: 'low', name: 'low', description: 'Fast' },
      { id: 'medium', name: 'medium', description: 'Balanced' },
      { id: 'max', name: 'max', description: 'Deep' },
    ], defaultEffort: 'medium' })
    assert.equal((await adapter.resolveModel('chatgpt-sub', 'gpt-5.6-sol')).reasoning?.defaultEffort, undefined)
    assert.equal((await adapter.resolveModel('chatgpt-sub', 'plain-model')).reasoning, undefined)
    const options: GenerateOptions = { provider: 'chatgpt-sub', model: 'gpt-6-luna', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] }
    for await (const chunk of adapter.stream(options)) { if (chunk.type === 'usage') usageReports.push(chunk.usage) }
    for await (const chunk of adapter.stream({ ...options, reasoningEffort: ReasoningEffortId('max') })) { if (chunk.type === 'usage') usageReports.push(chunk.usage) }
    const calls = requests.filter(request => request.url.endsWith('/responses'))
    assert.deepEqual(calls.map(call => call.body?.reasoning), [{ effort: 'medium', summary: 'auto' }, { effort: 'max', summary: 'auto' }])
    assert.equal(usageReports.length, 2)
    assert.equal(usageReports[0].cacheReadTokens, 30)
    const count = requests.length
    await assert.rejects(async () => { for await (const _chunk of adapter.stream({ ...options, reasoningEffort: ReasoningEffortId('ultra') })) {} }, /reasoning effort/)
    assert.equal(requests.length, count, 'unsupported efforts must fail before sending a prompt')
    assert.equal(usageReports.length, 2)
  } finally { auth.dispose() }
})
