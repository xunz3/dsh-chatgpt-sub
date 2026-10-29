import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginApi, Status } from '../shared/types.js'
import type { Translate } from './messages.js'

/**
 * Shared connection state for the settings page and the Models provider card.
 *
 * The Host is the fact source: a request/response RPC is polled only while a
 * sign-in is actually pending, and refreshed on window focus otherwise. There
 * is no idle two-second poll, and a stale response from a previous connection
 * cannot overwrite the current one.
 */
export interface StatusController {
  status: Status | undefined
  error: string
  busy: boolean
  act(task: () => Promise<Status>): Promise<void>
  refresh(): Promise<void>
}

export function useStatus(api: PluginApi, t: Translate): StatusController {
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const alive = useRef(true)
  const acting = useRef(false)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const id = ++generation.current
    try {
      const value = await api.status()
      if (alive.current && id === generation.current && !acting.current) {
        setStatus(value)
        setError('')
      }
    } catch {
      if (alive.current && id === generation.current) setError(t('error'))
    }
  }, [api, t])

  useEffect(() => {
    alive.current = true
    void refresh()
    const onFocus = () => { if (!acting.current) void refresh() }
    const onVisibility = () => { if (document.visibilityState === 'visible') onFocus() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      alive.current = false
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const pending = status?.flow.phase === 'pending' || status?.flow.phase === 'exchanging'
  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const tick = async () => {
      await refresh()
      if (!cancelled) timer = setTimeout(tick, 2000)
    }
    timer = setTimeout(tick, 2000)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pending, refresh])

  const act = useCallback(async (task: () => Promise<Status>) => {
    if (acting.current) return
    acting.current = true
    generation.current++
    setBusy(true); setError('')
    try {
      const value = await task()
      if (alive.current) setStatus(value)
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t('error'))
    } finally {
      acting.current = false
      if (alive.current) setBusy(false)
    }
  }, [t])

  return { status, error, busy, act, refresh }
}
