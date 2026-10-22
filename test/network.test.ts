import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { createTransport } from '../src/network/transport.js'

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}
test('transport inherits HTTP_PROXY, respects NO_PROXY, and allows direct/custom without global mutation', async () => {
  const target = createServer((_req, res) => res.end('ok'))
  const proxy = createServer()
  const sockets = new Set<Duplex>()
  let tunnels = 0
  proxy.on('connect', (req, socket, head) => {
    tunnels++
    const destination = new URL(`http://${req.url}`)
    const upstream = connect(Number(destination.port), destination.hostname, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(socket); socket.pipe(upstream)
    })
    sockets.add(socket); sockets.add(upstream)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const url = await listen(target), proxyUrl = await listen(proxy)
  const config = { proxyUrlEnv: 'TEST_CHATGPT_PROXY', callbackPort: 0 }
  const transports = [
    createTransport({ ...config, proxyMode: 'inherit' }, { HTTP_PROXY: proxyUrl }),
    createTransport({ ...config, proxyMode: 'inherit' }, { http_proxy: proxyUrl, no_proxy: '127.0.0.1' }),
    createTransport({ ...config, proxyMode: 'direct' }, { HTTP_PROXY: 'http://127.0.0.1:1' }),
    createTransport({ ...config, proxyMode: 'custom' }, { TEST_CHATGPT_PROXY: proxyUrl }),
  ]
  try {
    assert.equal(await (await transports[0].fetch(url)).text(), 'ok'); assert.equal(tunnels, 1)
    assert.equal(await (await transports[1].fetch(url)).text(), 'ok'); assert.equal(tunnels, 1)
    assert.equal(await (await transports[2].fetch(url)).text(), 'ok'); assert.equal(tunnels, 1)
    assert.equal(await (await transports[3].fetch(url)).text(), 'ok'); assert.equal(tunnels, 2)
  } finally { await Promise.all(transports.map(t => t.close())); for (const socket of sockets) socket.destroy(); target.closeAllConnections(); target.close(); proxy.close() }
})
test('selected proxy failure is not retried as direct egress', async () => {
  let reached = false
  const target = createServer((_req, res) => { reached = true; res.end('unexpected') })
  const url = await listen(target)
  const transport = createTransport({ proxyMode: 'custom', proxyUrlEnv: 'TEST_CHATGPT_PROXY', callbackPort: 0 }, { TEST_CHATGPT_PROXY: 'http://127.0.0.1:1' })
  try { await assert.rejects(transport.fetch(url)); assert.equal(reached, false) }
  finally { await transport.close(); target.close() }
  assert.throws(() => createTransport({ proxyMode: 'custom', proxyUrlEnv: 'TEST_CHATGPT_PROXY', callbackPort: 0 }, { TEST_CHATGPT_PROXY: 'socks5://127.0.0.1:1080' }), /HTTP or HTTPS/)
})
