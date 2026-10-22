import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import * as hostPlugin from '../src/host/index.js'
import { createApi, mountRpc } from '../src/client/rpc.js'
import { ChatGPTSubscriptionRpc, mountRpc as mountHostRpc } from '../src/host/rpc.js'
import { parseStatus, rpcContribution } from '../src/shared/rpc.js'
import type { PluginApi, Status } from '../src/shared/types.js'

const status: Status = {
  accounts: [{ id: 'account-1', email: 'human@example.com', connected: true, sharing: false }],
  activeId: 'account-1', flow: { phase: 'idle' }, proxyMode: 'inherit',
}

test('status projection excludes credential fields at every public object boundary', () => {
  const projected = parseStatus({
    ...status, refreshToken: 'secret-refresh',
    accounts: [{ ...status.accounts[0], accessToken: 'secret-access' }],
    flow: { phase: 'idle', verifier: 'secret-verifier' },
  })
  assert.deepEqual(projected, status)
  assert.equal(JSON.stringify(projected).includes('secret'), false)
  assert.throws(() => parseStatus({ ...status, proxyMode: 'unknown' }))
})

test('manual descriptors retain optional login and validate destructive operation identities', () => {
  const login = rpcContribution.descriptors.find(descriptor => descriptor.method === 'login')!
  const logout = rpcContribution.descriptors.find(descriptor => descriptor.method === 'logout')!
  assert.equal(login.parameters[0]?.acceptsUndefined, true)
  assert.equal(logout.parameters[0]?.acceptsUndefined, undefined)
  const codec = logout.parameters[0]!.codec
  assert.equal(codec.mode, 'strict')
  if (codec.mode !== 'strict') throw new Error('Expected strict codec')
  assert.equal(codec.create().parse('account-1'), 'account-1')
  assert.throws(() => codec.create().parse(''))
  assert.throws(() => codec.create().parse({ accountId: 'account-1' }))
})

test('host mounts matching strict descriptors and a visible Gateway service binding', () => {
  let registered: unknown
  class Registry extends Service {
    constructor(ctx: Context) { super(ctx, 'typert') }
    register(contribution: unknown) { registered = contribution }
  }
  const ctx = new Context()
  new Registry(ctx)
  mountHostRpc(ctx, {} as PluginApi)
  assert.deepEqual(registered, {
    package: 'dsh-chatgpt-sub', face: 'host', schemas: [],
    model: { services: [], events: [], objects: [] }, invocations: rpcContribution.descriptors,
  })
  const receiver = ctx.get('chatgptSubscription' as never) as unknown as ChatGPTSubscriptionRpc
  assert.equal(receiver.typertRemote.namespace, 'chatgptSubscription')
  assert.equal(receiver.typertRemote.serviceKey, 'chatgptSubscription')
})

test('real Cordis and Typert registry accept and dispose explicit RPC descriptors', async () => {
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  await registry
  const api = Object.fromEntries(['status', 'login', 'cancel', 'select', 'logout'].map(method => [method, async () => status])) as unknown as PluginApi
  const plugin = ctx.plugin({ name: 'subscription-rpc-integration', inject: ['typert'], apply(child: Context) { mountHostRpc(child, api) } })
  await plugin
  try {
    for (const descriptor of rpcContribution.descriptors) {
      const live = ctx.typert.local.get(`${descriptor.namespace}/${descriptor.method}`)
      assert.equal(live?.id, descriptor.id)
      assert.equal(live?.result.mode, 'strict')
    }
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('chatgptSubscription' as never) as unknown as ChatGPTSubscriptionRpc
    assert.deepEqual(await receiver.status(), status)
    const anonymous = ctx.get('chatgptSubscription' as never) as unknown as ChatGPTSubscriptionRpc
    await assert.rejects(anonymous.status(), /Only the Harness owner/)
  } finally {
    await plugin.dispose()
  }
  assert.equal(ctx.typert.local.get('chatgptSubscription/status'), undefined)
  assert.equal(ctx.get('chatgptSubscription' as never), undefined)
  await registry.dispose()
})

test('Host plugin mounts its adapter and RPC against real Cordis services and unloads cleanly', async () => {
  class MemoryCredentials extends Service {
    private record?: CredentialRecord
    constructor(ctx: Context) { super(ctx, 'credentials') }
    async readRecord() { return this.record }
    async modifyRecord(_key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      this.record = await mutate(this.record)
      return this.record
    }
  }
  const ctx = new Context()
  const registry = ctx.plugin(TypertRegistry)
  const llm = ctx.plugin(LlmRuntime)
  const credentials = ctx.plugin(MemoryCredentials)
  await Promise.all([registry, llm, credentials])
  const plugin = ctx.plugin(hostPlugin, { proxyMode: 'direct', proxyUrlEnv: 'CHATGPT_PROXY_URL', callbackPort: 0 })
  await plugin
  try {
    assert.equal(ctx.llm.listProviders().some(provider => provider.id === 'chatgpt-sub'), true)
    const owner = ctx.extend({ invocation: { peer: { principal: { kind: 'owner' } } } })
    const receiver = owner.get('chatgptSubscription' as never) as unknown as ChatGPTSubscriptionRpc
    assert.deepEqual(await receiver.status(), { accounts: [], flow: { phase: 'idle' }, proxyMode: 'direct' })
    assert.equal(ctx.typert.local.list().filter(descriptor => descriptor.namespace === 'chatgptSubscription').length, 5)
  } finally {
    await plugin.dispose()
  }
  assert.equal(ctx.llm.listProviders().some(provider => provider.id === 'chatgpt-sub'), false)
  assert.equal(ctx.typert.local.get('chatgptSubscription/status'), undefined)
  await Promise.all([credentials.dispose(), llm.dispose(), registry.dispose()])
})

test('client explicitly mounts descriptors and preserves Remote failures', async () => {
  let mounted = false
  const calls: unknown[] = []
  const remote = {
    async $mount(contribution: unknown) {
      assert.equal(contribution, rpcContribution)
      mounted = true
    },
    chatgptSubscription: {
      async status() { assert.equal(mounted, true); return { ok: true, value: status } },
      async login(id?: string) { calls.push(id); return { ok: true, value: status } },
      async logout() { return { ok: false, error: new Error('Owner required') } },
    },
  }
  await mountRpc({ remote } as unknown as Context)
  const api = createApi({ remote } as unknown as Context)
  assert.deepEqual(await api.status(), status)
  await api.login()
  await api.login('account-1')
  assert.deepEqual(calls, [undefined, 'account-1'])
  await assert.rejects(api.logout('account-1'), /Owner required/)
})

test('all subscription endpoints reject non-owner and absent RPC identities', async () => {
  let calls = 0
  const api = Object.fromEntries(['status', 'login', 'cancel', 'select', 'logout'].map(method => [method, async () => { calls++; return status }])) as unknown as PluginApi
  for (const principal of [undefined, { kind: 'guest' }, { kind: 'owner' }]) {
    const receiver = Object.assign(Object.create(ChatGPTSubscriptionRpc.prototype), {
      ctx: { invocation: principal === undefined ? undefined : { peer: { principal } } }, api,
    }) as ChatGPTSubscriptionRpc
    const operations = [() => receiver.status(), () => receiver.login(), () => receiver.cancel(), () => receiver.select('account-1'), () => receiver.logout('account-1')]
    for (const operation of operations) {
      if (principal?.kind === 'owner') assert.deepEqual(await operation(), status)
      else await assert.rejects(operation(), (error: unknown) => (error as { code?: string }).code === 'chatgpt-sub/owner-required')
    }
  }
  assert.equal(calls, 5)
})
