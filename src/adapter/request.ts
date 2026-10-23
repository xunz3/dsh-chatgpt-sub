import { createHash } from 'node:crypto'
import { LlmError, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ResponseInput, ResponseCreateParamsStreaming } from 'openai/resources/responses/responses'
import type { ImageContent, PreparedImages } from './images.js'
import type { FileContent, PreparedFiles } from './files.js'
import { searchTools } from './search.js'
import { searchEvidence, searchEvidenceInput } from './search-evidence.js'
import type { SearchMode } from '../shared/search.js'

export interface RequestFeatures { searchMode?: SearchMode }
export const TOOL_NAMESPACE = 'harness'

function inputContent(blocks: readonly ContentBlock[], images?: PreparedImages, files?: PreparedFiles): string | (ImageContent | FileContent)[] {
  if (!blocks.some(block => block.type === 'image' || block.type === 'file')) {
    return blocks.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }
  return blocks.flatMap((block): (ImageContent | FileContent)[] => {
    if (block.type === 'text') return [{ type: 'input_text', text: block.text }]
    if (block.type === 'file') {
      const content = files?.get(block)
      if (!content) throw new LlmError('File attachment has not been prepared.', 'UNSUPPORTED_CONTENT')
      return [...content]
    }
    if (block.type !== 'image') return []
    const content = images?.get(block)
    if (!content) throw new LlmError('Image attachment has not been prepared.', 'UNSUPPORTED_CONTENT')
    return [...content]
  })
}

export function buildRequest(options: GenerateOptions, accountId?: string, images?: PreparedImages, features: RequestFeatures = {}, files?: PreparedFiles): ResponseCreateParamsStreaming {
  if (options.stop?.length) throw new LlmError('ChatGPT Responses does not support stop sequences.', 'UNSUPPORTED_PARAMETER')
  const input: ResponseInput = []
  let pendingEvidence: string | undefined
  const flushEvidence = () => {
    if (pendingEvidence) input.push({ role: 'user', content: pendingEvidence })
    pendingEvidence = undefined
  }
  if (options.system) input.push({ role: 'developer', content: options.system })
  for (const message of options.messages) {
    // Keep the original assistant call and all of its local tool results
    // together. Source data follows that group, before the next user turn.
    if (message.role !== 'tool') flushEvidence()
    if (message.role !== 'user' && message.role !== 'tool' && message.content.some(block => block.type === 'file')) throw new LlmError('ChatGPT files require a user message or tool result.', 'UNSUPPORTED_CONTENT')
    if (message.role !== 'user' && message.role !== 'tool' && message.content.some(block => block.type === 'image')) throw new LlmError('ChatGPT images require a user message or tool result.', 'UNSUPPORTED_CONTENT')
    if (message.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: message.source.callId, output: inputContent(message.content, images, files) })
    } else if (message.role === 'assistant') {
      const replay = message.source.replayState as { response?: { output?: ResponseInput; accountId?: string } } | undefined
      if (message.source.provider === 'chatgpt-sub') {
        for (const block of message.content) {
          if (block.type === 'reasoning') pendingEvidence = searchEvidenceInput(block.text)
          if (pendingEvidence) break
        }
        if (!pendingEvidence && Array.isArray(replay?.response?.output)) {
          const evidence = searchEvidence(replay.response.output)
          if (evidence) pendingEvidence = searchEvidenceInput(evidence)
        }
        // Search metadata alone is ignored as model-visible input. Quote the
        // persisted evidence after the completed call/results, never as system
        // instructions. This also survives mode, model and account changes.
      }
      if (Array.isArray(replay?.response?.output) && replay.response.output.length > 0 && (!accountId || replay.response.accountId === accountId)) {
        input.push(...replay.response.output.map(item => {
          if (message.source.model !== options.model && item.type === 'function_call') {
            const { id: _id, ...call } = item
            return { ...call, namespace: call.namespace ?? TOOL_NAMESPACE }
          }
          if (item.type === 'function_call') return { ...item, namespace: item.namespace ?? TOOL_NAMESPACE }
          return item
        }))
        continue
      }
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text) input.push({ role: 'assistant', content: text })
      for (const block of message.content) if (block.type === 'tool-call') input.push({ type: 'function_call', namespace: TOOL_NAMESPACE, call_id: block.id, name: block.name, arguments: block.arguments })
    } else {
      const content = inputContent(message.content, images, files)
      if (content.length) input.push({ role: message.role === 'system' ? 'developer' : message.role, content })
    }
  }
  flushEvidence()
  // Keep related calls associated without exposing account or session identifiers.
  // Like Pi's public ChatGPT flow, this supplies affinity, not a cache-hit guarantee.
  const cacheKey = options.sessionId ? createHash('sha256').update(JSON.stringify([accountId ?? '', options.sessionId])).digest('hex') : undefined
  const search = searchTools(options, features.searchMode ?? 'native')
  const tools: NonNullable<ResponseCreateParamsStreaming['tools']> = []
  if (search.tools?.length) tools.push({ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed by DeepSeek Harness.', tools: search.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })) })
  if (search.native) tools.push({ type: 'web_search' })
  return {
    model: options.model, input, stream: true, store: false,
    include: ['reasoning.encrypted_content', ...(search.native ? ['web_search_call.action.sources', 'web_search_call.results'] as const : [])],
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
    ...(tools.length ? { tools } : {}),
    // Sign in with ChatGPT rejects max_output_tokens and temperature even though
    // ordinary API-key Responses accepts them. Pi 74f4686 omits these too.
    ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort as NonNullable<ResponseCreateParamsStreaming['reasoning']>['effort'], summary: 'auto' as const } } : {}),
  }
}
