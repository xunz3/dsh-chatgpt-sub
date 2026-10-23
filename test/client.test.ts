import assert from 'node:assert/strict'
import test from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as clientPlugin from '../src/client/index.js'
import { rpcContribution } from '../src/shared/rpc.js'

test('Client entry injects its dynamically mounted Remote namespace before registering settings', async () => {
  const ctx = new Context()
  let registered = 0
  let translated = 0
  class Namespace extends Service {
    constructor(ctx: Context) { super(ctx, 'remote.chatgptSubscription') }
  }
  class Remote extends Service {
    constructor(ctx: Context) { super(ctx, 'remote') }
    async $mount(contribution: unknown) {
      assert.equal(contribution, rpcContribution)
      await ctx.plugin(Namespace)
    }
  }
  class Slots extends Service {
    constructor(ctx: Context) { super(ctx, 'slots') }
    inject(_name: string, callback: () => unknown) { return this.ctx.effect(callback as () => () => void) }
    register(options: { id: string; label: () => string }) {
      assert.equal(options.id, 'chatgpt-sub')
      assert.equal(options.label(), 'ChatGPT')
      registered++
      return () => { registered-- }
    }
  }
  class Locale extends Service {
    constructor(ctx: Context) { super(ctx, 'locale') }
    register() { translated++; return () => { translated-- } }
    bind() { return () => 'ChatGPT' }
  }
  class ConfigForms extends Service {
    constructor(ctx: Context) { super(ctx, 'configForms') }
    get(namespace: string) {
      assert.equal(namespace, 'chatgpt-sub')
      return {}
    }
  }
  try {
    await Promise.all([ctx.plugin(Remote), ctx.plugin(Slots), ctx.plugin(Locale), ctx.plugin(ConfigForms)])
    const plugin = ctx.plugin(clientPlugin)
    await plugin.await()
    assert.equal(registered, 1)
    assert.equal(translated, 1)
    await plugin.dispose()
    assert.equal(registered, 0)
    assert.equal(translated, 0)
  } finally { await ctx.fiber.dispose() }
})
