import { useState, useSyncExternalStore } from 'react'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { resolveSearchMode, type SearchConfig, type SearchMode } from '../shared/search.js'
import type { Translate } from './Panel.js'

/** Use the same revision-fenced configuration form as the native General settings. */
export function SearchSettings({ form, t }: { form: ConfigForm<SearchConfig>; t: Translate }) {
  const snapshot = useSyncExternalStore(listener => form.subscribe(listener), () => form.getSnapshot())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const ready = snapshot.status === 'ready' && snapshot.value !== undefined
  const mode = ready ? resolveSearchMode(snapshot.value!) : undefined
  const change = async (value: SearchMode) => {
    setSaving(true); setError(false)
    try {
      const accepted = await form.set('searchMode', value)
      setError(!accepted)
    } catch { setError(true) }
    finally { setSaving(false) }
  }
  const description = mode === 'harness' ? 'searchHarnessDescription'
    : mode === 'off' ? 'searchOffDescription' : 'searchNativeDescription'
  return <section className="cgs-search-section" aria-label={t('searchGroup')}>
    <div className="cgs-search-row">
      <label className="cgs-search-label" htmlFor="cgs-search-mode">
        <svg className="cgs-section-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></svg>
        {t('searchGroup')}
      </label>
      <select id="cgs-search-mode" value={mode ?? ''} disabled={!ready || !snapshot.writable || saving} aria-describedby="cgs-search-description cgs-search-scope" onChange={event => void change(event.target.value as SearchMode)}>
        {mode === undefined && <option value="">{t(snapshot.status === 'unavailable' ? 'searchUnavailable' : 'searchLoading')}</option>}
        <option value="native">{t('searchNative')}</option>
        <option value="harness">{t('searchHarness')}</option>
        <option value="off">{t('searchOff')}</option>
      </select>
    </div>
    <p id="cgs-search-description" className="cgs-note">{t(ready ? description : snapshot.status === 'unavailable' ? 'searchUnavailableDescription' : 'searchLoading')}</p>
    <p id="cgs-search-scope" className="cgs-note">{t('searchScope')}</p>
    {ready && !snapshot.writable && <p className="cgs-note">{t('searchReadOnly')}</p>}
    {error && <p className="cgs-error" role="alert">{t('searchSaveFailed')}</p>}
  </section>
}
