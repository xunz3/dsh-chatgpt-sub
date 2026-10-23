import assert from 'node:assert/strict'
import test from 'node:test'
import { AttachmentId, ImageVariantId, type ImageAttachmentRef, type RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import { createAssistantMessage, createMessage, createToolResultMessage, LlmError, ToolCallId, type GenerateOptions, type ImageBlock } from '@deepseek-ai/dsh-llm'
import { imageTarget, prepareImages, type ImageServices } from '../src/adapter/images.js'
import { buildRequest } from '../src/adapter/request.js'
import { ChatGPTAdapter } from '../src/adapter/index.js'
import { AuthService } from '../src/auth/service.js'
import { OAuth, SCOPES } from '../src/auth/oauth.js'
import type { Fetch } from '../src/network/transport.js'
import { memoryStore } from './helpers.js'

const ref: ImageAttachmentRef = { attachmentId: AttachmentId('image-one'), mediaType: 'image/png', bytes: 100, width: 800, height: 600, name: 'first.png' }
const image = (attachment = ref): ImageBlock => ({ type: 'image', attachment })
const options = (content: GenerateOptions['messages'][number]['content']): GenerateOptions => ({ provider: 'chatgpt-sub', model: 'vision-model', messages: [{ role: 'user', content }] })
const version = (attachment: ImageAttachmentRef, data = new Uint8Array([1, 2, 3])): RequestImageAttachment => ({
  variantId: ImageVariantId('variant-one'), attachment, data, mediaType: 'image/webp', bytes: data.byteLength,
  width: 400, height: 300, depth: 'uchar', space: 'srgb', hasAlpha: false,
})
const services: ImageServices = {
  attachments: { async readImageRequest(ref) { return version(ref) } },
  resolveAccess: () => ({ readonlyPath: '/attachments/first.png' }),
}

test('mixed text and images retain order, verified MIME/bytes, handles and duplicate occurrences', async () => {
  let reads = 0
  const first = image()
  const second = image({ ...ref, name: 'second.png' })
  const input = options([{ type: 'text', text: 'Before' }, first, { type: 'text', text: 'Between' }, second, { type: 'text', text: 'After' }])
  const original = structuredClone(input)
  const images = await prepareImages(input, { ...services, attachments: { async readImageRequest(ref, target) {
    reads++
    assert.deepEqual(target, imageTarget(ref))
    return version(ref)
  } } })
  assert.equal(reads, 1)
  const request = buildRequest(input, 'account', images)
  assert.ok(Array.isArray(request.input))
  const message = request.input[0]!
  assert.ok('content' in message && Array.isArray(message.content))
  const content = message.content
  assert.deepEqual(content.map(block => block.type), ['input_text', 'input_text', 'input_image', 'input_text', 'input_text', 'input_image', 'input_text'])
  assert.deepEqual(content[2], { type: 'input_image', detail: 'auto', image_url: 'data:image/webp;base64,AQID' })
  assert.deepEqual(content[5], content[2])
  assert.match(JSON.stringify(content[1]), /first.png/)
  assert.match(JSON.stringify(content[1]), /400.*300/)
  assert.match(JSON.stringify(content[1]), /\/attachments\/first.png/)
  assert.match(JSON.stringify(content[4]), /second.png/)
  assert.deepEqual(input, original, 'durable history must not be mutated')
})

test('image-only input and image-bearing tool output are represented natively', async () => {
  const input = options([image()])
  input.messages.push(createToolResultMessage({ callId: ToolCallId('call-one'), isError: false, content: [image()] }))
  const request = buildRequest(input, undefined, await prepareImages(input, services))
  assert.ok(Array.isArray(request.input))
  assert.match(JSON.stringify(request.input[0]), /input_image/)
  const tool = request.input[1]!
  assert.equal(tool.type, 'function_call_output')
  if (tool.type !== 'function_call_output') throw new Error('Missing tool result')
  assert.equal(tool.call_id, 'call-one')
  assert.ok(Array.isArray(tool.output))
  assert.equal(tool.output[1]?.type, 'input_image')
})

test('offloaded images stay placeholders and never read bytes, including on history replay', async () => {
  const input = options([{ ...image(), offloaded: true }])
  const images = await prepareImages(input, { ...services, attachments: { async readImageRequest() { throw new Error('Must not read') } } })
  input.messages.push(createAssistantMessage({ content: [{ type: 'text', text: 'Earlier answer' }], source: { provider: 'chatgpt-sub', model: 'vision-model' } }))
  input.messages.push({ role: 'user', content: [{ type: 'text', text: 'Follow up' }] })
  const request = buildRequest(input, undefined, images)
  const wire = JSON.stringify(request.input)
  assert.doesNotMatch(wire, /input_image|base64/)
  assert.match(wire, /first.png/)
  assert.match(wire, /\/attachments\/first.png/)
  assert.match(wire, /Follow up/)
})

test('history replay resends retained images with encrypted reasoning and no persistent response id', async () => {
  const input = options([image()])
  input.messages.push(createAssistantMessage({ content: [{ type: 'text', text: 'Earlier answer' }], source: {
    provider: 'chatgpt-sub', model: 'vision-model', replayState: { response: { accountId: 'account', output: [{ type: 'reasoning', encrypted_content: 'opaque', summary: [] }] } },
  } }))
  input.messages.push({ role: 'user', content: [{ type: 'text', text: 'Read the image again' }] })
  const request = buildRequest(input, 'account', await prepareImages(input, services))
  assert.match(JSON.stringify(request.input), /input_image/)
  assert.match(JSON.stringify(request.input), /encrypted_content/)
  assert.equal(request.store, false)
  assert.equal(request.previous_response_id, undefined)
})

test('request projection shares the coordinate target and does not upscale small images', () => {
  assert.deepEqual(imageTarget(ref), { width: 800, height: 600, maxBytes: 1024 * 1024 })
  const target = imageTarget({ ...ref, width: 8192, height: 4096 })
  assert.ok(target.width * target.height <= 2048 * 2048)
  assert.ok(Math.abs(target.width / target.height - 2) < 0.01)
})

test('image budgets count repeated wire occurrences and actual encoded bytes', async () => {
  const input = options(Array.from({ length: 3 }, () => image()))
  let reads = 0
  await assert.rejects(prepareImages(input, { attachments: { async readImageRequest(ref) {
    reads++
    return { ...version(ref, new Uint8Array(6 * 1024 * 1024)), bytes: 1 }
  } } }), (error: unknown) => error instanceof LlmError && error.code === 'IMAGE_OFFLOAD_REQUIRED' && error.failure.offloadImages === 1)
  assert.equal(reads, 1)
})

test('missing attachment service, unreadable images and unsupported roles fail explicitly', async () => {
  await assert.rejects(prepareImages(options([image()])), /attachment service/)
  await assert.rejects(prepareImages(options([image()]), { attachments: { async readImageRequest() { throw new Error('/private/path/secret') } } }), (error: unknown) => {
    assert.ok(error instanceof LlmError)
    assert.equal(error.code, 'ATTACHMENT_READ_FAILED')
    assert.doesNotMatch(error.message, /secret|private/)
    return true
  })
  const system = createMessage({ role: 'system', source: { kind: 'system-prompt' }, content: [image()] })
  await assert.rejects(prepareImages({ ...options([]), messages: [system] }, services), /user message or tool result/)
  assert.throws(() => buildRequest(options([image()])), /not been prepared/)
})

test('cancellation during attachment preparation stops the request', async () => {
  const controller = new AbortController()
  await assert.rejects(prepareImages({ ...options([image()]), signal: controller.signal }, { attachments: { async readImageRequest(ref, _target, signal) {
    assert.equal(signal, controller.signal)
    controller.abort(new Error('Cancelled image preparation'))
    return version(ref)
  } } }), /Cancelled image preparation/)
})

function setup(catalog: Record<string, unknown>[], imageServices = services) {
  const requests: Record<string, unknown>[] = []
  const fetcher: Fetch = async (url, init) => {
    if (String(url).endsWith('/models')) return Response.json({ models: catalog.map(model => ({ visibility: 'list', ...model })) })
    requests.push(JSON.parse(String(init?.body)))
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
  }
  const store = memoryStore({ version: 1, hostId: 'urn:uuid:test', activeId: 'one', accounts: ['one', 'two'].map(id => ({ id, clientId: id, subject: id, email: `${id}@example.com`, tokens: { access: `${id}-token`, idToken: 'test', expiresAt: Date.now() + 3600000, scopes: SCOPES.split(' ') } })) })
  const auth = new AuthService(store, new OAuth(fetcher), { proxyMode: 'direct', proxyUrlEnv: '', callbackPort: 0 })
  return { auth, requests, adapter: new ChatGPTAdapter(auth, fetcher, () => imageServices) }
}

test('account catalog gates images per model; unknown capabilities do not erase them', async () => {
  let reads = 0
  const { auth, requests, adapter } = setup([
    { slug: 'vision-model', input_modalities: ['text', 'image', 'audio'] },
    { slug: 'text-model', input_modalities: ['text'] },
    { slug: 'unknown-model' },
  ], { attachments: { async readImageRequest(ref) { reads++; return version(ref) } } })
  try {
    assert.deepEqual((await adapter.resolveModel('chatgpt-sub', 'vision-model')).inputModalities, ['text', 'image'])
    assert.deepEqual((await adapter.resolveModel('chatgpt-sub', 'text-model')).inputModalities, ['text'])
    assert.equal((await adapter.resolveModel('chatgpt-sub', 'unknown-model')).inputModalities, undefined)
    for (const model of ['vision-model', 'text-model', 'unknown-model']) {
      for await (const _chunk of adapter.stream({ ...options([image()]), model })) {}
    }
    assert.equal(reads, 2)
    assert.match(JSON.stringify(requests[0]), /input_image/)
    assert.doesNotMatch(JSON.stringify(requests[1]), /input_image/)
    assert.match(JSON.stringify(requests[2]), /input_image/)
    assert.deepEqual(adapter.imageRequestTarget('chatgpt-sub', 'vision-model', ref), imageTarget(ref))
  } finally { auth.dispose() }
})

test('account switch during image loading aborts before sending a prompt', async () => {
  const { auth, requests, adapter } = setup([{ slug: 'vision-model', input_modalities: ['text', 'image'] }], { attachments: { async readImageRequest(ref, _target, signal) {
    await auth.select('two')
    assert.equal(signal?.aborted, true)
    return version(ref)
  } } })
  try {
    await assert.rejects(async () => { for await (const _chunk of adapter.stream(options([image()]))) {} })
    assert.equal(requests.length, 0)
  } finally { auth.dispose() }
})
