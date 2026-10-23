import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { SearchMode } from '../shared/search.js'

/** Project only this request's declarations; leave the registry and history intact. */
export function searchTools(options: GenerateOptions, mode: SearchMode) {
  if (options.provider !== 'chatgpt-sub') return { tools: options.tools, native: false }
  const auxiliary = options.purpose !== undefined
  // Select directly declared search tools. Harness owns opaque transports such
  // as run_code, extension tools, their permissions and the agent's instructions.
  return {
    tools: !auxiliary && mode === 'harness' ? options.tools : options.tools?.filter(tool => tool.name !== 'web_search'),
    native: !auxiliary && mode === 'native',
  }
}
