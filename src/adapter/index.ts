import { randomUUID } from 'node:crypto'
import OpenAI from 'openai'
import { LlmAdapter, LlmError, ReasoningEffortId, attributionHeaders, projectImagesForTextModel, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type ModelModality } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Fetch } from '../network/transport.js'
import type { AuthService } from '../auth/service.js'
import { RESOURCE } from '../auth/oauth.js'
import { buildRequest } from './request.js'
import { convertStream } from './stream.js'
import { imageTarget, prepareImages, type ImageServices } from './images.js'
import { resolveImagePolicy, type ImageQuality } from './image-policy.js'
import { prepareFiles, type FileServices } from './files.js'
import { mapOpenAIError, responseError, type ErrorContext } from './errors.js'
import type { SearchMode } from '../shared/search.js'

export interface AdapterOptions {
  imageQuality?: ImageQuality
  searchMode?: () => SearchMode
  nativeFiles?: boolean
  fileServices?: () => FileServices
  restoreFiles?: (options: GenerateOptions) => GenerateOptions
}
type ChatGPTModel = LlmResolvedModelInfo & { supportsOriginal: boolean }

export const PROVIDER = 'chatgpt-sub'
type Session = Awaited<ReturnType<AuthService['access']>>
interface CatalogModel {
  visibility?: string
  slug?: string
  display_name?: string
  context_window?: number
  input_modalities?: string[]
  supports_image_detail_original?: boolean
  default_reasoning_level?: string
  supported_reasoning_levels?: Array<{ effort?: string; description?: string }>
}

function modelInfo(model: CatalogModel & { slug: string }): ChatGPTModel {
  const seen = new Set<string>()
  const efforts = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []).flatMap(level => {
    if (!level || typeof level.effort !== 'string' || !level.effort || seen.has(level.effort)) return []
    seen.add(level.effort)
    return [{ id: ReasoningEffortId(level.effort), name: level.effort, ...(typeof level.description === 'string' ? { description: level.description } : {}) }]
  })
  return {
    provider: PROVIDER, id: model.slug, name: model.display_name || model.slug,
    supportsOriginal: model.supports_image_detail_original === true,
    // Absent capability metadata means unknown, not text-only. Do not discard
    // images for new models merely because their catalog omits this field.
    ...(Array.isArray(model.input_modalities) ? { inputModalities: model.input_modalities.filter((value): value is ModelModality => value === 'text' || value === 'image') } : {}),
    ...(model.context_window && model.context_window > 0 ? { context: { contextWindow: model.context_window } } : {}),
    ...(efforts.length ? { reasoning: {
      efforts,
      ...(model.default_reasoning_level && seen.has(model.default_reasoning_level) ? { defaultEffort: ReasoningEffortId(model.default_reasoning_level) } : {}),
    } } : {}),
  }
}

export class ChatGPTAdapter extends LlmAdapter {
  private cached?: { accountId: string; expires: number; models: ChatGPTModel[] }
  constructor(private auth: AuthService, private fetch: Fetch, private imageServices: () => ImageServices = () => ({}), private options: AdapterOptions = {}) { super() }
  override imageRequestTarget(_provider: string, model: string, image: ImageAttachmentRef) {
    return imageTarget(image, resolveImagePolicy(this.options.imageQuality, this.cached?.models.find(entry => entry.id === model)?.supportsOriginal))
  }
  clear() { this.cached = undefined }
  override providerInfo(provider: string) { return { id: provider, name: 'ChatGPT plan' } }
  override async listModels(): Promise<LlmModelInfo[]> {
    const state = await this.auth.status()
    if (!state.accounts.some(a => a.id === state.activeId && a.connected && a.sharing)) return []
    return this.catalog()
  }
  private async catalog(signal?: AbortSignal, bound?: Session) {
    const session = bound ?? await this.auth.access(signal)
    if (this.cached?.accountId === session.accountId && this.cached.expires > Date.now()) return this.cached.models
    let response: Response
    try { response = await this.fetch(`${RESOURCE}/models`, { headers: { ...attributionHeaders(), Authorization: `Bearer ${session.token}` }, signal: AbortSignal.any([session.signal, AbortSignal.timeout(30_000)]) }) }
    catch (error) { session.signal.throwIfAborted(); throw mapOpenAIError(error, { phase: 'catalog' }) }
    if (!response.ok) {
      const error = await responseError(response, { phase: 'catalog' })
      session.signal.throwIfAborted()
      throw error
    }
    let data: { models?: CatalogModel[] }
    try { data = await response.json() as typeof data } catch {
      session.signal.throwIfAborted()
      throw new LlmError('OpenAI returned an invalid ChatGPT model catalog.', 'MODEL_DISCOVERY')
    }
    session.signal.throwIfAborted()
    if (!Array.isArray(data.models)) throw new LlmError('OpenAI returned an invalid ChatGPT model catalog.', 'MODEL_DISCOVERY')
    const models = data.models.filter((m): m is CatalogModel & { slug: string } => m?.visibility === 'list' && typeof m.slug === 'string' && m.slug.length > 0).map(modelInfo)
    session.signal.throwIfAborted()
    this.cached = { accountId: session.accountId, models, expires: Date.now() + 60_000 }
    return models
  }
  override async resolveModel(_provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const found = (await this.catalog(signal)).find(m => m.id === model)
    if (!found) throw new LlmError('This model is not available to the selected ChatGPT account. Refresh the model picker.', 'MODEL_UNAVAILABLE')
    return found
  }
  override async prepareCall(_provider: string, model: string, signal?: AbortSignal) {
    let session: Session
    try { session = await this.auth.access(signal) } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      throw mapOpenAIError(error, { phase: 'authorization' })
    }
    const found = (await this.catalog(signal, session)).find(m => m.id === model)
    if (!found) throw new LlmError('This model is not available to the selected ChatGPT account.', 'MODEL_UNAVAILABLE')
    session.signal.throwIfAborted()
    return { model: found, stream: (options: GenerateOptions) => this.streamBound(options, session, found) }
  }
  override async *stream(options: GenerateOptions) {
    const prepared = await this.prepareCall(options.provider, options.model, options.signal)
    yield* prepared.stream(options)
  }
  private async *streamBound(options: GenerateOptions, session: Session, model: ChatGPTModel) {
    const searchMode = this.options.searchMode?.() ?? 'native'
    const signal = options.signal ? AbortSignal.any([options.signal, session.signal]) : session.signal
    signal.throwIfAborted()
    let admissionError: LlmError | undefined
    let context: ErrorContext = { phase: 'preparation' }
    // SDK diagnostics may print raw SSE data or request bodies. Use only our
    // validated failure details, even when the host sets OPENAI_LOG=debug.
    const client = new OpenAI({ apiKey: session.token, baseURL: RESOURCE, fetch: async (url, init) => {
      const response = await this.fetch(url, init)
      context = { phase: 'request', status: response.status, headers: response.headers }
      if (!response.ok) admissionError = await responseError(response.clone(), { phase: 'request' })
      return response
    }, logLevel: 'off', maxRetries: 0, timeout: 10 * 60_000, defaultHeaders: attributionHeaders() })
    try {
      const effort = options.reasoningEffort ?? model.reasoning?.defaultEffort
      if (effort && !model.reasoning?.efforts.some(level => level.id === effort)) throw new LlmError('This reasoning effort is not available for the selected ChatGPT model.', 'UNSUPPORTED_REASONING_EFFORT')
      if (this.options.nativeFiles !== false) options = this.options.restoreFiles?.(options) ?? options
      const messages = model.inputModalities && !model.inputModalities.includes('image') ? projectImagesForTextModel(options.messages) : options.messages
      const projected = { ...options, messages: [...messages], reasoningEffort: effort, signal }
      const images = await prepareImages(projected, this.imageServices(), resolveImagePolicy(this.options.imageQuality, model.supportsOriginal))
      const files = await prepareFiles(projected, this.options.fileServices?.(), model.inputModalities?.includes('image'), this.options.nativeFiles !== false)
      signal.throwIfAborted()
      const request = buildRequest(projected, session.accountId, images, { searchMode }, files)
      context = { phase: 'request' }
      const { data: events, response } = await client.responses.create(request, {
        signal,
        headers: {
          'x-client-request-id': randomUUID(),
          ...(request.prompt_cache_key ? { session_id: request.prompt_cache_key } : {}),
        },
      }).withResponse()
      context = { phase: 'stream', status: response.status, headers: response.headers }
      yield* convertStream(events, session.accountId, context)
    } catch (error) {
      signal.throwIfAborted()
      throw admissionError ?? mapOpenAIError(error, context)
    }
  }
}
