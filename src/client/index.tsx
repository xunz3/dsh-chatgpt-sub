import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createApi, mountRpc } from './rpc.js'
import { Panel, type Translate } from './Panel.js'
import { en, zh, type CopyKey } from './messages.js'
import { mountSettingsIcon } from './settings-icon.js'
import type { SearchConfig } from '../shared/search.js'

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'chatgpt-sub': CopyKey } }
export const inject = ['slots', 'locale', 'remote', 'configForms']
export async function apply(ctx: Context) {
  await mountRpc(ctx)
  ctx.inject(['remote.chatgptSubscription'], ctx => {
    const api = createApi(ctx)
    const searchForm = ctx.configForms.get<SearchConfig>('chatgpt-sub')
    ctx.effect(() => ctx.locale.register('chatgpt-sub', { en, zh }))
    const t = ctx.locale.bind('chatgpt-sub') as Translate
    if (typeof document !== 'undefined') ctx.effect(() => mountSettingsIcon(ctx.slots))
    const SettingsPanel = () => <Panel api={api} searchForm={searchForm} t={t} />
    ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'chatgpt-sub', locale: 'chatgpt-sub', order: 25, label: () => t('title') }, SettingsPanel))
  })
}
