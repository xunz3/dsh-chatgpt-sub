import { EMPTY_RESPONSE_CODE, LlmError, resolveRetryPolicy, type ContentBlock, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ResponseStreamEvent, ResponseOutputItem } from 'openai/resources/responses/responses'
import { citeText } from './citations.js'
import { TOOL_NAMESPACE } from './request.js'
import { ChatGPTRequestError, mapOpenAIError, type ErrorContext } from './errors.js'
import { searchActionText } from './search-progress.js'
import { searchEvidence } from './search-evidence.js'

const retryPolicy = resolveRetryPolicy(undefined, 'chatgpt-sub')
const retryableCodes = new Set(retryPolicy.mode === 'normal' ? retryPolicy.retryableCodes : [])

interface UsageFacts {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null
  output_tokens_details?: { reasoning_tokens?: number } | null
}
function usageChunk(usage: UsageFacts | null | undefined): StreamChunk | undefined {
  if (!usage) return undefined
  const cached = usage.input_tokens_details?.cached_tokens
  const written = usage.input_tokens_details?.cache_write_tokens
  return { type: 'usage', usage: {
    inputTokens: Math.max(0, usage.input_tokens - (cached ?? 0) - (written ?? 0)), outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    ...(cached === undefined ? {} : { cacheReadTokens: cached }), ...(written === undefined ? {} : { cacheWriteTokens: written }),
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
  } }
}

/** A provider item may already contain opaque output or have executed a hosted tool. */
function outputStarted(event: ResponseStreamEvent): boolean {
  if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done' || event.type.startsWith('response.web_search_call.')) return true
  if ('delta' in event && typeof event.delta === 'string' && event.delta.length > 0) return true
  if ('part' in event && (('text' in event.part && !!event.part.text) || ('refusal' in event.part && !!event.part.refusal))) return true
  if ('annotation' in event) return true
  return 'response' in event && Array.isArray(event.response.output) && event.response.output.length > 0
}

/** Item events carry stable output positions even when the terminal array is partial. */
function replayOutput(terminal: ResponseOutputItem[], completed: Map<number, ResponseOutputItem>, indexes: Map<string, number>): ResponseOutputItem[] {
  const entries = [...completed].map(([index, item]) => ({ index, item }))
  for (const [position, item] of terminal.entries()) {
    const index = item.id ? indexes.get(item.id) ?? position : position
    const previous = entries.find(entry => entry.item.type === item.type && (item.id
      ? entry.item.id === item.id
      : !entry.item.id && entry.index === index))
    if (!previous) { entries.push({ index, item }); continue }
    // Explicit terminal values win, including empty search result/source lists.
    previous.item = previous.item.type === 'web_search_call' && item.type === 'web_search_call'
      ? { ...previous.item, ...item, action: { ...previous.item.action, ...item.action } }
      : { ...previous.item, ...item } as ResponseOutputItem
  }
  return entries.sort((a, b) => a.index - b.index).map(entry => entry.item)
}

/** Convert SSE events while retaining encrypted reasoning for stateless tool continuations. */
export async function* convertStream(events: AsyncIterable<ResponseStreamEvent>, accountId?: string, context: ErrorContext = {}): AsyncGenerator<StreamChunk> {
  const blocks = new Map<string, { index: number; block: ContentBlock }>()
  const toolIds = new Map<string, string>()
  const completedItems = new Map<number, ResponseOutputItem>()
  const outputIndexes = new Map<string, number>()
  const citations = new Map<string, unknown[]>()
  const searches = new Map<string, { details?: string; status?: 'completed' | 'failed' }>()
  const closed = new Set<string>()
  function* closeBlock(key: string): Generator<StreamChunk> {
    const entry = blocks.get(key)
    if (!entry || closed.has(key)) return
    closed.add(key)
    const { index, block } = entry
    yield { type: 'block-end', index, block: block.type === 'text' ? { ...block, text: citeText(block.text, citations.get(key) ?? []) } : block }
  }
  let next = 0
  let tools = false
  let hasOutput = false
  function* searchProgress(id: string, action?: unknown, status?: string): Generator<StreamChunk> {
    const key = `search:${id}`
    let state = searches.get(id)
    if (!state) {
      state = {}; searches.set(id, state)
      const index = next++
      const block: ContentBlock = { type: 'reasoning', text: 'Searching the web…\n' }
      blocks.set(key, { index, block })
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: block.text }
    }
    const entry = blocks.get(key)!
    if (entry.block.type !== 'reasoning') return
    const details = searchActionText(action)
    if (details && details !== state.details) {
      state.details = details
      entry.block.text += `${details}\n`
      yield { type: 'reasoning-delta', index: entry.index, text: `${details}\n` }
    }
    if ((status === 'completed' || status === 'failed') && status !== state.status) {
      state.status = status
      const text = status === 'failed' ? 'Web search failed.\n' : 'Web search completed.\n'
      entry.block.text += text
      yield { type: 'reasoning-delta', index: entry.index, text }
    }
    // Keep this block open: completion may precede the item carrying its action.
    // The final block replaces transient progress with the complete concise view.
    entry.block.text = `${state.status === 'completed' ? 'Web search completed.' : state.status === 'failed' ? 'Web search failed.' : 'Searching the web…'}\n${state.details ? `${state.details}\n` : ''}`
  }
  try {
    for await (const event of events) {
      hasOutput ||= outputStarted(event)
      if ((event.type === 'response.output_item.added' || event.type === 'response.output_item.done') && event.item.id && Number.isInteger(event.output_index)) {
        outputIndexes.set(event.item.id, event.output_index)
      }
      if (event.type === 'response.output_item.done') {
        completedItems.set(event.output_index, event.item)
        if (event.item.type === 'web_search_call') yield* searchProgress(event.item.id, event.item.action, event.item.status)
        if (event.item.type === 'message') for (const [index, part] of event.item.content.entries()) {
          const key = `text:${event.item.id}:${index}`
          if (part.type === 'output_text' && part.annotations?.length) citations.set(key, part.annotations)
          yield* closeBlock(key)
        }
      } else if (event.type === 'response.content_part.done' && event.part.type === 'output_text') {
        const key = `text:${event.item_id}:${event.content_index}`
        if (event.part.annotations?.length) citations.set(key, event.part.annotations)
        yield* closeBlock(key)
      } else if (event.type === 'response.output_text.annotation.added') {
        const key = `text:${event.item_id}:${event.content_index}`
        const entries = citations.get(key) ?? []
        entries.push(event.annotation); citations.set(key, entries)
      } else if (event.type === 'response.web_search_call.in_progress' || event.type === 'response.web_search_call.searching') {
        yield* searchProgress(event.item_id)
      } else if (event.type === 'response.web_search_call.completed') {
        yield* searchProgress(event.item_id, undefined, 'completed')
      } else if (event.type === 'response.output_item.added' && event.item.type === 'web_search_call') {
        yield* searchProgress(event.item.id, event.item.action, event.item.status)
      } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
        const item = event.item
        if (item.namespace && item.namespace !== TOOL_NAMESPACE) throw new LlmError('Unknown tool namespace in ChatGPT response.', 'INVALID_STREAM')
        const key = `tool:${item.id}`
        blocks.set(key, { index: next++, block: { type: 'tool-call', id: item.call_id as ToolCallId, name: item.name, arguments: item.arguments ?? '' } })
        toolIds.set(item.id!, key)
        const { index } = blocks.get(key)!
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: item.call_id as ToolCallId, name: item.name, argumentsDelta: item.arguments ?? '' }
        tools = true
      } else if (event.type === 'response.function_call_arguments.delta') {
        const entry = blocks.get(toolIds.get(event.item_id) ?? '')
        if (!entry || entry.block.type !== 'tool-call') throw new LlmError('Tool stream arrived out of order.', 'INVALID_STREAM')
        entry.block.arguments += event.delta
        yield { type: 'tool-call-delta', index: entry.index, id: entry.block.id, argumentsDelta: event.delta }
      } else if (event.type === 'response.output_text.delta' || event.type === 'response.reasoning_summary_text.delta' || event.type === 'response.refusal.delta') {
        const reasoning = event.type === 'response.reasoning_summary_text.delta'
        const part = reasoning ? event.summary_index : event.content_index
        const key = `${reasoning ? 'reasoning' : 'text'}:${event.item_id}:${part}`
        let entry = blocks.get(key)
        if (!entry) {
          entry = { index: next++, block: { type: reasoning ? 'reasoning' : 'text', text: '' } }
          blocks.set(key, entry)
          yield { type: 'block-start', index: entry.index, blockType: entry.block.type }
        }
        if (entry.block.type === 'text' || entry.block.type === 'reasoning') entry.block.text += event.delta
        yield { type: reasoning ? 'reasoning-delta' : 'text-delta', index: entry.index, text: event.delta }
      } else if (event.type === 'response.incomplete' && event.response.incomplete_details?.reason === 'max_output_tokens') {
        const output = replayOutput(event.response.output ?? [], completedItems, outputIndexes)
        // Harness ends max-tokens turns before executing any tool calls. Even a
        // complete call would therefore be replayed without a matching result.
        // Within replayState, its max-tokens filtering only sanitizes blocks;
        // our response.output would still contain function_call items.
        // Fail rather than commit orphaned calls. Non-abort failures are recorded
        // as attempts, not recoverable partial assistant messages.
        if (tools || output.some(item => item.type === 'function_call')) {
          throw new ChatGPTRequestError('ChatGPT reached its output limit during tool calls. The response could not be completed safely.', 'INTERRUPTED_STREAM', context)
        }
        // The provider chose its own output cap (this sign-in channel rejects
        // max_output_tokens). A truncated answer is a completed turn with
        // `max-tokens`, not a failed one; keep its partial blocks and replay state.
        for (const item of event.response.output ?? []) {
          if (item.type === 'web_search_call') yield* searchProgress(item.id, item.action, item.status)
          if (item.type === 'message') item.content.forEach((part, index) => {
            if (part.type === 'output_text' && part.annotations?.length) citations.set(`text:${item.id}:${index}`, part.annotations)
          })
        }
        for (const key of blocks.keys()) yield* closeBlock(key)
        const usage = usageChunk(event.response.usage)
        if (usage) yield usage
        const evidence = searchEvidence(output)
        if (evidence) {
          const index = next++
          yield { type: 'block-start', index, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index, text: evidence }
          yield { type: 'block-end', index, block: { type: 'reasoning', text: evidence } }
        }
        yield { type: 'finish', reason: { kind: 'max-tokens' }, replayState: { response: { output, ...(accountId ? { accountId } : {}) } } }
        return
      } else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
        const error = event.type === 'error' ? event : event.response.error ?? { code: event.type === 'response.incomplete' ? event.response.incomplete_details?.reason ?? 'incomplete_response' : 'response_failed' }
        throw mapOpenAIError({ error }, context)
      } else if (event.type === 'response.completed') {
        if (event.response.status !== 'completed') throw new LlmError('Unexpected ChatGPT completion status.', 'INVALID_STREAM')
        for (const item of event.response.output ?? []) {
          if (item.type === 'web_search_call') yield* searchProgress(item.id, item.action, item.status)
          if (item.type === 'message') item.content.forEach((part, index) => {
            if (part.type === 'output_text' && part.annotations?.length) citations.set(`text:${item.id}:${index}`, part.annotations)
          })
        }
        for (const key of blocks.keys()) yield* closeBlock(key)
        const usage = usageChunk(event.response.usage)
        if (usage) yield usage
        // Encrypted reasoning and call IDs must survive stateless continuations.
        // Some streaming responses omit output items from the terminal snapshot.
        // Retain the completed item events so later turns can replay the answer.
        const output = replayOutput(event.response.output ?? [], completedItems, outputIndexes)
        const evidence = searchEvidence(output)
        if (evidence) {
          // Ordinary persisted content participates in Harness's token meter
          // and compaction. Reuse its folded process view, like search progress.
          const index = next++
          yield { type: 'block-start', index, blockType: 'reasoning' }
          yield { type: 'reasoning-delta', index, text: evidence }
          yield { type: 'block-end', index, block: { type: 'reasoning', text: evidence } }
        }
        yield { type: 'finish', reason: { kind: tools ? 'tool-calls' : 'stop' }, replayState: { response: { output, ...(accountId ? { accountId } : {}) } } }
        return
      }
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    const mapped = mapOpenAIError(error, context)
    if (!hasOutput || !retryableCodes.has(mapped.code)) throw mapped
    const { status, providerRetryAfterMs, requestId } = mapped.failure
    const detail = mapped instanceof ChatGPTRequestError ? ` ${mapped.message}` : ''
    throw new LlmError(`ChatGPT stream was interrupted after output began.${detail}`, 'INTERRUPTED_STREAM', { status, providerRetryAfterMs, requestId })
  }
  throw new ChatGPTRequestError('ChatGPT stream ended before completion.', hasOutput ? 'INTERRUPTED_STREAM' : EMPTY_RESPONSE_CODE, context)
}
