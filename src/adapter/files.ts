import { extname } from 'node:path'
import type { AttachmentStore, FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { fileHandleText, LlmError, type FileBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ResponseInputFile, ResponseInputText } from 'openai/resources/responses/responses'

export type FileContent = ResponseInputFile | ResponseInputText
export type PreparedFiles = ReadonlyMap<FileBlock, readonly FileContent[]>
export interface FileServices {
  attachments?: Pick<AttachmentStore, 'readFileStream'>
  resolveReadPath?: (ref: FileAttachmentRef) => string | undefined
}

// Local memory/transport bound (after base64 expansion), below the API's 50 MB
// combined raw-file limit. Repeated history occurrences count independently.
export const FILE_REQUEST_BYTES = 20 * 1024 * 1024
const documentTypes: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.dot': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.odt': 'application/vnd.oasis.opendocument.text', '.rtf': 'application/rtf',
  '.ppt': 'application/vnd.ms-powerpoint', '.pps': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv', '.tsv': 'text/tsv', '.md': 'text/markdown', '.markdown': 'text/markdown',
  '.json': 'application/json', '.html': 'text/html', '.htm': 'text/html', '.xml': 'text/xml',
}
const textExtensions = new Set('asm bat c cc conf cpp css cxx def dic eml h hh ics ifb in js json5 ksh list log mht mhtml mime mjs nws pl py rst s sql srt text txt vcf vtt ts tsx jsx yaml yml toml rs go java sh bash zsh diff patch tex cs scala kt swift lua r jl rb php ex exs hs clj groovy dart awk cmake ini properties proto scss sass less hcl tf graphql ndjson astro'.split(' ').map(extension => `.${extension}`))

export function fileMediaType(name: string): string | undefined {
  const extension = extname(name).toLowerCase()
  return documentTypes[extension] ?? (textExtensions.has(extension) ? 'text/plain' : undefined)
}

function fallback(block: FileBlock, services: FileServices): readonly FileContent[] {
  let path: string | undefined
  try { path = services.resolveReadPath?.(block.attachment) } catch { /* Inaccessible attachment: host's no-path handle. */ }
  return [{ type: 'input_text', text: fileHandleText(block.attachment, path) }]
}
function tooLarge(): LlmError {
  return new LlmError('File attachments exceed the local 20 MiB encoded request budget. Use smaller files or start a new conversation.', 'ATTACHMENT_TOO_LARGE')
}

/** Read only admitted attachment references, finishing integrity verification before serializing. */
export async function prepareFiles(options: GenerateOptions, services: FileServices = {}, supportsImages?: boolean, nativeFiles = true): Promise<PreparedFiles> {
  options.signal?.throwIfAborted()
  const prepared = new Map<FileBlock, readonly FileContent[]>()
  const encoded = new Map<string, { data: string; bytes: number }>()
  let requestBytes = 0
  for (const message of options.messages) for (const block of message.content) {
    if (block.type !== 'file') continue
    options.signal?.throwIfAborted()
    const ref = block.attachment
    const mediaType = fileMediaType(ref.name)
    // Retain the normal host file-tool route for unsupported files and models.
    if (!nativeFiles || message.role !== 'user' || !mediaType || (mediaType === 'application/pdf' && supportsImages === false)) {
      prepared.set(block, fallback(block, services))
      continue
    }
    if (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || !ref.name || /[\x00-\x1f\x7f/\\]/.test(ref.name) || ref.name === '.' || ref.name === '..') {
      throw new LlmError('Invalid file attachment. Attach the file again and retry.', 'ATTACHMENT_READ_FAILED')
    }
    const bytes = Math.ceil(ref.bytes / 3) * 4
    requestBytes += bytes
    if (requestBytes > FILE_REQUEST_BYTES) throw tooLarge()
    let cached = encoded.get(ref.attachmentId)
    if (cached && cached.bytes !== ref.bytes) {
      throw new LlmError('Invalid file attachment. Attach the file again and retry.', 'ATTACHMENT_READ_FAILED')
    }
    if (cached === undefined) {
      if (!services.attachments) throw new LlmError('File input requires the Harness attachment service.', 'UNSUPPORTED_CONTENT')
      const chunks: Buffer[] = []
      let length = 0
      const budgetError = tooLarge()
      try {
        for await (const chunk of services.attachments.readFileStream(ref, options.signal)) {
          options.signal?.throwIfAborted()
          length += chunk.byteLength
          if (Math.ceil(length / 3) * 4 > FILE_REQUEST_BYTES) throw budgetError
          if (length > ref.bytes) throw new Error('Attachment size mismatch')
          chunks.push(Buffer.from(chunk))
        }
        options.signal?.throwIfAborted()
        if (length !== ref.bytes) throw new Error('Attachment size mismatch')
        cached = { data: Buffer.concat(chunks, length).toString('base64'), bytes: length }
      } catch (error) {
        options.signal?.throwIfAborted()
        if (error === budgetError) throw error
        throw new LlmError('Could not verify or read a file attachment. Attach it again and retry.', 'ATTACHMENT_READ_FAILED')
      }
      encoded.set(ref.attachmentId, cached)
    }
    prepared.set(block, [{ type: 'input_file', filename: ref.name, file_data: `data:${mediaType};base64,${cached.data}` }])
  }
  return prepared
}
