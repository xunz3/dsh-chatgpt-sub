import assert from 'node:assert/strict'
import test from 'node:test'
import { LlmError, createDeveloperMessage, projectToolUpdates, type GenerateOptions, type MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'
import { ChatGPTAdapter } from '../src/adapter/index.js'
import { buildRequest } from '../src/adapter/request.js'
import { searchTools } from '../src/adapter/search.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth, SCOPES } from '../src/auth/oauth.js'
import type { Fetch } from '../src/network/fetch.js'
import type { SearchMode } from '../src/shared/search.js'
import { memoryStore } from './helpers.js'

const modes: SearchMode[] = ['native', 'harness', 'off']
const tools = [
  { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { queries: { type: 'array', items: { type: 'string' } } } } },
  { name: 'web_fetch', description: 'Read a URL', parameters: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'read_file', description: 'Read a local file', parameters: { type: 'object' } },
  { name: 'mcp_web_search', description: 'An unrelated extension tool', parameters: { type: 'object' } },
]
const codeTool = { name: 'run_code', description: 'Call tools through the Harness SDK', parameters: { type: 'object' } }
const base: GenerateOptions = { provider: 'chatgpt-sub', model: 'test-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Find current information.' }] }], tools }

function functionNames(request: ResponseCreateParamsStreaming) {
  return request.tools?.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(entry => entry.name) : []) ?? []
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

test('each mode selects direct search declarations without changing agent instructions or unrelated tools', () => {
  for (const mode of modes) {
    const request = buildRequest(base, 'account', undefined, { searchMode: mode })
    assert.deepEqual(functionNames(request), mode === 'harness'
      ? ['web_search', 'web_fetch', 'read_file', 'mcp_web_search']
      : ['web_fetch', 'read_file', 'mcp_web_search'])
    assert.equal(request.tools?.some(tool => tool.type === 'web_search'), mode === 'native')
    assert.equal(request.instructions, undefined)
  }
})

test('search selection leaves other providers and their tool presentation untouched', () => {
  for (const provider of ['deepseek', 'openai', 'other-chatgpt-route']) {
    for (const mode of modes) {
      const options = { ...base, provider, tools: [...tools, codeTool] }
      const result = searchTools(options, mode)
      assert.equal(result.tools, options.tools)
      assert.equal(result.native, false)
      const request = buildRequest(options, undefined, undefined, { searchMode: mode })
      assert.deepEqual(functionNames(request), options.tools.map(tool => tool.name))
      assert.equal(request.instructions, undefined)
    }
  }
})

test('native search follows the selected mode independently of Harness tool visibility or session identity', () => {
  const sessionId = 'known-live-session' as NonNullable<GenerateOptions['sessionId']>
  for (const mode of modes) {
    for (const declarations of [undefined, [], [tools[0]!], [tools[1]!]]) {
      const options = { ...base, sessionId, tools: declarations }
      const request = buildRequest(options, 'account', undefined, { searchMode: mode })
      assert.equal(request.tools?.some(tool => tool.type === 'web_search') ?? false, mode === 'native')
      assert.equal(functionNames(request).includes('web_search'), !!declarations?.includes(tools[0]!) && mode === 'harness')
    }
  }
  const defaultRequest = buildRequest({ ...base, tools: undefined }, 'account')
  assert.deepEqual(defaultRequest.tools, [{ type: 'web_search' }], 'new configurations default to native search in the current Responses call')
})

test('title and compaction requests expose neither search in every mode', () => {
  for (const purpose of ['session-title', 'compaction'] as const) {
    for (const mode of modes) {
      const request = buildRequest({ ...base, purpose }, 'account', undefined, { searchMode: mode })
      assert.deepEqual(functionNames(request), ['web_fetch', 'read_file', 'mcp_web_search'])
      assert.equal(request.tools?.some(tool => tool.type === 'web_search'), false)
    }
  }
})

test('opaque Harness tool transports remain available in every search mode', () => {
  const options = freeze({ ...base, tools: [codeTool, ...tools] })
  for (const mode of modes) {
    for (const purpose of [undefined, 'session-title', 'compaction'] as const) {
      const request = buildRequest({ ...options, purpose }, undefined, undefined, { searchMode: mode })
      assert.deepEqual(functionNames(request), mode === 'harness' && purpose === undefined
        ? ['run_code', 'web_search', 'web_fetch', 'read_file', 'mcp_web_search']
        : ['run_code', 'web_fetch', 'read_file', 'mcp_web_search'])
      assert.equal(request.tools?.some(tool => tool.type === 'web_search'), mode === 'native' && purpose === undefined)
      assert.equal(request.instructions, undefined)
    }
  }
})

test('historical run_code calls remain intact in every search mode', () => {
  const callId = 'old-code-call' as ToolCallId
  const options: GenerateOptions = { ...base, tools: [], messages: [
    { id: 'old-code-message' as MessageId, role: 'assistant', source: { kind: 'model', provider: 'chatgpt-sub', model: base.model }, content: [{ type: 'tool-call', id: callId, name: 'run_code', arguments: '{"code":"return previousResult"}' }] },
    { id: 'old-code-result' as MessageId, role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'Old result' }] },
    ...base.messages,
  ] }
  for (const mode of modes) {
    const request = buildRequest(options, 'account', undefined, { searchMode: mode })
    assert.ok(Array.isArray(request.input))
    assert.deepEqual(request.input.slice(0, 2), [
      { type: 'function_call', namespace: 'harness', call_id: callId, name: 'run_code', arguments: '{"code":"return previousResult"}' },
      { type: 'function_call_output', call_id: callId, output: 'Old result' },
    ])
    assert.deepEqual(request.tools, mode === 'native' ? [{ type: 'web_search' }] : undefined)
  }
})

test('filtering a frozen request does not mutate tool declarations, schemas or history', () => {
  const options = freeze(structuredClone(base))
  const snapshot = structuredClone(options)
  for (const mode of modes) buildRequest(options, 'account', undefined, { searchMode: mode })
  assert.deepEqual(options, snapshot)
  assert.equal(options.tools?.[0]?.name, 'web_search')
})

/** All HTTP is synthetic; an unexpected route fails instead of reaching a network. */
function adapterFixture(searchMode?: () => SearchMode, respond?: () => Response, preparingAttachments?: () => void) {
  const requests: Array<{ url: string; body?: ResponseCreateParamsStreaming }> = []
  const fetcher: Fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) as ResponseCreateParamsStreaming : undefined
    requests.push({ url, body })
    if (url === 'https://api.openai.com/v1/models') return Response.json({ models: [{ visibility: 'list', slug: base.model, input_modalities: ['text'] }] })
    assert.equal(url, 'https://api.openai.com/v1/responses', 'the adapter must not issue a separate search request')
    if (respond) return respond()
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const store = memoryStore({ version: 1, hostId: 'test-host', activeId: 'test-account', accounts: [{ id: 'test-account', clientId: 'test-client', subject: 'test-subject', email: 'test@example.com', tokens: { access: 'synthetic-access', idToken: 'synthetic-id', expiresAt: Date.now() + 3_600_000, scopes: SCOPES.split(' ') } }] })
  const auth = new AuthService(store, new OAuth(fetcher), { callbackPort: 0 })
  const adapter = new ChatGPTAdapter(auth, fetcher, () => { preparingAttachments?.(); return {} }, { searchMode })
  return { adapter, auth, requests }
}

test('the actual adapter applies mode changes to the current Responses request without separate search requests', async () => {
  let mode: SearchMode = 'native'
  const fixture = adapterFixture(() => mode)
  try {
    const prepared = await fixture.adapter.prepareCall(base.provider, base.model)
    for (const nextMode of modes) {
      mode = nextMode
      for await (const _chunk of prepared.stream({ ...base, sessionId: 'live-session' as NonNullable<GenerateOptions['sessionId']> })) {}
      const request = fixture.requests.at(-1)!.body!
      assert.equal(request.tools?.some(tool => tool.type === 'web_search'), mode === 'native')
      assert.equal(functionNames(request).includes('web_search'), mode === 'harness')
      assert.equal(request.model, base.model)
    }
    assert.equal(fixture.requests.filter(request => request.url.endsWith('/models')).length, 1)
    assert.equal(fixture.requests.filter(request => request.url.endsWith('/responses')).length, modes.length)
  } finally { fixture.auth.dispose() }
})

test('default native mode omits direct Harness search while passing PTC through to the model', async () => {
  const fixture = adapterFixture()
  try {
    const prepared = await fixture.adapter.prepareCall(base.provider, base.model)
    for await (const _chunk of prepared.stream(base)) {}
    assert.deepEqual(functionNames(fixture.requests.at(-1)!.body!), ['web_fetch', 'read_file', 'mcp_web_search'])
    assert.equal(fixture.requests.at(-1)!.body!.tools?.some(tool => tool.type === 'web_search'), true)
    for await (const _chunk of prepared.stream({ ...base, tools: [codeTool] })) {}
    const request = fixture.requests.at(-1)!.body!
    assert.deepEqual(functionNames(request), ['run_code'])
    assert.equal(request.tools?.some(tool => tool.type === 'web_search'), true)
    assert.equal(request.instructions, undefined)
  } finally { fixture.auth.dispose() }
})

test('prepared adapter sends Harness additions through the SDK at their historical position', async () => {
  const fixture = adapterFixture(() => 'off')
  try {
    const prepared = await fixture.adapter.prepareCall(base.provider, base.model)
    assert.equal(prepared.model.toolUpdate, 'addition-only')
    const activate = createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'tool-addition', toolName: codeTool.name }] })
    const history = { tools: [tools[2]!], updates: [{ messageId: activate.id, additions: [codeTool] }] }
    const messages = [...base.messages, activate]
    const current = [tools[2]!, codeTool]
    const projected = projectToolUpdates(messages, current, prepared.model.toolUpdate, history)
    for await (const _chunk of prepared.stream({ ...base, messages: [...projected.messages], tools: [...projected.tools!], toolHistory: history })) {}
    const body = fixture.requests.at(-1)!.body!
    assert.deepEqual(functionNames(body), ['read_file'])
    assert.ok(Array.isArray(body.input))
    assert.deepEqual(body.input[0], { role: 'user', content: 'Find current information.' })
    const added = body.input[1]
    assert.equal(added.type, 'additional_tools')
    if (added.type !== 'additional_tools') throw new Error('Missing activation')
    assert.equal(added.role, 'developer')
    assert.deepEqual(added.tools, [{ type: 'namespace', name: 'harness', description: 'Tools executed by DeepSeek Harness.', tools: [
      { type: 'function', name: codeTool.name, description: codeTool.description, parameters: codeTool.parameters, strict: false },
    ] }])
  } finally { fixture.auth.dispose() }
})

test('the adapter reads one mode snapshot before attachment preparation and picks up changes on the next dispatch', async () => {
  let mode: SearchMode = 'native'
  let reads = 0
  const fixture = adapterFixture(() => { reads++; return mode }, undefined, () => { mode = 'off' })
  try {
    const prepared = await fixture.adapter.prepareCall(base.provider, base.model)
    assert.equal(reads, 0, 'model preparation does not capture a stale preference')
    for await (const _chunk of prepared.stream(base)) {}
    assert.equal(reads, 1)
    assert.equal(fixture.requests.at(-1)!.body!.tools?.some(tool => tool.type === 'web_search'), true, 'retain the mode captured before preparation')
    for await (const _chunk of prepared.stream(base)) {}
    assert.equal(reads, 2)
    assert.equal(fixture.requests.at(-1)!.body!.tools?.some(tool => tool.type === 'web_search'), false, 'apply the newly selected mode to the next dispatch')
  } finally { fixture.auth.dispose() }
})

test('the actual adapter omits both searches for title and compaction requests in every mode', async () => {
  let mode: SearchMode = 'native'
  const fixture = adapterFixture(() => mode)
  try {
    const prepared = await fixture.adapter.prepareCall(base.provider, base.model)
    for (const nextMode of modes) {
      mode = nextMode
      for (const purpose of ['session-title', 'compaction'] as const) {
        for await (const _chunk of prepared.stream({ ...base, purpose })) {}
        const request = fixture.requests.at(-1)!.body!
        assert.equal(request.tools?.some(tool => tool.type === 'web_search'), false)
        assert.deepEqual(functionNames(request), ['web_fetch', 'read_file', 'mcp_web_search'])
      }
    }
    assert.equal(fixture.requests.filter(request => request.url.endsWith('/responses')).length, modes.length * 2)
  } finally { fixture.auth.dispose() }
})

test('unsupported native search fails once without retrying, removing the tool or switching to Harness', async () => {
  const fixture = adapterFixture(() => 'native', () => Response.json({ error: { code: 'subscription_sharing_unsupported_capability', param: 'tools[1].type', message: 'Search unavailable for this model' } }, { status: 400 }))
  try {
    await assert.rejects(async () => { for await (const _chunk of fixture.adapter.stream(base)) {} }, error => {
      assert.ok(error instanceof LlmError)
      assert.equal(error.code, 'UNSUPPORTED_CONTENT')
      assert.match(error.message, /subscription_sharing_unsupported_capability/)
      return true
    })
    const requests = fixture.requests.filter(request => request.url.endsWith('/responses'))
    assert.equal(requests.length, 1)
    assert.equal(requests[0]!.body!.tools?.some(tool => tool.type === 'web_search'), true)
    assert.equal(functionNames(requests[0]!.body!).includes('web_search'), false)
  } finally { fixture.auth.dispose() }
})
