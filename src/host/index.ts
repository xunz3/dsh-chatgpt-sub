import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess, type AdapterRegistrationHandle, type LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { Config, readSearchConfig } from './config.js'
import { resolveSearchMode } from '../shared/search.js'
import { appFetch } from '../network/fetch.js'
import { createStore } from '../auth/store.js'
import { OAuth } from '../auth/oauth.js'
import { AuthService } from '../auth/service.js'
import { ChatGPTAdapter, PROVIDER } from '../adapter/index.js'
import { mountRpc } from './rpc.js'
import { createNativeFileBridge } from './files.js'

export { Config }
export const name = 'chatgpt-sub'
export const inject = ['credentials', 'llm', 'typert']

/**
 * The provider-directory row that makes the route visible in Settings →
 * Models. The separate ChatGPT settings page remains the full control surface;
 * this entry lets the Models page show the provider, its endpoint and its
 * keyless ChatGPT sign-in posture instead of hiding it from the directory.
 */
export function providerEntry(settingsNs: string): LlmConfigurableProvider {
  return {
    provider: PROVIDER,
    displayName: 'ChatGPT plan',
    settingsNs,
    settingsPath: [],
    nativeAuth: { env: [], oauth: true },
    defaultBaseURL: 'https://api.openai.com/v1',
  }
}

export function apply(ctx: Context, config: Config) {
  let adapter: ChatGPTAdapter | undefined
  let registration: AdapterRegistrationHandle | undefined
  const auth = new AuthService(createStore(ctx.credentials), new OAuth(appFetch), config, () => {
    adapter?.clear()
    registration?.replace([PROVIDER])
  })
  ctx.effect(() => () => { auth.dispose() })
  const filePath = (ref: import('@deepseek-ai/dsh-attachment').FileAttachmentRef) => {
    const path = ctx.get('attachments')?.fileHostPath(ref)
    return path === undefined ? undefined : ctx.get('fs')?.processPathFromHostPath(path)
  }
  const files = createNativeFileBridge(PROVIDER, filePath, message => ctx.logger.warn(message))
  if (config.nativeFiles !== false) ctx.on('llm/stream', files.middleware)
  adapter = new ChatGPTAdapter(auth, appFetch, () => {
    const attachments = ctx.get('attachments')
    return {
      attachments,
      resolveAccess: ref => attachments && resolveImageAttachmentAccess(attachments,
        hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    }
  }, { imageQuality: config.imageQuality, searchMode: () => resolveSearchMode(readSearchConfig(config)), nativeFiles: config.nativeFiles,
    restoreFiles: files.restore, fileServices: () => ({ attachments: ctx.get('attachments'), resolveReadPath: filePath }),
  })
  registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  // The row id is the documented `chatgpt-sub` (the bundle patch and the
  // client configuration form address the same namespace).
  ctx.llm.registerConfigurableProviders([providerEntry(PROVIDER)])
  mountRpc(ctx, auth)
}
