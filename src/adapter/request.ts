import { createHash } from 'node:crypto'
import { LlmError, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ResponseInput, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'

export function buildRequest(options: GenerateOptions, accountId?: string): ResponseCreateParamsStreaming {
  if (options.stop?.length) throw new LlmError('ChatGPT Responses does not support stop sequences.', 'UNSUPPORTED_PARAMETER')
  const input: ResponseInput = []
  if (options.system) input.push({ role: 'developer', content: options.system })
  for (const message of options.messages) {
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (message.content.some(block => block.type === 'image' || block.type === 'file')) throw new LlmError('This adapter accepts text and tools. Attachments must be projected by Harness.', 'UNSUPPORTED_CONTENT')
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.source.callId, output: text })
    } else if (message.role === 'assistant') {
      const replay = message.source.replayState as { response?: { output?: ResponseInput; accountId?: string } } | undefined
      if (Array.isArray(replay?.response?.output) && replay.response.output.length > 0 && (!accountId || replay.response.accountId === accountId)) {
        input.push(...replay.response.output.map(item => {
          if (message.source.model !== options.model && item.type === 'function_call') {
            const { id: _id, ...call } = item
            return call
          }
          return item
        }))
        continue
      }
      if (text) input.push({ role: 'assistant', content: text })
      for (const block of message.content) if (block.type === 'tool-call') input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments })
    } else if (text) input.push({ role: message.role === 'system' ? 'developer' : message.role, content: text })
  }
  // Keep related calls associated without exposing account or session identifiers.
  // Like Pi's public ChatGPT flow, this supplies affinity, not a cache-hit guarantee.
  const cacheKey = options.sessionId ? createHash('sha256').update(JSON.stringify([accountId ?? '', options.sessionId])).digest('hex') : undefined
  return {
    model: options.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'],
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(options.tools?.length ? { tools: options.tools.map(tool => ({ type: 'function' as const, name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) } : {}),
    // Sign in with ChatGPT rejects max_output_tokens and temperature even though
    // ordinary API-key Responses accepts them. Pi 74f4686 omits these too.
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort as NonNullable<ResponseCreateParamsStreaming['reasoning']>['effort'], summary: 'auto' as const } } : {}),
  }
}
