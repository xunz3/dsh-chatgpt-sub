/** Credential controls use the authenticated Harness Gateway and its caller identity. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-typert-registry'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { parseStatus, RPC_NAMESPACE, RPC_PACKAGE, rpcContribution } from '../shared/rpc.js'
import type { PluginApi, Status } from '../shared/types.js'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'chatgpt-sub/owner-required': Record<string, never>
  }
}

/** Only the Host owner may inspect or change the subscription credential state. */
export class ChatGPTSubscriptionRpc extends TypertRemoteService {
  constructor(ctx: Context, private readonly api: PluginApi) {
    super(ctx, RPC_NAMESPACE)
  }

  private owner(): void {
    if (this.ctx.invocation?.peer.principal.kind !== 'owner') {
      throw new RemoteError('chatgpt-sub/owner-required', 'Only the Harness owner can manage ChatGPT sign-in.', {})
    }
  }

  async status(): Promise<Status> { this.owner(); return parseStatus(await this.api.status()) }
  async login(accountId?: string): Promise<Status> { this.owner(); return parseStatus(await this.api.login(accountId)) }
  async cancel(): Promise<Status> { this.owner(); return parseStatus(await this.api.cancel()) }
  async select(accountId: string): Promise<Status> { this.owner(); return parseStatus(await this.api.select(accountId)) }
  async logout(accountId: string): Promise<Status> { this.owner(); return parseStatus(await this.api.logout(accountId)) }
}

/** The descriptors are explicit; no Typert generator or decorators are needed. */
export function mountRpc(ctx: Context, api: PluginApi): void {
  new ChatGPTSubscriptionRpc(ctx, api)
  ctx.typert.register({
    package: RPC_PACKAGE,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: rpcContribution.descriptors,
  })
}
