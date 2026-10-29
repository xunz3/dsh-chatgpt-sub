import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Tool } from 'openai/resources/responses/responses'

export const TOOL_NAMESPACE = 'harness'

export function toolNamespace(tools: readonly ToolSchema[]): Tool {
  return {
    type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools executed by DeepSeek Harness.',
    tools: tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
  }
}
