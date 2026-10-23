import type { ResponseOutputText } from 'openai/resources/responses/responses'

type Citation = ResponseOutputText.URLCitation

export function urlCitation(value: unknown): Citation | undefined {
  if (!value || typeof value !== 'object') return
  const item = value as Partial<Citation>
  if (item.type !== 'url_citation' || typeof item.url !== 'string' || typeof item.title !== 'string'
    || !Number.isSafeInteger(item.start_index) || !Number.isSafeInteger(item.end_index)) return
  try {
    const url = new URL(item.url)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
    return { type: 'url_citation', url: url.href, title: item.title, start_index: item.start_index!, end_index: item.end_index! }
  } catch { return }
}

/** Render provider annotations as links without trusting URL schemes or Markdown titles. */
export function citeText(text: string, annotations: readonly unknown[]): string {
  const citations = annotations.map(urlCitation).filter((value): value is Citation => !!value)
  const chars = Array.from(text)
  const seen = new Set<string>()
  const insertions = new Map<number, string[]>()
  for (const item of citations) {
    const end = item.start_index >= 0 && item.end_index >= item.start_index && item.end_index <= chars.length ? item.end_index : chars.length
    const key = `${end}:${item.url}`
    if (seen.has(key)) continue
    seen.add(key)
    const label = (item.title || new URL(item.url).hostname).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_\[\]<>]/g, '\\$&')
    const url = item.url.replace(/[()<>"\\]/g, character => encodeURIComponent(character).replace(/\(/g, '%28').replace(/\)/g, '%29'))
    const links = insertions.get(end) ?? []
    links.push(` [${label}](<${url}>)`)
    insertions.set(end, links)
  }
  for (const [index, links] of [...insertions].sort(([a], [b]) => b - a)) chars.splice(index, 0, ...links)
  // Responses' internal citation markers are meaningful only to its own clients.
  // Links above carry their public source identity in Harness instead.
  return chars.join('').replace(/cite[^]*/g, '')
}
