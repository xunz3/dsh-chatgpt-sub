import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { pluginLogoSvg } from './logo.js'

/**
 * DSH 0.2.1 has no section icon option or DOM section id. Its settings nav
 * renders every registry entry sorted by order, with no visibility filtering.
 * Follow that registry rather than observing or rewriting the host DOM. The
 * row-count guard falls back to host icons if the nav structure diverges.
 */
export function mountSettingsIcon(slots: Pick<SlotCore, 'entries' | 'subscribe'>, doc: Document = document): () => void {
  const style = doc.createElement('style')
  const url = `url("data:image/svg+xml,${encodeURIComponent(pluginLogoSvg)}")`
  const sync = () => {
    const entries = [...slots.entries('settings.section')].sort((a, b) => (a.options.order ?? 0) - (b.options.order ?? 0))
    const index = entries.findIndex(entry => entry.options.id === 'chatgpt-sub')
    const row = `[data-shortcut-modal="settings"] > nav > div:last-child:has(> button:nth-child(${entries.length}):last-child) > button:nth-child(${index + 1})`
    style.textContent = index < 0 ? '' : `
      ${row} > svg { display: none; }
      ${row}::before {
        content: ''; display: block; width: 18px; height: 18px; flex: 0 0 18px;
        background: currentColor; mask: ${url} center / contain no-repeat;
        -webkit-mask: ${url} center / contain no-repeat;
      }
    `
  }
  const unsubscribe = slots.subscribe('settings.section', sync)
  sync()
  doc.head.append(style)
  return () => { unsubscribe(); style.remove() }
}
