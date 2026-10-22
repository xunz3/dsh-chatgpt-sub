import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import type { Config } from '../host/config.js'

export type Fetch = typeof globalThis.fetch
export interface Transport { fetch: Fetch; close(): Promise<void> }

export function createTransport(config: Config, env: NodeJS.ProcessEnv = process.env): Transport {
  let dispatcher: Dispatcher
  if (config.proxyMode === 'direct') dispatcher = new Agent()
  else if (config.proxyMode === 'custom') {
    const value = env[config.proxyUrlEnv]
    if (!value) throw new Error(`Set ${config.proxyUrlEnv} before starting Harness.`)
    let url: URL
    try { url = new URL(value) } catch { throw new Error('The custom proxy URL is invalid.') }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Use an HTTP or HTTPS proxy URL.')
    dispatcher = new ProxyAgent(value)
  } else {
    dispatcher = new EnvHttpProxyAgent({
      httpProxy: env.http_proxy ?? env.HTTP_PROXY ?? '',
      httpsProxy: env.https_proxy ?? env.HTTPS_PROXY ?? env.http_proxy ?? env.HTTP_PROXY ?? '',
      noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
    })
  }
  return {
    fetch: ((input, init) => undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...init as Parameters<typeof undiciFetch>[1], dispatcher, redirect: 'error',
    })) as Fetch,
    close: () => dispatcher.destroy(),
  }
}
