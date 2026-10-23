import { AsyncLocalStorage } from 'node:async_hooks'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fileHandleText, type FileBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'

type FileReadPath = (ref: FileAttachmentRef) => string | undefined
type UserMessage = Extract<GenerateOptions['messages'][number], { role: 'user' }>
interface CapturedMessage {
  message: UserMessage
  files: ReadonlyMap<number, { block: FileBlock; text: string }>
}
interface FileScope {
  provider: string
  sessionId: GenerateOptions['sessionId']
  users: readonly CapturedMessage[]
}

/**
 * DSH 0.2.1 projects durable files to text after its public llm/stream waterfall.
 * Carry only typed user attachments through that boundary in this plugin's
 * async scope. No request mutation, global patch, or parsing paths from text.
 */
export function createNativeFileBridge(provider: string, resolveReadPath: FileReadPath = () => undefined) {
  const storage = new AsyncLocalStorage<FileScope | undefined>()
  function capture(options: GenerateOptions): FileScope | undefined {
    if (options.provider !== provider) return undefined
    return {
      provider: options.provider,
      sessionId: options.sessionId,
      users: options.messages.filter((message): message is UserMessage => message.role === 'user').map(message => {
        const files = new Map<number, { block: FileBlock; text: string }>()
        message.content.forEach((block, index) => {
          if (block.type !== 'file') return
          let path: string | undefined
          try { path = resolveReadPath(block.attachment) } catch { /* Match the host's inaccessible-file projection. */ }
          files.set(index, { block, text: fileHandleText(block.attachment, path) })
        })
        return { message, files }
      }),
    }
  }
  return {
    middleware(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
      const scope = capture(options)
      return {
        [Symbol.asyncIterator]() {
          const iterator = storage.run(scope, () => next()[Symbol.asyncIterator]())
          return {
            next: () => storage.run(scope, () => iterator.next()),
            return: async () => storage.run(scope, () => iterator.return?.() ?? Promise.resolve({ done: true as const, value: undefined })),
            throw: async (error: unknown) => storage.run(scope, async () => {
              if (iterator.throw) return iterator.throw(error)
              await iterator.return?.()
              throw error
            }),
          }
        },
      }
    },
    restore(options: GenerateOptions): GenerateOptions {
      const scope = storage.getStore()
      if (!scope || scope.provider !== options.provider || scope.sessionId !== options.sessionId) return options
      let userIndex = 0
      let changed = false
      const messages = options.messages.map(message => {
        if (message.role !== 'user') return message
        const captured = scope.users[userIndex++]
        // User order survives Harness tool-update projection. Also check identity
        // where available, content shape, and every untouched block by identity.
        if (!captured?.files.size || captured.message.id !== message.id || captured.message.content.length !== message.content.length) return message
        if (message.content.some((block, index) => {
          const file = captured.files.get(index)
          return file ? block !== file.block && (block.type !== 'text' || block.text !== file.text)
            : block !== captured.message.content[index]
        })) return message
        const content = message.content.map((block, index) => captured.files.get(index)?.block ?? block)
        if (content.every((block, index) => block === message.content[index])) return message
        changed = true
        return { ...message, content }
      })
      return changed ? { ...options, messages } : options
    },
  }
}
