import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { Config } from './config.js'
import { createTransport } from '../network/transport.js'
import { createStore } from '../auth/store.js'
import { OAuth } from '../auth/oauth.js'
import { AuthService } from '../auth/service.js'
import { ChatGPTAdapter, PROVIDER } from '../adapter/index.js'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { mountRpc } from './rpc.js'

export { Config }
export const name = 'chatgpt-sub'
export const inject = ['credentials', 'llm', 'typert']
export function apply(ctx: Context, config: Config) {
  const transport = createTransport(config)
  let adapter: ChatGPTAdapter | undefined
  let registration: AdapterRegistrationHandle | undefined
  const auth = new AuthService(createStore(ctx.credentials), new OAuth(transport.fetch), config, () => {
    adapter?.clear()
    registration?.replace([PROVIDER])
  })
  ctx.effect(() => () => { auth.dispose(); void transport.close() })
  adapter = new ChatGPTAdapter(auth, transport.fetch)
  registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  mountRpc(ctx, auth)
}
