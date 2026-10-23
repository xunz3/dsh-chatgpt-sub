/** Render bounded provider search details as escaped Markdown with validated page URLs. */
function plain(value: unknown, limit = 240): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  const shortened = text.length > limit ? `${text.slice(0, limit)}…` : text
  return shortened.replace(/[\\`*_{}\[\]()#+.!|<>-]/g, '\\$&')
}

function page(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined
    // Query strings and fragments may carry access tokens and add little to progress.
    return plain(`${url.origin}${url.pathname}`, 512)
  } catch { return undefined }
}

export function searchActionText(action: unknown): string | undefined {
  if (!action || typeof action !== 'object') return undefined
  const value = action as Record<string, unknown>
  if (value.type === 'search') {
    const candidates = [value.query, ...(Array.isArray(value.queries) ? value.queries.slice(0, 4) : [])]
    const queries = [...new Set(candidates.map(query => plain(query)).filter((query): query is string => query !== undefined))].slice(0, 3)
    return queries.length ? queries.map(query => `Search: “${query}”`).join('\n') : undefined
  }
  if (value.type === 'open_page') {
    const url = page(value.url)
    return url ? `Open page: ${url}` : 'Open a web page.'
  }
  if (value.type === 'find_in_page') {
    const pattern = plain(value.pattern)
    const url = page(value.url)
    return [pattern ? `Find: “${pattern}”` : 'Find text in a web page.', ...(url ? [`Page: ${url}`] : [])].join('\n')
  }
  return undefined
}
