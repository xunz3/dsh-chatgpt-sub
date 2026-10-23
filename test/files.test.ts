import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { AttachmentId, type FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, fileHandleText, LlmAdapter, LlmError, LlmRuntime, projectFilesToText, type FileBlock, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { FILE_REQUEST_BYTES, fileMediaType, prepareFiles, type FileServices } from '../src/adapter/files.js'
import { createNativeFileBridge } from '../src/host/files.js'
import { buildRequest } from '../src/adapter/request.js'

const data = Buffer.from('%PDF-1.7\nexample')
const ref: FileAttachmentRef = { attachmentId: AttachmentId(`sha256:${'1'.repeat(64)}`), name: 'example.pdf', bytes: data.length }
const file = (attachment = ref): FileBlock => ({ type: 'file', attachment })
const options = (...files: FileBlock[]): GenerateOptions => ({ provider: 'chatgpt-sub', model: 'vision-model', messages: [createUserMessage({ source: { kind: 'user' }, content: files })] })
const services: FileServices = {
  attachments: { async *readFileStream() { yield data.subarray(0, 5); yield data.subarray(5) } },
  resolveReadPath: () => '/readonly/example.pdf',
}
const projection = (input: GenerateOptions): GenerateOptions => ({ ...input, messages: [...projectFilesToText(input.messages, () => undefined)] })
const consume = async (stream: AsyncIterable<StreamChunk>) => { for await (const _chunk of stream) { /* Exhaust provider stream. */ } }

test('native files use verified inline bytes, preserve names/history, and deduplicate reads', async () => {
  const first = file()
  const second = file({ ...ref, name: 'other.PDF' })
  const input = options(first, second)
  const original = structuredClone(input)
  const [firstBlock, secondBlock] = input.messages[0]!.content as readonly FileBlock[]
  let reads = 0
  const prepared = await prepareFiles(input, { attachments: { async *readFileStream() { reads++; yield data } } }, true)
  assert.equal(reads, 1)
  assert.deepEqual(prepared.get(firstBlock!), [{ type: 'input_file', filename: 'example.pdf', file_data: `data:application/pdf;base64,${data.toString('base64')}` }])
  assert.equal((prepared.get(secondBlock!)![0] as { filename: string }).filename, 'other.PDF')
  const request = buildRequest(input, 'account', undefined, {}, prepared)
  assert.match(JSON.stringify(request.input), /input_file/)
  assert.doesNotMatch(JSON.stringify(request.input), /file_id|file_url/)
  assert.deepEqual(input, original)
  assert.equal(fileMediaType('code.ts'), 'text/plain')
  assert.equal(fileMediaType('report.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.equal(fileMediaType('archive.zip'), undefined)
})

test('unknown files and PDFs on text-only models retain file-tool handles without reading bytes', async () => {
  const pdf = file()
  const zip = file({ ...ref, name: 'archive.zip' })
  const noReads: FileServices = { ...services, attachments: { async *readFileStream() { throw new Error('Must not read') } } }
  const input = options(pdf, zip)
  const [pdfBlock, zipBlock] = input.messages[0]!.content as readonly FileBlock[]
  const prepared = await prepareFiles(input, noReads, false)
  assert.deepEqual(prepared.get(pdfBlock!), [{ type: 'input_text', text: fileHandleText(ref, '/readonly/example.pdf') }])
  assert.equal(prepared.get(zipBlock!)?.[0]?.type, 'input_text')
  const disabled = await prepareFiles(input, noReads, true, false)
  assert.equal(disabled.get(pdfBlock!)?.[0]?.type, 'input_text', 'nativeFiles=false must apply to direct typed callers too')
})

test('file bounds count repeated occurrences and verify actual bytes and duplicate metadata', async () => {
  const largeData = Buffer.alloc(FILE_REQUEST_BYTES / 2)
  const large = file({ ...ref, bytes: largeData.length })
  let reads = 0
  await assert.rejects(prepareFiles(options(large, large), { attachments: { async *readFileStream() { reads++; yield largeData } } }), (error: unknown) => error instanceof LlmError && error.failure.code === 'ATTACHMENT_TOO_LARGE')
  assert.equal(reads, 1)
  await assert.rejects(prepareFiles(options(file({ ...ref, bytes: ref.bytes - 1 })), services), /Could not verify/)
  await assert.rejects(prepareFiles(options(file(), file({ ...ref, bytes: ref.bytes - 1 })), services), /Invalid file attachment/)
  await assert.rejects(prepareFiles(options(file({ ...ref, name: '../private.pdf' })), services), /Invalid file attachment/)
  await assert.rejects(prepareFiles(options(file()), { attachments: { async *readFileStream() { yield data; throw new Error('/private/secret-path') } } }), (error: unknown) => error instanceof LlmError && !error.message.includes('secret-path'))
  await assert.rejects(prepareFiles(options(file()), { attachments: { async *readFileStream() { throw new LlmError('/private/secret-path', 'ATTACHMENT_TOO_LARGE') } } }), (error: unknown) => error instanceof LlmError && !error.message.includes('secret-path'))
})

test('file cancellation is preserved and closes an in-progress attachment reader', async () => {
  const abort = new AbortController()
  const reason = new Error('Account changed')
  let closed = false
  await assert.rejects(prepareFiles({ ...options(file()), signal: abort.signal }, { attachments: { async *readFileStream() {
    try { yield data.subarray(0, 3); abort.abort(reason); yield data.subarray(3) } finally { closed = true }
  } } }), error => error === reason)
  assert.equal(closed, true)
})

test('file bridge restores only captured references and rejects changed or forged projected content', async () => {
  const bridge = createNativeFileBridge('chatgpt-sub')
  const input = options(file())
  const projected = projection(input)
  await consume(bridge.middleware(input, async function* () {
    await Promise.resolve()
    const restored = bridge.restore(projected)
    assert.equal(restored.messages[0]!.content[0], input.messages[0]!.content[0])
    assert.equal(projected.messages[0]!.content[0]!.type, 'text', 'projection must not mutate')
    const changed = { ...projected, messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text' as const, text: fileHandleText(ref, undefined) }] })] }
    assert.equal(bridge.restore(changed), changed, 'different durable message identity must not restore')
    const fake: GenerateOptions = { ...input, messages: [{ role: 'user', content: [{ type: 'text', text: fileHandleText(ref, undefined) }] }] }
    await consume(bridge.middleware(fake, async function* () { assert.equal(bridge.restore(fake), fake) }))
    assert.equal(bridge.restore(projected).messages[0]!.content[0]!.type, 'file', 'nested scope must restore outer context')
  }))
  assert.equal(bridge.restore(projected), projected, 'scope must not leak to caller')
})

test('file bridge isolates interleaved calls and keeps iterator cleanup in its own scope', async () => {
  const bridge = createNativeFileBridge('chatgpt-sub')
  const first = options(file())
  const second = options(file({ ...ref, name: 'second.pdf' }))
  let cleaned = false
  const make = (input: GenerateOptions) => bridge.middleware(input, async function* () {
    try {
      await Promise.resolve()
      assert.equal(bridge.restore(projection(input)).messages[0]!.content[0]!.type, 'file')
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    } finally {
      assert.equal(bridge.restore(projection(input)).messages[0]!.content[0]!.type, 'file')
      cleaned = true
    }
  })[Symbol.asyncIterator]()
  const a = make(first), b = make(second)
  await Promise.all([a.next(), b.next()])
  await a.return?.()
  const failure = new Error('consumer failed')
  await assert.rejects(b.throw!(failure), error => error === failure)
  assert.equal(cleaned, true)
  const foreign = { ...first, provider: 'other-provider' }
  await consume(bridge.middleware(foreign, async function* () { const projected = projection(foreign); assert.equal(bridge.restore(projected), projected) }))
})

test('public llm/stream waterfall survives real Harness file projection and remains provider-local', async () => {
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  const runtime = ctx.plugin(LlmRuntime)
  await Promise.all([registry, runtime])
  const bridge = createNativeFileBridge('chatgpt-sub')
  const seen: GenerateOptions[] = []
  const wire: unknown[] = []
  class Adapter extends LlmAdapter {
    async *stream(input: GenerateOptions): AsyncIterable<StreamChunk> {
      const restored = bridge.restore(input)
      seen.push(restored)
      wire.push(buildRequest(restored, 'account', undefined, {}, await prepareFiles(restored, services, true)).input)
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const plugin = ctx.plugin({ name: 'file-bridge-test', inject: ['llm'], apply(child: Context) {
    child.on('llm/stream', bridge.middleware)
    child.llm.registerAdapter(['chatgpt-sub', 'other-provider'], new Adapter())
  } })
  await plugin
  try {
    const input = options(file())
    await consume(ctx.llm.stream(input))
    await consume(ctx.llm.stream({ ...input, provider: 'other-provider' }))
    assert.equal(seen[0]!.messages[0]!.content[0]!.type, 'file')
    assert.equal(seen[1]!.messages[0]!.content[0]!.type, 'text')
    assert.match(JSON.stringify(wire[0]), /input_file/)
    assert.doesNotMatch(JSON.stringify(wire[1]), /input_file/)
  } finally { await plugin.dispose(); await runtime.dispose(); await registry.dispose() }
})
