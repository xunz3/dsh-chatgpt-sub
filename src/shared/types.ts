export interface AccountView { id: string; email: string; connected: boolean; sharing: boolean }
export interface Status {
  accounts: AccountView[]
  activeId?: string
  flow: { phase: 'idle' | 'pending' | 'exchanging' | 'done' | 'error'; url?: string; callback?: string; error?: string }
  notice?: string
}
export interface PluginApi {
  status(): Promise<Status>
  login(accountId?: string): Promise<Status>
  cancel(): Promise<Status>
  select(accountId: string): Promise<Status>
  logout(accountId: string): Promise<Status>
}
