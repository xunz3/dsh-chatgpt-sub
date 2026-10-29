import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { credentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'

export interface Tokens {
  access: string; refresh?: string; idToken: string; expiresAt: number; scopes: string[]
}
export interface Account { id: string; clientId: string; subject: string; email: string; tokens?: Tokens }
export interface State { version: 1; hostId: string; activeId?: string; accounts: Account[]; pendingClientId?: string }
export const KEY = credentialKey('chatgpt-sub', 'accounts')
export interface Store {
  /** Read the stored state without creating a record. */
  read(): Promise<State>
  /** Persist the installation identity before a sign-in needs it. */
  ensure(): Promise<State>
  update(mutate: (state: State) => Promise<void> | void): Promise<State>
}
function parse(payload: unknown): State {
  const s = payload as State
  if (s?.version !== 1 || typeof s.hostId !== 'string' || !Array.isArray(s.accounts)) throw new Error('Invalid ChatGPT credential record. Restore a valid record before signing in.')
  return structuredClone(s)
}
const empty = (): State => ({ version: 1, hostId: '', accounts: [] })
export function createStore(credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>): Store {
  const update: Store['update'] = async (mutate) => {
    const record = await credentials.modifyRecord(KEY, async current => {
      const state = current?.kind === 'grant' ? parse(current.payload) : { version: 1 as const, hostId: `urn:uuid:${randomUUID()}`, accounts: [] }
      await mutate(state)
      // A returned record emits credentials/record-updated, even if identical.
      // Catalog reads acquire this lock to check token freshness; publishing an
      // unchanged grant would make that event trigger another catalog read.
      if (current?.kind === 'grant' && isDeepStrictEqual(current.payload, state)) return undefined
      return { kind: 'grant', payload: state }
    })
    if (record?.kind !== 'grant') throw new Error('ChatGPT credentials could not be saved.')
    return parse(record.payload)
  }
  const read: Store['read'] = async () => {
    const record = await credentials.readRecord(KEY)
    return record?.kind === 'grant' ? parse(record.payload) : empty()
  }
  return {
    update,
    read,
    ensure: async () => {
      const state = await read()
      if (state.hostId.length > 0) return state
      return update(next => { if (next.hostId.length === 0) next.hostId = `urn:uuid:${randomUUID()}` })
    },
  }
}
