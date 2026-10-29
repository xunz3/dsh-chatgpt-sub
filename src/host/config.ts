import Schema from '@deepseek-ai/schemastery'
import type { Volatile } from '@deepseek-ai/cordis'
import type { ImageQuality } from '../adapter/image-policy.js'
import type { SearchConfig } from '../shared/search.js'

export interface Config {
  callbackPort: number
  imageQuality?: ImageQuality
  nativeFiles?: boolean
  searchMode?: SearchConfig['searchMode'] | Volatile<SearchConfig['searchMode']>
}

/** Volatile fields update in place; resolve them for each request, not at plugin startup. */
export function readSearchConfig(config: Config): SearchConfig {
  return {
    searchMode: typeof config.searchMode === 'object' ? config.searchMode.get() : config.searchMode,
  }
}

export const Config = Schema.object({
  callbackPort: Schema.number().min(0).max(65535).step(1).default(0).description('Loopback OAuth port; 0 chooses a free port. Set a fixed port for SSH forwarding.'),
  imageQuality: Schema.union(['auto', 'balanced', 'original']).default('auto').description('Auto enables bounded original detail when advertised by the model; balanced reduces image size.'),
  nativeFiles: Schema.boolean().default(true).description('Send supported file attachments inline to ChatGPT. Disable to retain Harness file-path descriptions.'),
  searchMode: Schema.union(['native', 'harness', 'off']).volatile().description('Direct search tools for ChatGPT requests: OpenAI (default), Harness, or off. Native search runs outside Harness tool approvals and URL rules. Other tools keep their Harness permissions.'),
})
