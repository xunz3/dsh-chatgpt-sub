import type { State, Store } from '../src/auth/store.js'

export function memoryStore(initial?: State): Store {
  let state: State = initial ?? { version: 1, hostId: 'urn:uuid:44444444-4444-4444-8444-444444444444', accounts: [] }
  let tail = Promise.resolve()
  const store: Store = {
    read: async () => structuredClone(state),
    ensure: async () => {
      const current = await store.read()
      if (current.hostId.length > 0) return current
      state = { ...state, hostId: 'urn:uuid:44444444-4444-4444-8444-444444444444' }
      return structuredClone(state)
    },
    update: mutate => {
      const work = tail.then(async () => { const next = structuredClone(state); await mutate(next); state = next; return structuredClone(state) })
      tail = work.then(() => {}, () => {})
      return work
    },
  }
  return store
}
export async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)) }
  throw new Error('Condition did not settle')
}
