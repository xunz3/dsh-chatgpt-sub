import Schema from '@deepseek-ai/schemastery'
import type { ProxyMode } from '../shared/types.js'

export interface Config { proxyMode: ProxyMode; proxyUrlEnv: string; callbackPort: number }
export const Config: Schema<Config> = Schema.object({
  proxyMode: Schema.union(['inherit', 'direct', 'custom']).default('inherit').description('Inherit Harness launch proxy variables, connect directly, or use a custom proxy environment variable.'),
  proxyUrlEnv: Schema.string().default('CHATGPT_PROXY_URL').description('Custom HTTP(S) proxy environment variable. Credentials stay outside composition files.'),
  callbackPort: Schema.number().min(0).max(65535).step(1).default(0).description('Loopback OAuth port; 0 chooses a free port. Set a fixed port for SSH forwarding.'),
})
