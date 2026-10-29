import { useEffect, useRef, useState } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginApi } from '../shared/types.js'
import type { SearchConfig } from '../shared/search.js'
import type { Translate } from './messages.js'
import { PluginLogo } from './PluginLogo.js'
import { css } from './styles.js'
import { SearchSettings } from './SearchSettings.js'
import { useStatus } from './use-status.js'

const usage = 'https://chatgpt.com/settings/usage'
export function Panel({ api, searchForm, t }: { api: PluginApi; searchForm: ConfigForm<SearchConfig>; t: Translate }) {
  const { status, error, busy, act } = useStatus(api, t)
  const [welcome, setWelcome] = useState(false)
  const accountMenu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const closeOutside = (event: Event) => {
      const menu = accountMenu.current
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('focusin', closeOutside)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('focusin', closeOutside)
    }
  }, [])
  const welcomeButton = useRef<HTMLButtonElement>(null)
  const welcomeDialog = useRef<HTMLDialogElement>(null)
  const active = status?.accounts.find(a => a.id === status.activeId)
  useEffect(() => {
    if (!active?.sharing) return
    try { if (!localStorage.getItem('dsh-chatgpt-sub:welcome')) setWelcome(true) } catch { setWelcome(true) }
  }, [active?.sharing])
  useEffect(() => { if (welcome) { welcomeDialog.current?.showModal(); welcomeButton.current?.focus() } }, [welcome])
  const dismiss = () => { try { localStorage.setItem('dsh-chatgpt-sub:welcome', '1') } catch {} setWelcome(false) }
  const pending = status?.flow.phase === 'pending' || status?.flow.phase === 'exchanging'
  return <section className="cgs" aria-label={t('title')}>
    <style>{css}</style>
    <header className="cgs-header"><h2><PluginLogo />{t('title')}</h2><p>{t('subtitle')}</p></header>
    {!status ? <p className="cgs-loading" role="status">{t('loading')}</p> : <>
      <section className="cgs-card cgs-account" aria-label={t('accountGroup')}>
        <div className="cgs-card-head"><h3><SectionIcon kind="account" />{t('accountGroup')}</h3></div>
        <div className="cgs-account-line">
          <div className="cgs-current"><b>{active?.email ?? t('disconnected')}</b>
            {active && <span className={active.connected ? 'cgs-status is-connected' : 'cgs-status'}>{active.connected ? t('connected') : t('disconnected')}</span>}
          </div>
          {status.accounts.length > 0 && <details ref={accountMenu} className="cgs-account-menu" onKeyDown={e => { if (e.key === 'Escape' && e.currentTarget.open) { e.preventDefault(); e.stopPropagation(); e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus() } }}>
            <summary>{t('manageAccounts')}<Chevron className="cgs-summary-chevron" /></summary>
            <div className="cgs-account-controls">
              <label className="cgs-label">{t('account')}
                <select value={status.activeId ?? ''} disabled={busy || pending} onChange={e => void act(() => api.select(e.target.value))}>
                  {status.accounts.map(a => <option key={a.id} value={a.id}>{a.email} · {a.id.slice(-6)}</option>)}
                </select>
              </label>
              {active && <p className="cgs-note">{t('accountId')} · {active.id.slice(-6)}</p>}
              {status.accounts.length > 1 && <p className="cgs-note">{t('switchNote')}</p>}
              <div className="cgs-actions">
                <button disabled={busy || pending} onClick={() => void act(() => api.login())}>{t('newAccount')}</button>
                {active?.connected && <button disabled={busy || pending} onClick={() => void act(() => api.logout(active.id))}>{t('logout')}</button>}
                <button disabled={busy} onClick={() => void act(api.status)}>{t('refresh')}</button>
              </div>
            </div>
          </details>}
        </div>
        {pending ? <div className="cgs-pending" aria-live="polite">
          <p>{t(status.flow.phase === 'pending' ? 'pending' : 'exchanging')}</p>
          {status.flow.url && <a className="cgs-button cgs-primary" href={status.flow.url} target="_blank" rel="noreferrer">{t('open')} ↗</a>}
          <button disabled={busy} onClick={() => void act(api.cancel)}>{t('cancel')}</button>
        </div> : !active?.connected ? <>
          <p className="cgs-note">{t('intro')}</p>
          <button className="cgs-primary" disabled={busy} onClick={() => void act(() => api.login(active?.id))}>{t('continue')}</button>
        </> : !active.sharing ? <>
          <p className="cgs-note">{t('noPlan')}</p>
          <button disabled={busy} onClick={() => void act(() => api.login(active.id))}>{t('reconnect')}</button>
        </> : null}
      </section>
      {active?.connected && active.sharing && <section className="cgs-card cgs-plan-card" aria-label={t('planGroup')}>
        <div className="cgs-card-head"><h3><SectionIcon kind="usage" />{t('planGroup')}</h3></div>
        <div className="cgs-plan"><span title={t('planUnavailable')}>{t('planAllowance')}</span><a href={usage} target="_blank" rel="noreferrer">{t('viewPlan')} ↗</a></div>
      </section>}
      {status.notice && <p className="cgs-notice" role="status">{status.notice} <a href={usage} target="_blank" rel="noreferrer">{t('openSettings')}</a></p>}
      <SearchSettings form={searchForm} t={t} />
      <details className="cgs-card cgs-network">
        <summary><SectionIcon kind="network" />{t('network')}<Chevron className="cgs-summary-chevron cgs-network-chevron" /></summary>
        <div className="cgs-network-body">
          <p>{t('proxyPolicy')}</p><p>{t('browserProxy')}</p><p>{t('remote')}</p>
          {status.flow.callback && <code>{status.flow.callback}</code>}
        </div>
      </details>
    </>}
    {(error || status?.flow.error) && <p className="cgs-error" role="alert">{error || status?.flow.error}</p>}
    {welcome && <dialog ref={welcomeDialog} className="cgs-welcome" aria-labelledby="cgs-welcome-title" onCancel={dismiss}>
      <h3 id="cgs-welcome-title">{t('firstTitle')}</h3><p>{t('firstBody')}</p>
      <a href={usage} target="_blank" rel="noreferrer">{t('manage')} ↗</a>
      <button ref={welcomeButton} className="cgs-primary" onClick={dismiss}>{t('gotIt')}</button>
    </dialog>}
  </section>
}
function Chevron({ className }: { className: string }) {
  return <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
function SectionIcon({ kind }: { kind: 'account' | 'usage' | 'network' }) {
  return <svg className="cgs-section-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'account' ? <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></> : kind === 'usage' ? <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M7 15v-3m5 3V9m5 6v-5" /></> : <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>}
  </svg>
}
