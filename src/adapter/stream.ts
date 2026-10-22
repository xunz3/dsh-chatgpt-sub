import { LlmError, type ContentBlock, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ResponseStreamEvent, ResponseOutputItem } from 'openai/resources/responses/responses'

/** Convert SSE events while retaining encrypted reasoning for stateless tool continuations. */
export async function* convertStream(events: AsyncIterable<ResponseStreamEvent>, accountId?: string): AsyncGenerator<StreamChunk> {
  const blocks = new Map<string, { index: number; block: ContentBlock }>()
  const toolIds = new Map<string, string>()
  const completedItems = new Map<number, ResponseOutputItem>()
  let next = 0
  let tools = false
  for await (const event of events) {
    if (event.type === 'response.output_item.done') {
      completedItems.set(event.output_index, event.item)
    } else if (event.type === 'response.output_item.added' && event.item.type === 'function_call') {
      const item = event.item
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
    } else if (event.type === 'response.failed' || event.type === 'response.incomplete' || event.type === 'error') {
      const code = event.type === 'error' ? event.code : event.response.error?.code ?? (event.type === 'response.incomplete' ? 'incomplete_response' : 'response_failed')
      const limit = code?.startsWith('subscription_sharing_usage_')
      throw new LlmError(limit ? 'ChatGPT plan usage is unavailable or has reached its limit. Manage usage at https://chatgpt.com/settings/usage.' : 'ChatGPT did not complete the response. Please retry.', limit ? 'RATE_LIMIT' : 'RESPONSE_FAILED')
    } else if (event.type === 'response.completed') {
      if (event.response.status !== 'completed') throw new LlmError('Unexpected ChatGPT completion status.', 'INVALID_STREAM')
      for (const { index, block } of blocks.values()) yield { type: 'block-end', index, block }
      const usage = event.response.usage
      if (usage) {
        const cached = usage.input_tokens_details?.cached_tokens
        const written = usage.input_tokens_details?.cache_write_tokens
        yield { type: 'usage', usage: { inputTokens: Math.max(0, usage.input_tokens - (cached ?? 0) - (written ?? 0)), outputTokens: usage.output_tokens, totalTokens: usage.total_tokens, ...(cached === undefined ? {} : { cacheReadTokens: cached }), ...(written === undefined ? {} : { cacheWriteTokens: written }), reasoningTokens: usage.output_tokens_details?.reasoning_tokens } }
      }
      // Encrypted reasoning and call IDs must survive stateless continuations.
      // Some streaming responses omit output items from the terminal snapshot.
      // Retain the completed item events so later turns can replay the answer.
      const output: ResponseOutputItem[] = event.response.output?.length
        ? event.response.output
        : [...completedItems].sort(([a], [b]) => a - b).map(([, item]) => item)
      yield { type: 'finish', reason: { kind: tools ? 'tool-calls' : 'stop' }, replayState: { response: { output, ...(accountId ? { accountId } : {}) } } }
      return
    }
  }
  throw new LlmError('ChatGPT stream ended before completion.', 'INTERRUPTED_STREAM')
}
