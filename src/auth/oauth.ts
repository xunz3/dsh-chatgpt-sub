import { createHash, randomBytes } from 'node:crypto'
import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose'
import type { Fetch } from '../network/transport.js'
import type { Account, Tokens } from './store.js'

export const ISSUER = 'https://auth.openai.com'
export const RESOURCE = 'https://api.openai.com/v1'
export const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
export const random = () => randomBytes(32).toString('base64url')
export class OAuthError extends Error { constructor(public code: string) { super(`ChatGPT authorization failed (${code}). Please reconnect.`) } }
export class OAuth {
  constructor(private readonly fetch: Fetch) {}
  private metadata?: { issuer: string; jwks_uri: string; revocation_endpoint?: string }
  async discovery(signal?: AbortSignal) {
    if (!this.metadata) {
      const data = await this.json(`${ISSUER}/.well-known/openid-configuration`, { signal })
      if (data.issuer !== ISSUER || typeof data.jwks_uri !== 'string') throw new Error('Invalid OpenAI discovery document.')
      for (const endpoint of [data.jwks_uri, data.revocation_endpoint].filter(Boolean)) {
        if (new URL(String(endpoint)).origin !== ISSUER) throw new Error('Unexpected OpenAI authorization endpoint.')
      }
      this.metadata = data as { issuer: string; jwks_uri: string; revocation_endpoint?: string }
    }
    return this.metadata
  }
  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.fetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    const data = await response.json() as Record<string, unknown>
    if (!response.ok) throw new OAuthError(typeof data.error === 'string' && /^[a-z_]+$/.test(data.error) ? data.error : `http_${response.status}`)
    return data
  }
  authorize(hostId: string, redirectUri: string, state: string, nonce: string, verifier: string, clientId?: string) {
    const url = new URL(`${ISSUER}/api/accounts/authorize`)
    url.search = new URLSearchParams({
      client_id: clientId ?? 'dynamic_agent_client', ext_agent_host_id: hostId,
      ...clientId ? {} : { agent_name_hint: 'DeepSeek Harness ChatGPT' },
      redirect_uri: redirectUri, response_type: 'code', scope: SCOPES, resource: RESOURCE,
      state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString()
    // Account hints deliberately omitted: no ID token or email crosses the browser RPC.
    return url.toString()
  }
  private token(params: Record<string, string>, signal?: AbortSignal) {
    return this.json(`${ISSUER}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, resource: RESOURCE }), signal })
  }
  async verify(idToken: string, clientId: string, nonce?: string, signal?: AbortSignal) {
    const metadata = await this.discovery(signal)
    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), { [customFetch]: (url, options) => this.fetch(url, {
      ...options, signal: signal ? AbortSignal.any([signal, ...(options?.signal ? [options.signal] : [])]) : options?.signal,
    }) })
    const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], algorithms: ['RS256', 'ES256'] })
    if (typeof payload.sub !== 'string' || !payload.sub || (nonce !== undefined && payload.nonce !== nonce) || (payload.azp !== undefined && payload.azp !== clientId) || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error('OpenAI identity validation failed.')
    return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : 'ChatGPT account' }
  }
  private tokens(data: Record<string, unknown>, previous?: Tokens): Tokens {
    if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || data.expires_in <= 0 || !Number.isFinite(data.expires_in) || String(data.token_type).toLowerCase() !== 'bearer') throw new Error('Invalid OpenAI token response.')
    if (!previous && (typeof data.id_token !== 'string' || !data.id_token || typeof data.scope !== 'string')) throw new Error('OpenAI token response is missing identity or granted scopes.')
    return {
      access: data.access_token, refresh: typeof data.refresh_token === 'string' ? data.refresh_token : previous?.refresh,
      idToken: typeof data.id_token === 'string' ? data.id_token : previous!.idToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/).filter(Boolean) : previous!.scopes,
    }
  }
  async exchange(code: string, clientId: string, verifier: string, redirectUri: string, nonce: string, signal: AbortSignal) {
    const data = await this.token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri }, signal)
    const tokens = this.tokens(data)
    const identity = await this.verify(tokens.idToken, clientId, nonce, signal)
    signal.throwIfAborted()
    return { tokens, ...identity }
  }
  async refresh(account: Account, signal?: AbortSignal) {
    if (!account.tokens?.refresh) throw new OAuthError('login_required')
    const data = await this.token({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: account.tokens.refresh }, signal)
    const tokens = this.tokens(data, account.tokens)
    if (data.id_token) {
      const identity = await this.verify(tokens.idToken, account.clientId, undefined, signal)
      if (identity.subject !== account.subject) throw new OAuthError('identity_changed')
    }
    return tokens
  }
  async revoke(account: Account) {
    if (!account.tokens?.refresh) return
    const { revocation_endpoint } = await this.discovery()
    if (!revocation_endpoint) throw new Error('OpenAI did not publish a revocation endpoint.')
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetch(revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.tokens.refresh, token_type_hint: 'refresh_token', client_id: account.clientId }), signal: AbortSignal.timeout(10_000) })
        if (response.status === 200) { await response.body?.cancel(); return }
        await response.body?.cancel()
        if (response.status < 500) throw new OAuthError('revocation_failed')
      } catch (error) { if (attempt || error instanceof OAuthError) throw error }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Remote revocation was not confirmed.')
  }
}
