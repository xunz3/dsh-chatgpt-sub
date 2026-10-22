import test from 'node:test'
import assert from 'node:assert/strict'
import { ReasoningEffortId, type GenerateOptions, type StreamChunk, type MessageId, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { buildRequest } from '../src/adapter/request.js'
import { convertStream } from '../src/adapter/stream.js'
import { ChatGPTAdapter } from '../src/adapter/index.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth, SCOPES } from '../src/auth/oauth.js'
import { memoryStore } from './helpers.js'
import type { Fetch } from '../src/network/transport.js'

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
  assert.deepEqual(request.include, ['reasoning.encrypted_content'])
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
  assert.deepEqual(request.input[1], { type: 'function_call', call_id: 'call', name: 'tool', arguments: '{}' })
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
