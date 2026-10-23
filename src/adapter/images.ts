import { requestImageDimensions, type AttachmentStore, type ImageAttachmentRef, type ImageRequestTarget, type RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, offloadedImageText, requestImageHandleText, requiredImageOffload, type GenerateOptions, type ImageAttachmentAccessResolver, type ImageBlock } from '@deepseek-ai/dsh-llm'
import type { ResponseInputImage, ResponseInputText } from 'openai/resources/responses/responses'

export type ImageContent = ResponseInputText | ResponseInputImage
export type PreparedImages = ReadonlyMap<ImageBlock, readonly ImageContent[]>
export interface ImageServices {
  attachments?: Pick<AttachmentStore, 'readImageRequest'>
  resolveAccess?: ImageAttachmentAccessResolver
}

// Match Harness's default request-image policy. These are local memory/transport
// bounds, not claims about OpenAI plan quotas or model context capacity.
const MAX_PIXELS = 2048 * 2048
const MAX_IMAGE_BYTES = 1024 * 1024
const REQUEST_BUDGET = { representation: 'base64' as const, maxBytes: 20 * 1024 * 1024, maxImages: 1500 }

/** Keep request serialization and Harness screenshot coordinate mapping aligned. */
export function imageTarget(ref: ImageAttachmentRef): ImageRequestTarget {
  return { ...requestImageDimensions(ref.width, ref.height, MAX_PIXELS), maxBytes: MAX_IMAGE_BYTES }
}

/** Read verified request variants through the host; never read arbitrary paths. */
export async function prepareImages(options: GenerateOptions, services: ImageServices = {}): Promise<PreparedImages> {
  const { signal } = options
  signal?.throwIfAborted()
  const blocks: ImageBlock[] = []
  for (const message of options.messages) {
    for (const block of message.content) {
      if (block.type !== 'image') continue
      if (message.role !== 'user' && message.role !== 'tool') {
        throw new LlmError('ChatGPT images require a user message or tool result.', 'UNSUPPORTED_CONTENT')
      }
      blocks.push(block)
    }
  }
  const variants = new Map<string, RequestImageAttachment>()
  // Read sequentially and cache only within this request to bound concurrent
  // decoding work. Repeated occurrences still count separately on the wire.
  for (const block of blocks) {
    const ref = block.attachment
    if (block.offloaded || variants.has(ref.attachmentId)) continue
    if (!services.attachments) throw new LlmError('Image input requires the Harness attachment service.', 'UNSUPPORTED_CONTENT')
    try {
      const version = await services.attachments.readImageRequest(ref, imageTarget(ref), signal)
      signal?.throwIfAborted()
      variants.set(ref.attachmentId, version)
    } catch {
      signal?.throwIfAborted()
      throw new LlmError('Could not read or prepare an image attachment. Attach it again and retry.', 'ATTACHMENT_READ_FAILED')
    }
  }
  const offloadImages = requiredImageOffload(options.messages, REQUEST_BUDGET,
    block => variants.get(block.attachment.attachmentId)!.data.byteLength)
  if (offloadImages > 0) {
    throw new LlmError('ChatGPT request images exceed the local image budget; older images must be offloaded.', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })
  }
  const prepared = new Map<ImageBlock, readonly ImageContent[]>()
  const urls = new Map<string, string>()
  for (const block of blocks) {
    signal?.throwIfAborted()
    const ref = block.attachment
    const access = services.resolveAccess?.(ref)
    if (block.offloaded) {
      prepared.set(block, [{ type: 'input_text', text: offloadedImageText(ref, access) }])
      continue
    }
    const version = variants.get(ref.attachmentId)!
    let url = urls.get(ref.attachmentId)
    if (!url) {
      url = `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`
      urls.set(ref.attachmentId, url)
    }
    prepared.set(block, [
      { type: 'input_text', text: requestImageHandleText(ref, version, access) },
      { type: 'input_image', image_url: url, detail: 'auto' },
    ])
  }
  return prepared
}
