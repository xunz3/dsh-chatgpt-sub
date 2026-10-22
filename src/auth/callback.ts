import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Callback { code: string; clientId: string }
export async function listenCallback(state: string, clientId: string | undefined, signal: AbortSignal, port = 0) {
  let resolve!: (value: Callback) => void
  let reject!: (error: Error) => void
  const result = new Promise<Callback>((a, b) => { resolve = a; reject = b })
  // Listener starts before a consumer awaits result.
  void result.catch(() => {})
  let used = false
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1') }
    catch { res.writeHead(400).end('Invalid request URL.'); return }
    if (req.method !== 'GET' || url.pathname !== '/auth/callback') { res.writeHead(404).end('Not found'); return }
    if (used || signal.aborted) { res.writeHead(410).end('This sign-in attempt has ended.'); return }
    if (url.searchParams.get('state') !== state) { res.writeHead(400).end('Invalid sign-in state.'); return }
    const issued = url.searchParams.get('client_id') ?? clientId
    const error = url.searchParams.get('error')
    if (error) { used = true; res.writeHead(400).end('Sign-in was declined. Return to Harness.'); reject(new Error('ChatGPT sign-in was declined.')); return }
    const code = url.searchParams.get('code')
    if (!code || !issued || issued === 'dynamic_agent_client' || (clientId && issued !== clientId)) {
      res.writeHead(400).end('Invalid authorization response.'); return
    }
    used = true
    res.end('Authorization received. Return to Harness to check the connection.')
    resolve({ code, clientId: issued })
  })
  const close = () => { server.close(); server.closeAllConnections() }
  const abort = () => { close(); reject(new Error('Sign-in cancelled or timed out.')) }
  signal.throwIfAborted()
  signal.addEventListener('abort', abort, { once: true })
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    signal.throwIfAborted()
  } catch (error) { signal.removeEventListener('abort', abort); close(); throw error }
  return {
    redirectUri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/callback`, result,
    close: () => { signal.removeEventListener('abort', abort); close() },
  }
}
