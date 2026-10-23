/** Browser-safe search preferences for this provider. */
export type SearchMode = 'native' | 'harness' | 'off'

export interface SearchConfig {
  searchMode?: SearchMode
}

export function resolveSearchMode(config: SearchConfig): SearchMode {
  return config.searchMode ?? 'native'
}
