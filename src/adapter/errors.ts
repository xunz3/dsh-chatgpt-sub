import OpenAI from 'openai'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, ProviderRequestId, QUOTA_EXCEEDED_CODE, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import { OAuthError, terminalRefreshError } from '../auth/oauth.js'

export type ErrorPhase = 'authorization' | 'catalog' | 'preparation' | 'request' | 'stream'
export interface ErrorContext { status?: number; headers?: Headers; requestId?: string; phase?: ErrorPhase }
type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined
/** Inspect data properties only: SDK errors and their causes can define accessors. */
function field(value: unknown, key: string): unknown {
  if (!object(value)) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}
const codeValue = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(value) ? value : undefined
const paramValue = (value: unknown) => typeof value === 'string' && /^[a-z][a-z0-9_.\[\]]{0,95}$/.test(value) ? value : undefined
const requestValue = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? ProviderRequestId(value) : undefined
const phases = new Set<ErrorPhase>(['authorization', 'catalog', 'preparation', 'request', 'stream'])
const timeoutCodes = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const networkCodes = new Set([
  ...timeoutCodes, 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_DESTROYED', 'UND_ERR_CLOSED',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
])
const errorTypes = [
  [OpenAI.APIConnectionTimeoutError, 'APIConnectionTimeoutError'], [OpenAI.APIConnectionError, 'APIConnectionError'],
  [OAuthError, 'OAuthError'], [OpenAI.APIError, 'APIError'], [TypeError, 'TypeError'], [SyntaxError, 'SyntaxError'],
  [RangeError, 'RangeError'], [ReferenceError, 'ReferenceError'], [AggregateError, 'AggregateError'], [Error, 'Error'],
] as const

/** No cause object, message, stack, URL, socket or arbitrary name survives this boundary. */
function diagnostics(error: unknown) {
  const errorType = error instanceof DOMException ? error.name === 'TimeoutError' ? 'TimeoutError' : 'DOMException'
    : errorTypes.find(([type]) => error instanceof type)?.[1]
  const seen = new Set<object>()
  const queue: unknown[] = [error]
  let networkCode: string | undefined
  // Node may wrap connection errors in AggregateError; traverse at most 16
  // objects, including nested causes, so cycles and large aggregates are bounded.
  while (queue.length && seen.size < 16) {
    const current = object(queue.shift())
    if (!current || seen.has(current)) continue
    seen.add(current)
    const code = field(current, 'code')
    if (typeof code === 'string' && networkCodes.has(code)) { networkCode = code; break }
    const cause = field(current, 'cause')
    if (object(cause)) queue.push(cause)
    const errors = current instanceof AggregateError ? field(current, 'errors') : undefined
    if (Array.isArray(errors)) queue.push(...errors.slice(0, Math.max(0, 16 - seen.size - queue.length)))
  }
  return { errorType, networkCode }
}

/** Only validated facts are retained. Provider prose and raw causes may contain prompts or credentials. */
export class ChatGPTRequestError extends LlmError {
  constructor(message: string, code: string, context: ErrorContext, provider: {
    code?: string; param?: string
  } = {}, diagnostic: ReturnType<typeof diagnostics> = { errorType: undefined, networkCode: undefined }) {
    const requestId = requestValue(context.requestId ?? context.headers?.get('x-request-id'))
    const providerRetryAfterMs = retryAfterMs(context.headers)
    const details = [
      provider.code, provider.param && `parameter ${provider.param}`,
      context.phase && phases.has(context.phase) && `phase ${context.phase}`,
      diagnostic.errorType && `type ${diagnostic.errorType}`,
      diagnostic.networkCode && networkCodes.has(diagnostic.networkCode) && `network ${diagnostic.networkCode}`,
    ].filter(Boolean).join('; ')
    super(details ? `${message} (${details})` : message, code, {
      ...(Number.isInteger(context.status) && context.status! >= 100 && context.status! <= 599 ? { status: context.status } : {}),
      ...(requestId ? { requestId } : {}),
      ...(providerRetryAfterMs ? { providerRetryAfterMs } : {}),
    })
  }
}

export function retryAfterMs(headers?: Headers, now = Date.now()): number | undefined {
  if (!headers) return undefined
  const milliseconds = headers.get('retry-after-ms')
  const seconds = headers.get('retry-after')
  let delay: number | undefined
  if (milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds.trim())) delay = Number(milliseconds)
  else if (seconds && /^\d+(?:\.\d+)?$/.test(seconds.trim())) delay = Number(seconds) * 1000
  else if (seconds) delay = Date.parse(seconds) - now
  return delay !== undefined && Number.isFinite(delay) && delay > 0 && delay <= 2_147_483_647 ? Math.ceil(delay) : undefined
}

/** Shared classification for pre-stream HTTP errors, SDK exceptions and in-band SSE errors. */
export function mapOpenAIError(error: unknown, context: ErrorContext = {}): LlmError {
  if (error instanceof LlmError) return error
  const outer = object(error)
  const inner = object(field(outer, 'error'))
  const payload = inner ?? outer
  const providerPayload = !!inner || !(error instanceof Error) || error instanceof OAuthError
    || error instanceof OpenAI.APIError && !(error instanceof OpenAI.APIConnectionError)
  const code = providerPayload ? codeValue(field(payload, 'code')) : undefined
  const param = providerPayload ? paramValue(field(payload, 'param')) : undefined
  const outerStatus = field(outer, 'status')
  const status = context.status ?? (typeof outerStatus === 'number' ? outerStatus : undefined)
  const outerHeaders = field(outer, 'headers')
  const outerRequestId = field(outer, 'requestID')
  const facts = { ...context, status, headers: context.headers ?? (outerHeaders instanceof Headers ? outerHeaders : undefined), requestId: context.requestId ?? (typeof outerRequestId === 'string' ? outerRequestId : undefined) }
  const diagnostic = diagnostics(error)
  const fail = (message: string, kind: string) => new ChatGPTRequestError(message, kind, facts, { code, param }, diagnostic)
  if (error instanceof OAuthError) {
    if (error.code === 'invalid_client') return fail('The saved OpenAI client registration is invalid. Check the integration configuration.', 'CONFIGURATION')
    if (error.code === 'plan_permission_required') return fail('Enable ChatGPT plan usage for this account in Settings → ChatGPT.', 'PERMISSION')
    if (terminalRefreshError(error)) return fail('ChatGPT authorization has expired or was revoked. Reconnect this account in Settings → ChatGPT.', 'AUTH')
    if (!status) return fail('Could not refresh ChatGPT authorization. Please try again.', 'AUTH')
  }
  // Structured subscription errors take precedence over their HTTP status.
  if (code === 'subscription_sharing_usage_limit_exceeded') return fail('ChatGPT plan usage for this app has reached a limit. Check https://chatgpt.com/settings/usage before continuing.', QUOTA_EXCEEDED_CODE)
  if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable') return fail('ChatGPT plan availability could not be checked. Please retry later.', 'SERVER')
  if (code === 'subscription_sharing_user_not_eligible') return fail('ChatGPT plan usage is unavailable for this account, workspace or policy. Check the selected account and its access.', 'PERMISSION')
  if (code === 'subscription_sharing_unsupported_capability') return fail('ChatGPT does not support a requested capability. Adjust the indicated input, tool, model or service tier before retrying.', 'UNSUPPORTED_CONTENT')
  if (code === 'subscription_sharing_route_not_supported') return fail('This OpenAI route is unavailable for ChatGPT plan usage. Check the integration endpoint.', 'CONFIGURATION')
  if (code === 'chatpass_v2_scope_not_authorized' || code === 'chatpass_v2_invalid_authorization_context') return fail('The OpenAI client or permission grant does not authorize this request. Check the integration and account permissions.', 'PERMISSION')
  if (code === 'subscription_sharing_invalid_user') return fail('OpenAI could not validate the selected ChatGPT account. Check account permissions; reconnect after confirmed expiration or revocation.', 'AUTH')
  const detail = providerPayload ? [code, field(payload, 'type'), field(payload, 'message')].filter(value => typeof value === 'string').join(' ') : ''
  if (isContextWindowExceededError(detail)) return fail('This request exceeds the model context window. Compact the conversation before retrying.', CONTEXT_WINDOW_EXCEEDED_CODE)
  if (isQuotaExceededError(detail)) return fail('The selected account has reached a usage limit. Check https://chatgpt.com/settings/usage before continuing.', QUOTA_EXCEEDED_CODE)
  if (code === 'max_output_tokens') return fail('The response reached its output limit before completion.', 'OUTPUT_LIMIT')
  if (code === 'content_filter') return fail('The response was stopped by a content filter.', 'CONTENT_FILTER')
  if (status === 401 || code === 'invalid_api_key' || code === 'authentication_error') return fail('OpenAI did not accept the selected ChatGPT identity or permission. Check the account and granted scopes.', 'AUTH')
  if (status === 403 || code === 'permission_denied') return fail('OpenAI blocked this request because of an account, region or policy restriction.', 'PERMISSION')
  if (status === 429 || code === 'rate_limit_exceeded') return fail('OpenAI is temporarily limiting requests. Please retry after the requested delay.', 'RATE_LIMIT')
  if (status === 408 || error instanceof OpenAI.APIConnectionTimeoutError || diagnostic.errorType === 'TimeoutError' || diagnostic.networkCode && timeoutCodes.has(diagnostic.networkCode)) return fail('The OpenAI request timed out. Please retry.', 'TIMEOUT')
  if (status && status >= 500 || code === 'server_error' || code === 'internal_error') return fail('OpenAI is temporarily unavailable. Please retry later.', 'SERVER')
  if (status === 404 || code === 'model_not_found') return fail('The selected model or endpoint is unavailable. Refresh the model picker and check the integration.', 'MODEL_UNAVAILABLE')
  if (status === 400 || status === 422 || code === 'invalid_request_error') return fail('OpenAI rejected this request. Check its input and supported model capabilities.', 'INVALID_REQUEST')
  if (status && status >= 400 || code) return fail('OpenAI could not complete this request. Check the diagnostic code before retrying.', 'API_ERROR')
  if (error instanceof OpenAI.APIConnectionError || diagnostic.networkCode) return fail('The connection to OpenAI failed. Check the connection and host proxy settings.', 'TRANSPORT')
  return fail('The ChatGPT integration encountered an unexpected error. Check its diagnostic details before retrying.', 'INTERNAL')
}

/** Catalog/admission errors may use {detail} or non-JSON bodies instead of {error}. */
export async function responseError(response: Response, context: Pick<ErrorContext, 'phase'> = {}): Promise<LlmError> {
  let body: unknown
  try { body = await response.json() } catch { /* Preserve the HTTP facts even for HTML or malformed responses. */ }
  return mapOpenAIError(body, { ...context, status: response.status, headers: response.headers })
}
