import type { PluginApi } from '../shared/types.js'
import type { Translate } from './messages.js'
import { useStatus } from './use-status.js'
import { providerCss } from './styles.js'

/**
 * The compact connection card inside Settings → Models.
 *
 * The full settings page remains the control surface for accounts, search and
 * network details; this card exists so the provider directory does not show a
 * row with no way to see or start the ChatGPT sign-in it needs.
 */
export function ProviderCard({ api, t }: { api: PluginApi; t: Translate }) {
  const { status, error, busy, act } = useStatus(api, t)
  const active = status?.accounts.find(account => account.id === status.activeId)
  const pending = status?.flow.phase === 'pending' || status?.flow.phase === 'exchanging'
  return <section className="cgs-provider" aria-label={t('providerCardTitle')}>
    <style>{providerCss}</style>
    {!status ? <p role="status">{t('loading')}</p> : pending ? <div className="cgs-provider-row" aria-live="polite">
      <span>{t(status.flow.phase === 'pending' ? 'pending' : 'exchanging')}</span>
      {status.flow.url && <a className="cgs-provider-link" href={status.flow.url} target="_blank" rel="noreferrer">{t('open')} ↗</a>}
      <button type="button" disabled={busy} onClick={() => void act(api.cancel)}>{t('cancel')}</button>
    </div> : !active?.connected ? <div className="cgs-provider-row">
      <span>{t('disconnected')}</span>
      <button type="button" className="cgs-provider-primary" disabled={busy} onClick={() => void act(() => api.login(active?.id))}>{t('continue')}</button>
    </div> : !active.sharing ? <div className="cgs-provider-row">
      <span>{t('noPlan')}</span>
      <button type="button" disabled={busy} onClick={() => void act(() => api.login(active.id))}>{t('reconnect')}</button>
    </div> : <div className="cgs-provider-row">
      <span className="cgs-provider-connected">{active.email} · {t('connected')}</span>
      <button type="button" disabled={busy} onClick={() => void act(() => api.logout(active.id))}>{t('logout')}</button>
    </div>}
    {status?.notice && <p className="cgs-provider-note" role="status">{status.notice} <a className="cgs-provider-link" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">{t('openSettings')}</a></p>}
    <p className="cgs-provider-note">{t('providerCardHint')}</p>
    {(error || status?.flow.error) && <p className="cgs-provider-error" role="alert">{error || status?.flow.error}</p>}
  </section>
}
