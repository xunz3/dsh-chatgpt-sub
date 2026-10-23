import assert from 'node:assert/strict'
import test from 'node:test'
import { BlockAssembler, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ResponseStreamEvent } from 'openai/resources/responses/responses'
import { buildRequest } from '../src/adapter/request.js'
import { convertStream } from '../src/adapter/stream.js'
import { citeText } from '../src/adapter/citations.js'

const options: GenerateOptions = { provider: 'chatgpt-sub', model: 'test', messages: [{ role: 'user', content: [{ type: 'text', text: 'Search' }] }], tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }] }
const citation = { type: 'url_citation', title: 'OpenAI', url: 'https://openai.com/news/', start_index: 0, end_index: 4 }
async function* events(items: unknown[]) { for (const item of items) yield item as ResponseStreamEvent }

test('native search shares the Responses request with namespaced local tools and is absent from auxiliary calls', () => {
  const request = buildRequest(options, 'one', undefined, { searchMode: 'native' })
  assert.equal(request.tools?.[0]?.type, 'namespace')
  assert.deepEqual(request.tools?.[1], { type: 'web_search' })
  for (const purpose of ['compaction', 'session-title'] as const) {
    assert.equal(buildRequest({ ...options, purpose }, 'one', undefined, { searchMode: 'native' }).tools?.length, 1)
  }
  assert.equal(buildRequest(options).tools?.length, 2)
})

test('result details are requested only when native search is available in this call', () => {
  for (const searchMode of ['native', 'harness', 'off'] as const) {
    for (const purpose of [undefined, 'compaction', 'session-title'] as const) {
      const request = buildRequest({ ...options, purpose }, 'one', undefined, { searchMode })
      assert.deepEqual(request.include, searchMode === 'native' && purpose === undefined
        ? ['reasoning.encrypted_content', 'web_search_call.action.sources', 'web_search_call.results']
        : ['reasoning.encrypted_content'])
    }
  }
})

test('web search progress never asks Harness to execute a hosted tool; citations survive assembly and replay', async () => {
  const output = [
    { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search', query: 'OpenAI news' } },
    { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'News', annotations: [citation] }] },
  ]
  const chunks: StreamChunk[] = []
  for await (const chunk of convertStream(events([
    { type: 'response.web_search_call.in_progress', item_id: 'search' },
    { type: 'response.web_search_call.searching', item_id: 'search' },
    { type: 'response.output_text.delta', item_id: 'message', content_index: 0, delta: 'News' },
    { type: 'response.output_text.annotation.added', item_id: 'message', content_index: 0, annotation: citation },
    { type: 'response.output_item.done', output_index: 0, item: output[0] },
    { type: 'response.output_item.done', output_index: 1, item: output[1] },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]), 'one')) chunks.push(chunk)
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.equal(blocks.filter(block => block.type === 'reasoning').length, 1)
  assert.ok(blocks.some(block => block.type === 'reasoning' && block.text === 'Web search completed.\nSearch: “OpenAI news”\n'))
  assert.equal(blocks.some(block => block.type === 'tool-call'), false)
  const text = blocks.find(block => block.type === 'text')
  assert.ok(text?.type === 'text')
  assert.equal(text.text, 'News [OpenAI](<https://openai.com/news/>)')
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.deepEqual(finish.replayState?.response, { output, accountId: 'one' })
})

test('late search actions enrich one progress block after the completion event without duplicate details', async () => {
  const item = { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search', query: 'First query', queries: ['First query', 'Second query'] } }
  const chunks: StreamChunk[] = []
  for await (const chunk of convertStream(events([
    { type: 'response.web_search_call.in_progress', item_id: 'search' },
    { type: 'response.web_search_call.searching', item_id: 'search' },
    { type: 'response.web_search_call.completed', item_id: 'search' },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ]))) chunks.push(chunk)
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  assert.deepEqual(assembler.blocks(), [{ type: 'reasoning', text: 'Web search completed.\nSearch: “First query”\nSearch: “Second query”\n' }])
  assert.equal(chunks.filter(chunk => chunk.type === 'block-start').length, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'block-end').length, 1)
  assert.equal(chunks.filter(chunk => chunk.type === 'reasoning-delta' && chunk.text.includes('First query')).length, 1)
  const detailIndex = chunks.findIndex(chunk => chunk.type === 'reasoning-delta' && chunk.text.includes('First query'))
  assert.ok(chunks.findIndex(chunk => chunk.type === 'block-end') > detailIndex, 'do not close the block before late action details arrive')
})

test('multiple hosted actions display pages and find patterns, including details supplied only at completion', async () => {
  const items = [
    { type: 'web_search_call', id: 'open', status: 'completed', action: { type: 'open_page', url: 'https://example.com/docs?access_token=private#private' } },
    { type: 'web_search_call', id: 'find', status: 'completed', action: { type: 'find_in_page', pattern: 'cache retention', url: 'https://example.com/docs' } },
    { type: 'web_search_call', id: 'search', status: 'completed', action: { type: 'search', queries: ['Official documentation'] } },
  ]
  const assembler = new BlockAssembler()
  const chunks: StreamChunk[] = []
  for await (const chunk of convertStream(events([
    { type: 'response.output_item.added', output_index: 0, item: { ...items[0], status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: items[0] },
    { type: 'response.web_search_call.in_progress', item_id: 'find' },
    { type: 'response.completed', response: { status: 'completed', output: items } },
  ]), 'account')) { chunks.push(chunk); assembler.push(chunk) }
  const blocks = assembler.blocks()
  assert.equal(blocks.length, 3)
  const text = blocks.map(block => block.type === 'reasoning' ? block.text : '').join('\n')
  assert.match(text, /Open page: https:\/\/example\\\.com\/docs/)
  assert.match(text, /Find: “cache retention”\nPage:/)
  assert.match(text, /Search: “Official documentation”/)
  assert.equal(text.includes('private'), false, 'omit query strings and fragments from progress URLs')
  assert.equal(chunks.some(chunk => chunk.type === 'tool-call-delta'), false)
  const finish = chunks.at(-1)
  assert.ok(finish?.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.deepEqual(finish.replayState?.response, { output: items, accountId: 'account' }, 'presentation sanitization must not alter provider replay')
})

test('search progress bounds provider strings and rejects unsafe page URLs while retaining generic status', async () => {
  const items = [
    { type: 'web_search_call', id: 'query', status: 'completed', action: { type: 'search', queries: ['[label](javascript:alert(1))\n<img src=x>\u001b\u202e' + 'a'.repeat(2000), 'Two', 'Three', 'Four', 'Five'] } },
    { type: 'web_search_call', id: 'bad-url', status: 'completed', action: { type: 'open_page', url: 'javascript:alert(1)' } },
    { type: 'web_search_call', id: 'credentials', status: 'completed', action: { type: 'open_page', url: 'https://private:password@example.com/' } },
    { type: 'web_search_call', id: 'missing', status: 'completed', action: { type: 'search' } },
  ]
  const assembler = new BlockAssembler()
  for await (const chunk of convertStream(events([{ type: 'response.completed', response: { status: 'completed', output: items } }]))) assembler.push(chunk)
  const blocks = assembler.blocks()
  assert.equal(blocks.length, 4)
  const text = blocks.map(block => block.type === 'reasoning' ? block.text : '').join('\n')
  assert.ok(text.length < 1500)
  assert.equal(text.includes('[label]'), false)
  assert.equal(/(?<!\\)<img/.test(text), false)
  assert.equal(/[\u0000-\u0008\u001b\u202e]/.test(text), false)
  assert.equal(text.includes('password'), false)
  assert.equal(text.includes('Four'), false)
  assert.equal(text.includes('Five'), false)
  assert.equal(text.includes('Open page: javascript:'), false)
  assert.deepEqual(blocks.at(-1), { type: 'reasoning', text: 'Web search completed.\n' })
})

test('citations handle unicode, invalid offsets, duplicates and unsafe links without erasing claims', () => {
  const ref = { ...citation, title: 'A [title]', url: 'https://example.com/a_(b)', end_index: 3 }
  assert.equal(citeText('鲸🐳鱼', [ref, ref]), '鲸🐳鱼 [A \\[title\\]](<https://example.com/a_%28b%29>)')
  assert.match(citeText('News', [{ ...citation, end_index: 99 }]), /^News \[OpenAI\]/)
  assert.equal(citeText('News', [{ ...citation, url: 'javascript:alert(1)' }, { ...citation, url: 'https://user:password@example.com/' }]), 'News')
  assert.equal(citeText('Newsciteref', [{ ...citation, end_index: 999 }]), 'News [OpenAI](<https://openai.com/news/>)')
})

test('a completed cited text part remains clickable when later output is interrupted', async () => {
  const assembler = new BlockAssembler()
  await assert.rejects(async () => {
    for await (const chunk of convertStream(events([
      { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'News' },
      { type: 'response.content_part.done', item_id: 'm', content_index: 0, part: { type: 'output_text', text: 'News', annotations: [citation] } },
    ]))) assembler.push(chunk)
  }, /ended before completion/)
  assert.deepEqual(assembler.interruptedBlocks(), [{ type: 'text', text: 'News [OpenAI](<https://openai.com/news/>)' }])
})

test('continued answers keep public links without exposing unresolved provider citation markers', async () => {
  const text = 'Source: https://example.com/reference citeturn0search0'
  const assembler = new BlockAssembler()
  for await (const chunk of convertStream(events([
    { type: 'response.output_text.delta', item_id: 'answer', content_index: 0, delta: text },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ]))) assembler.push(chunk)
  assert.deepEqual(assembler.blocks(), [{ type: 'text', text: 'Source: https://example.com/reference ' }])
})
