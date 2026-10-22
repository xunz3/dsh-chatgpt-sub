/** Mount explicit Remote descriptors on the existing authenticated connection. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { parseStatus, rpcContribution } from '../shared/rpc.js'
import type { PluginApi, Status } from '../shared/types.js'

interface RemoteApi {
  status(): Promise<RemoteResult<Status>>
  login(accountId?: string): Promise<RemoteResult<Status>>
  cancel(): Promise<RemoteResult<Status>>
  select(accountId: string): Promise<RemoteResult<Status>>
  logout(accountId: string): Promise<RemoteResult<Status>>
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap {
    chatgptSubscription: RemoteApi
  }
}

async function unwrap(pending: Promise<RemoteResult<Status>>): Promise<Status> {
  const result = await pending
  if (!result.ok) throw result.error
  return parseStatus(result.value)
}

/** Registrations are owned by the calling Client fiber and withdrawn on disposal. */
export async function mountRpc(ctx: Context): Promise<void> {
  await ctx.remote.$mount(rpcContribution)
}

/** Call inside a fiber that explicitly injects this dynamically mounted service. */
export function createApi(ctx: Context): PluginApi {
  const remote = ctx.remote.chatgptSubscription
  return {
    status: () => unwrap(remote.status()),
    login: accountId => unwrap(remote.login(accountId)),
    cancel: () => unwrap(remote.cancel()),
    select: accountId => unwrap(remote.select(accountId)),
    logout: accountId => unwrap(remote.logout(accountId)),
  }
}
