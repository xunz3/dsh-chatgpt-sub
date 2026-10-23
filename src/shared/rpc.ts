/** Explicit, browser-safe Typert descriptors shared by both plugin halves. */
import type { InvocationDescriptor, TypertCodec, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { AccountView, Status } from './types.js'

export const RPC_NAMESPACE = 'chatgptSubscription'
export const RPC_PACKAGE = '@xunz/dsh-chatgpt-sub'

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected an object')
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string')
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Expected a boolean')
  return value
}

/** Validate the account identifier before it reaches any credential operation. */
export function parseAccountId(value: unknown): string {
  const id = string(value)
  if (id.length === 0 || id.length > 2048) throw new TypeError('Invalid account identifier')
  return id
}

/** Project the public status vocabulary, excluding every unlisted credential field. */
export function parseStatus(value: unknown): Status {
  const input = object(value)
  if (!Array.isArray(input.accounts)) throw new TypeError('Expected accounts')
  const accounts = input.accounts.map((entry): AccountView => {
    const account = object(entry)
    return { id: parseAccountId(account.id), email: string(account.email), connected: boolean(account.connected), sharing: boolean(account.sharing) }
  })
  const rawFlow = object(input.flow)
  const phase = rawFlow.phase
  if (phase !== 'idle' && phase !== 'pending' && phase !== 'exchanging' && phase !== 'done' && phase !== 'error') throw new TypeError('Invalid login phase')
  const proxyMode = input.proxyMode
  if (proxyMode !== 'inherit' && proxyMode !== 'direct' && proxyMode !== 'custom') throw new TypeError('Invalid proxy mode')
  const flow: Status['flow'] = { phase }
  for (const field of ['url', 'callback', 'error'] as const) {
    if (rawFlow[field] !== undefined) flow[field] = string(rawFlow[field])
  }
  return {
    accounts, flow, proxyMode,
    ...(input.activeId === undefined ? {} : { activeId: parseAccountId(input.activeId) }),
    ...(input.notice === undefined ? {} : { notice: string(input.notice) }),
  }
}

function codec<T>(name: string, parse: (value: unknown) => T): TypertCodec<T> {
  return { mode: 'strict', typeSymbol: `${RPC_PACKAGE}#${name}`, create: () => ({ parse }) }
}

const statusCodec = codec('Status', parseStatus)
const accountCodec = codec('AccountId', parseAccountId)
const optionalAccountCodec = codec('OptionalAccountId', value => value === undefined ? undefined : parseAccountId(value))

function descriptor(method: 'status' | 'login' | 'cancel' | 'select' | 'logout'): InvocationDescriptor {
  const acceptsAccount = method === 'login' || method === 'select' || method === 'logout'
  return {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/${method}`,
    service: RPC_NAMESPACE,
    namespace: RPC_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: acceptsAccount ? [{
      name: 'accountId', wire: 'accountId', source: 'json',
      codec: method === 'login' ? optionalAccountCodec : accountCodec,
      ...(method === 'login' ? { acceptsUndefined: true as const } : {}),
    }] : [],
    result: statusCodec,
  }
}

export const rpcContribution: TypertRemoteContribution = {
  package: RPC_PACKAGE,
  descriptors: ['status', 'login', 'cancel', 'select', 'logout'].map(method => descriptor(method as Parameters<typeof descriptor>[0])),
}
