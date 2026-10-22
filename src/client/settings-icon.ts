import { pluginLogoSvg } from './logo.js'

/**
 * DSH 0.2.1's settings shell hardcodes unknown section icons to a gear.
 * Keep this compatibility layer scoped to our localized nav row. It adds a
 * presentation attribute, never replaces React-owned children, and restores
 * the host completely on disposal. Remove when the host exposes a nav icon slot.
 */
export function mountSettingsIcon(label: () => string, doc: Document = document): () => void {
  const attribute = 'data-cgs-settings-icon'
  const selector = '[data-shortcut-modal="settings"] nav button'
  const style = doc.createElement('style')
  const url = `url("data:image/svg+xml,${encodeURIComponent(pluginLogoSvg)}")`
  style.textContent = `
    ${selector}[${attribute}] > svg { display: none; }
    ${selector}[${attribute}]::before {
      content: ''; display: block; width: 18px; height: 18px; flex: 0 0 18px;
      background: currentColor; mask: ${url} center / contain no-repeat;
      -webkit-mask: ${url} center / contain no-repeat;
    }
  `
  doc.head.append(style)
  const marked = new Set<Element>()
  const sync = () => {
    for (const node of marked) {
      if (!node.isConnected || node.textContent?.trim() !== label()) {
        node.removeAttribute(attribute)
        marked.delete(node)
      }
    }
    for (const node of doc.querySelectorAll(selector)) {
      if (node.textContent?.trim() === label()) {
        node.setAttribute(attribute, '')
        marked.add(node)
      }
    }
  }
  // Only child/text changes: our attribute writes cannot retrigger the observer.
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver
  const observer = new Observer(sync)
  observer.observe(doc.body, { childList: true, subtree: true, characterData: true })
  sync()
  return () => {
    observer.disconnect()
    for (const node of marked) node.removeAttribute(attribute)
    marked.clear()
    style.remove()
  }
}
