import type { Context } from '@deepseek-ai/cordis'
import { resolveImageAttachmentAccess, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { Config, readSearchConfig } from './config.js'
import { resolveSearchMode } from '../shared/search.js'
import { createTransport } from '../network/transport.js'
import { createStore } from '../auth/store.js'
import { OAuth } from '../auth/oauth.js'
import { AuthService } from '../auth/service.js'
import { ChatGPTAdapter, PROVIDER } from '../adapter/index.js'
import { mountRpc } from './rpc.js'
import { createNativeFileBridge } from './files.js'

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
  const filePath = (ref: import('@deepseek-ai/dsh-attachment').FileAttachmentRef) => {
    const path = ctx.get('attachments')?.fileHostPath(ref)
    return path === undefined ? undefined : ctx.get('fs')?.processPathFromHostPath(path)
  }
  const files = createNativeFileBridge(PROVIDER, filePath)
  if (config.nativeFiles !== false) ctx.on('llm/stream', files.middleware)
  adapter = new ChatGPTAdapter(auth, transport.fetch, () => {
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
  mountRpc(ctx, auth)
}
