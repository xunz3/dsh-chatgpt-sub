import assert from 'node:assert/strict'
import test from 'node:test'
import { Config, readSearchConfig, type Config as HostConfig } from '../src/host/config.js'
import { resolveSearchMode, type SearchMode } from '../src/shared/search.js'

test('configuration defaults to native, retains explicit modes and rejects invalid choices', () => {
  assert.equal(resolveSearchMode(readSearchConfig(Config({}))), 'native')
  for (const searchMode of ['native', 'harness', 'off'] as const) {
    const persisted = readSearchConfig(Config({ searchMode }))
    assert.equal(persisted.searchMode, searchMode)
    assert.equal(resolveSearchMode(persisted), searchMode)
  }
  assert.throws(() => Config(JSON.parse('{"searchMode":"automatic"}')))
  assert.equal(Config.dict?.searchMode.meta.volatile, true)
})

test('request-time configuration reads use current volatile values without replacing the config', () => {
  let selected: SearchMode | undefined
  const active = {
    callbackPort: 10101,
    imageQuality: 'balanced', nativeFiles: false,
    searchMode: { get: () => selected },
  } as HostConfig
  assert.equal(resolveSearchMode(readSearchConfig(active)), 'native')
  for (const searchMode of ['native', 'harness', 'off'] as SearchMode[]) {
    selected = searchMode
    assert.equal(resolveSearchMode(readSearchConfig(active)), searchMode)
  }
  assert.equal(active.nativeFiles, false)
  assert.equal(active.imageQuality, 'balanced')
})
