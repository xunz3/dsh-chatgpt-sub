import { createHash } from 'node:crypto'
import type { Config } from '../host/config.js'
import type { PluginApi, Status } from '../shared/types.js'
import type { Store } from './store.js'
import { OAuth, OAuthError, hasPlanPermission, random, terminalRefreshError } from './oauth.js'
import { listenCallback } from './callback.js'

export class AuthService implements PluginApi {
  private flow: Status['flow'] = { phase: 'idle' }
  private attempt?: { controller: AbortController; committing: boolean; task?: Promise<void> }
  private lifetime = new AbortController()
  private requests = new AbortController()
  private notice?: string
  constructor(readonly store: Store, private oauth: OAuth, private config: Pick<Config, 'callbackPort'>, private changed: () => void = () => {}) {}
  private invalidate() { this.requests.abort(); this.requests = new AbortController(); this.changed() }
  async status(): Promise<Status> {
    const state = await this.store.read()
    return { activeId: state.activeId, flow: { ...this.flow }, notice: this.notice,
      accounts: state.accounts.map(a => ({ id: a.id, email: a.email, connected: !!a.tokens, sharing: !!a.tokens && hasPlanPermission(a.tokens) })) }
  }
  async login(accountId?: string) {
    this.lifetime.signal.throwIfAborted()
    if (this.attempt) throw new Error('A ChatGPT sign-in is already in progress.')
    const controller = new AbortController()
    const attempt = { controller, committing: false, task: undefined as Promise<void> | undefined }
    this.attempt = attempt
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal, AbortSignal.timeout(5 * 60_000)])
    let listener: Awaited<ReturnType<typeof listenCallback>> | undefined
    try {
      const state = await this.store.ensure()
      const account = accountId ? state.accounts.find(a => a.id === accountId) : undefined
      if (accountId && !account) throw new Error('Unknown ChatGPT account.')
      const clientId = account?.clientId ?? state.pendingClientId
      const nonce = random(), verifier = random(), csrf = random()
      listener = await listenCallback(csrf, clientId, signal, this.config.callbackPort)
      const callbackListener = listener
      signal.throwIfAborted()
      this.notice = undefined
      // A user-initiated reconnect may enable a previously declined grant. Do
      // not force consent for ordinary sign-in or transient inference failures.
      const consent = !!account?.tokens && !hasPlanPermission(account.tokens)
      this.flow = { phase: 'pending', url: this.oauth.authorize(state.hostId, listener.redirectUri, csrf, nonce, verifier, clientId, consent), callback: listener.redirectUri }
      attempt.task = (async () => {
        try {
          const callback = await callbackListener.result
          callbackListener.close()
          signal.throwIfAborted()
          this.flow = { phase: 'exchanging' }
          if (!account) await this.store.update(s => { signal.throwIfAborted(); s.pendingClientId = callback.clientId })
          const result = await this.oauth.exchange(callback.code, callback.clientId, verifier, callbackListener.redirectUri, nonce, signal)
          if (account && result.subject !== account.subject) throw new Error('This registration belongs to a different ChatGPT account.')
          await this.store.update(s => {
            signal.throwIfAborted()
            // Once admitted, cancellation waits for this atomic write rather than
            // reporting a cancelled login whose credentials were actually saved.
            attempt.committing = true
            const id = createHash('sha256').update(`${callback.clientId}\0${result.subject}`).digest('hex').slice(0, 24)
            s.accounts = s.accounts.filter(a => a.id !== id)
            s.accounts.push({ id, clientId: callback.clientId, subject: result.subject, email: result.email, tokens: result.tokens })
            s.activeId = id
            delete s.pendingClientId
          })
          this.invalidate()
          this.flow = { phase: 'done' }
        } catch (error) {
          if (this.attempt === attempt) {
            this.flow = controller.signal.aborted || this.lifetime.signal.aborted
              ? { phase: 'idle' }
              : { phase: 'error', error: signal.aborted ? 'Sign-in timed out. Start a new sign-in attempt.' : error instanceof OAuthError ? error.message : 'Sign-in could not be verified. Please try again and check the host proxy settings.' }
          }
        } finally { callbackListener.close(); if (this.attempt === attempt) this.attempt = undefined }
      })()
      return await this.status()
    } catch (error) {
      // Abort before closing: close removes the callback's abort listener, and
      // a failed initial status read must still settle the pending login task.
      controller.abort()
      listener?.close()
      await attempt.task
      if (this.attempt === attempt) { this.attempt = undefined; this.flow = { phase: 'idle' } }
      throw error
    }
  }
  async cancel() {
    const attempt = this.attempt
    if (attempt?.committing) { await attempt.task; return this.status() }
    attempt?.controller.abort()
    await attempt?.task
    if (this.attempt === attempt) this.attempt = undefined
    this.flow = { phase: 'idle' }
    return this.status()
  }
  async select(accountId: string) {
    await this.cancel()
    await this.store.update(s => { if (!s.accounts.some(a => a.id === accountId)) throw new Error('Unknown ChatGPT account.'); s.activeId = accountId })
    this.notice = undefined
    this.invalidate()
    return this.status()
  }
  async logout(accountId: string) {
    await this.cancel()
    this.invalidate()
    this.notice = undefined
    await this.store.update(async s => {
      const account = s.accounts.find(a => a.id === accountId)
      if (!account) throw new Error('Unknown ChatGPT account.')
      try { await this.oauth.revoke(account) } catch { this.notice = 'Signed out locally. Remote revocation was not confirmed; disconnect the app in ChatGPT Settings.' }
      delete account.tokens
    })
    this.invalidate()
    return this.status()
  }
  async access(signal?: AbortSignal) {
    const requestSignal = AbortSignal.any([this.requests.signal, this.lifetime.signal, ...(signal ? [signal] : [])])
    let access = ''
    let failure: unknown
    let invalidateGrant = false
    let lostPermission = false
    let id = ''
    await this.store.update(async s => {
      requestSignal.throwIfAborted()
      const account = s.accounts.find(a => a.id === s.activeId)
      if (!account?.tokens) throw new OAuthError('login_required')
      if (account.tokens.expiresAt < Date.now() + 60_000) {
        try {
          const tokens = await this.oauth.refresh(account, requestSignal)
          requestSignal.throwIfAborted()
          lostPermission = hasPlanPermission(account.tokens) && !hasPlanPermission(tokens)
          account.tokens = tokens
        }
        catch (error) {
          requestSignal.throwIfAborted()
          if (error instanceof OAuthError && terminalRefreshError(error)) { delete account.tokens; failure = error; invalidateGrant = true; return }
          throw error
        }
      }
      if (!hasPlanPermission(account.tokens)) {
        // Commit a rotated refresh token even when its new grant no longer
        // permits inference. Throwing inside update would roll rotation back.
        failure = new OAuthError('plan_permission_required')
        return
      }
      access = account.tokens.access; id = account.id
    })
    if (failure) {
      this.notice = invalidateGrant
        ? 'ChatGPT authorization expired or was revoked. Reconnect this account in Settings → ChatGPT.'
        : 'ChatGPT plan usage is disabled. Enable it for this account in Settings → ChatGPT.'
      if (invalidateGrant || lostPermission) this.invalidate()
      throw failure
    }
    requestSignal.throwIfAborted()
    return { token: access, accountId: id, signal: requestSignal }
  }
  dispose() { this.attempt?.controller.abort(); this.lifetime.abort(); this.requests.abort() }
}
