import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantMessage, createDeveloperMessage, createToolResultMessage, projectToolUpdates, type GenerateOptions, type ToolSchema } from '@deepseek-ai/dsh-llm'
import type { ResponseCreateParamsStreaming, ResponseInputItem, Tool } from 'openai/resources/responses/responses'
import { buildRequest } from '../src/adapter/request.js'
import type { SearchMode } from '../src/shared/search.js'

const tool = (name: string): ToolSchema => ({ name, description: `Use ${name}`, parameters: { type: 'object', properties: {} } })
const read = tool('read_file')
const terminal = tool('terminal_open')
const plugin = tool('plugin_market')
const user = (text: string) => ({ role: 'user' as const, content: [{ type: 'text' as const, text }] })
const addition = (...tools: ToolSchema[]) => createDeveloperMessage({ source: { kind: 'user' }, content: tools.map(tool => ({ type: 'tool-addition', toolName: tool.name })) })
const base: GenerateOptions = {
  provider: 'chatgpt-sub', model: 'gpt-6.1-sol', sessionId: 'session' as GenerateOptions['sessionId'],
  tools: [read], messages: [user('Start work')], toolHistory: { tools: [read], updates: [] },
}

/** Exercise the real Harness projection before the provider wire mapping. */
function request(options: GenerateOptions, searchMode: SearchMode = 'off') {
  const projected = projectToolUpdates(options.messages, options.tools, 'addition-only', options.toolHistory)
  return buildRequest({ ...options, messages: [...projected.messages], tools: projected.tools && [...projected.tools] }, 'account', undefined, { searchMode })
}
function input(request: ResponseCreateParamsStreaming): ResponseInputItem[] {
  assert.ok(Array.isArray(request.input))
  return request.input
}
function names(tools: readonly Tool[] = []) {
  return tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(tool => tool.name) : [])
}
function loaded(request: ResponseCreateParamsStreaming) {
  return input(request).flatMap(item => item.type === 'additional_tools' ? names(item.tools) : [])
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

test('dynamic loads preserve earlier wire prefixes through calls, results and restored history', () => {
  const first = request(base)
  const activate = addition(terminal)
  const secondOptions: GenerateOptions = {
    ...base, tools: [read, terminal], messages: [...base.messages, activate],
    toolHistory: { tools: [read], updates: [{ messageId: activate.id, additions: [terminal] }] },
  }
  const second = request(secondOptions)
  assert.equal(JSON.stringify(first.tools), JSON.stringify(second.tools))
  assert.equal(JSON.stringify(input(first)), JSON.stringify(input(second).slice(0, input(first).length)))
  assert.deepEqual(loaded(second), ['terminal_open'])
  assert.deepEqual(input(second).at(-1), {
    type: 'additional_tools', role: 'developer', tools: [{
      type: 'namespace', name: 'harness', description: 'Tools executed by DeepSeek Harness.',
      tools: [{ type: 'function', name: terminal.name, description: terminal.description, parameters: terminal.parameters, strict: false }],
    }],
  })
  const callId = 'call' as Parameters<typeof createToolResultMessage>[0]['callId']
  const assistant = createAssistantMessage({
    content: [{ type: 'tool-call', id: callId, name: terminal.name, arguments: '{}' }],
    source: { provider: base.provider, model: base.model, replayState: { response: { accountId: 'account', output: [
      { type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] },
      { type: 'function_call', namespace: 'harness', id: 'fc', call_id: callId, name: terminal.name, arguments: '{}' },
    ] } } },
  })
  const result = createToolResultMessage({ callId, isError: false, content: [{ type: 'text', text: 'Opened' }] })
  const next = addition(plugin)
  const thirdOptions = freeze<GenerateOptions>({
    ...secondOptions, tools: [plugin, read, terminal], messages: [...secondOptions.messages, assistant, result, next, user('Continue')],
    toolHistory: { tools: [read], updates: [...secondOptions.toolHistory!.updates, { messageId: next.id, additions: [plugin] }] },
  })
  const third = request(thirdOptions)
  assert.equal(JSON.stringify(second.tools), JSON.stringify(third.tools))
  assert.equal(JSON.stringify(input(second)), JSON.stringify(input(third).slice(0, input(second).length)))
  assert.deepEqual(loaded(third), ['terminal_open', 'plugin_market'])
  assert.deepEqual(input(third).slice(2, 5), [
    { type: 'reasoning', id: 'r', encrypted_content: 'opaque', summary: [] },
    { type: 'function_call', namespace: 'harness', id: 'fc', call_id: callId, name: terminal.name, arguments: '{}' },
    { type: 'function_call_output', call_id: callId, output: 'Opened' },
  ])
  assert.equal(first.prompt_cache_key, third.prompt_cache_key)
  assert.deepEqual(request(structuredClone(thirdOptions)), third, 'resume reconstructs identical declarations without adapter state')
})

test('removal excludes both baseline and loaded tools; reactivation never duplicates a definition', () => {
  const activate = addition(terminal, plugin)
  const remove = createDeveloperMessage({ source: { kind: 'user' }, content: [
    { type: 'tool-removal', toolName: read.name }, { type: 'tool-removal', toolName: terminal.name },
  ] })
  const options: GenerateOptions = {
    ...base, tools: [plugin], messages: [...base.messages, activate, remove],
    toolHistory: { tools: [read], updates: [{ messageId: activate.id, additions: [terminal, plugin] }, { messageId: remove.id, additions: [] }] },
  }
  const removed = request(options)
  assert.deepEqual(names(removed.tools), [])
  assert.deepEqual(loaded(removed), ['plugin_market'])
  assert.equal(JSON.stringify(removed).includes('terminal_open'), false)
  const readd = addition(terminal)
  const restored = request({ ...options, tools: [terminal, plugin], messages: [...options.messages, readd], toolHistory: {
    ...options.toolHistory!, updates: [...options.toolHistory!.updates, { messageId: readd.id, additions: [terminal] }],
  } })
  assert.deepEqual(loaded(restored), ['terminal_open', 'plugin_market'])
})

test('schema resets use the latest definitions and later additions can start appending again', () => {
  const activate = addition(terminal)
  const changed = { ...terminal, description: 'Updated terminal', parameters: { type: 'object', required: ['cwd'] } }
  const options: GenerateOptions = {
    ...base, tools: [read, changed], messages: [...base.messages, activate],
    toolHistory: { tools: [read, changed], updates: [] },
  }
  const reset = request(options)
  assert.deepEqual(names(reset.tools), ['read_file', 'terminal_open'])
  assert.deepEqual(loaded(reset), [])
  assert.ok(JSON.stringify(reset.tools).includes('Updated terminal'))
  const next = addition(plugin)
  const following = request({ ...options, tools: [read, changed, plugin], messages: [...options.messages, next], toolHistory: {
    tools: [read, changed], updates: [{ messageId: next.id, additions: [plugin] }],
  } })
  assert.deepEqual(following.tools, reset.tools)
  assert.deepEqual(loaded(following), ['plugin_market'])
})

test('Harness strips developer events and supplies full current tools when history is missing or truncated', () => {
  const activate = addition(terminal)
  const note = createDeveloperMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Registry note' }] })
  const options: GenerateOptions = { ...base, tools: [read, terminal], messages: [...base.messages, note, activate], toolHistory: {
    tools: [read], updates: [{ messageId: activate.id, additions: [terminal] }],
  } }
  for (const variant of [
    { ...options, toolHistory: undefined },
    { ...options, messages: [user('Compacted summary'), note] },
  ]) {
    const projected = projectToolUpdates(variant.messages, variant.tools, 'addition-only', variant.toolHistory)
    assert.equal(projected.messages.some(message => message.role === 'developer'), false)
    assert.deepEqual(projected.tools, variant.tools)
    const result = request(variant)
    assert.deepEqual(names(result.tools), ['read_file', 'terminal_open'])
    assert.deepEqual(loaded(result), [])
    assert.equal(JSON.stringify(result.input).includes('Registry note'), false)
  }
})

test('wire conversion uses projected tools after block cloning and needs no loop-owned toolHistory', () => {
  const activate = addition(terminal)
  const history = { tools: [read], updates: [{ messageId: activate.id, additions: [terminal] }] }
  const projected = projectToolUpdates([...base.messages, activate], [read, terminal], 'addition-only', history)
  const options: GenerateOptions = { ...base, messages: structuredClone([...projected.messages]), tools: structuredClone([...projected.tools!]), toolHistory: undefined }
  const result = buildRequest(options, 'account', undefined, { searchMode: 'off' })
  assert.deepEqual(names(result.tools), ['read_file'])
  assert.deepEqual(loaded(result), ['terminal_open'])
  assert.deepEqual(buildRequest({ ...options, toolHistory: { tools: [], updates: [] } }, 'account', undefined, { searchMode: 'off' }), result)
  assert.equal(JSON.stringify(result).includes('defer_loading'), false)
})

test('deferred baseline tools activate only at the recorded history item', () => {
  const deferred = { ...terminal, deferLoading: true as const }
  const options: GenerateOptions = { ...base, tools: [read, deferred], toolHistory: { tools: [read, deferred], updates: [] } }
  const before = request(options)
  assert.deepEqual(names(before.tools), ['read_file'])
  const activate = addition(deferred)
  const after = request({ ...options, messages: [...base.messages, activate], toolHistory: {
    tools: [read, deferred], updates: [{ messageId: activate.id, additions: [deferred] }],
  } })
  assert.deepEqual(after.tools, before.tools)
  assert.deepEqual(loaded(after), ['terminal_open'])
  assert.equal(JSON.stringify(after).includes('defer_loading'), false, 'this route must not use Responses tool_search')
})

test('mixed developer text retains its order around batched additions', () => {
  const activate = createDeveloperMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text: 'Before' }, { type: 'tool-addition', toolName: terminal.name },
    { type: 'tool-addition', toolName: plugin.name }, { type: 'text', text: 'After' },
  ] })
  const result = request({ ...base, tools: [read, terminal, plugin], messages: [...base.messages, activate], toolHistory: {
    tools: [read], updates: [{ messageId: activate.id, additions: [terminal, plugin] }],
  } })
  assert.deepEqual(input(result)[1], { role: 'developer', content: 'Before' })
  assert.equal(input(result)[2].type, 'additional_tools')
  assert.deepEqual(loaded(result), ['terminal_open', 'plugin_market'])
  assert.deepEqual(input(result)[3], { role: 'developer', content: 'After' })
})

test('search policy applies to loaded tools and auxiliary requests use complete current declarations', () => {
  const search = tool('web_search')
  const fetch = tool('web_fetch')
  const code = tool('run_code')
  const activate = addition(search, fetch, code)
  const options = freeze<GenerateOptions>({ ...base, tools: [read, search, fetch, code], messages: [...base.messages, activate], toolHistory: {
    tools: [read], updates: [{ messageId: activate.id, additions: [search, fetch, code] }],
  } })
  const snapshot = structuredClone(options)
  for (const mode of ['native', 'harness', 'off'] as const) {
    const result = request(options, mode)
    assert.deepEqual(names(result.tools), ['read_file'])
    assert.deepEqual(loaded(result), mode === 'harness' ? ['web_search', 'web_fetch', 'run_code'] : ['web_fetch', 'run_code'])
    assert.equal(result.tools?.some(tool => tool.type === 'web_search'), mode === 'native')
    for (const purpose of ['compaction', 'session-title'] as const) {
      const auxiliary = request({ ...options, purpose }, mode)
      assert.deepEqual(names(auxiliary.tools), ['read_file', 'web_fetch', 'run_code'])
      assert.deepEqual(loaded(auxiliary), [])
      assert.equal(auxiliary.tools?.some(tool => tool.type === 'web_search'), false)
    }
  }
  assert.deepEqual(options, snapshot)
})
