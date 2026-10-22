# ChatGPT subscription for DeepSeek Harness

在 DeepSeek Harness 中使用 ChatGPT 订阅账户的 GPT 系列模型。

本项目使用 OpenAI 面向开源和本地应用的 **Sign in with ChatGPT**：动态 OAuth 注册、浏览器授权和公开 Responses API。登录时由用户选择账户、工作区并授权订阅使用；账户是否符合条件以及模型可用性以 OpenAI 实际返回为准。

## 安装

需要 **Node.js 22.12+**、**pnpm 11.13.1**。当前构建和宿主接口针对 **DeepSeek Harness 0.2.1-rc.2**；DSH 的 `latest` npm 标签目前比 `next` 旧，勿用 `@latest` 替换锁定的 peer 版本。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack

# 安装到你实际使用的 profile；下面以 web 为例。
dsh plugin --profile web add /absolute/path/dsh-chatgpt-sub/dsh-chatgpt-sub-0.1.0.tgz
```

也可以在构建后安装本地目录：

```sh
dsh plugin --profile web add file:/absolute/path/dsh-chatgpt-sub
```

重启相应的 Harness profile，进入 **Settings → ChatGPT**，点击 **Continue with ChatGPT**，然后打开登录链接。授权成功后，在 Harness 的模型选择器中选择 **ChatGPT plan** 下的模型。模型来自当前账户的 `/v1/models`，不会硬编码 GPT 型号或把本地目录当作权限证明。

同一邮箱可以有多个工作区注册；账户选项显示邮箱和稳定注册标识的末六位。账户切换会中止旧账户的请求并刷新模型目录。退出会撤销 refresh token 并清除本地 token，保留注册与安装 ID 供下次登录使用。远程撤销未确认时，面板会提示去 ChatGPT 设置断开应用。

设置页直接显示当前账户；切换、添加与退出收在 **管理** 中。模型菜单中的 **Effort** 使用当前账户模型目录提供的档位和默认值；不同模型的可选档位可能不同。

## 用量与缓存

每次模型响应的 token、缓存读写与推理用量会传给 Harness，在会话中查看；设置页不单独累计本次运行的临时统计。

**套餐用量与剩余** 单独链接到 ChatGPT 官方用量页。目前 SIWC 文档未提供可读取套餐余额的公开端点；Codex 的额度 RPC 依赖另一套账户认证，不能直接用于此动态 OAuth。插件不以本地 token 估算套餐剩余百分比，也不把 API 吞吐限流当作套餐余额。

OAuth 请求使用获授权的 ChatGPT plan 或可用点数；它不会获得独立于账户的额外额度。普通 API 的美元单价不能用于推算订阅剩余用量。

插件保留服务端默认缓存策略，并转发实际的 `cached_tokens` 和 `cache_write_tokens`。参考 Pi 的新 ChatGPT 流程，用账户和会话标识的哈希关联 `prompt_cache_key` / `session_id`，每次请求独立生成 `x-client-request-id`。这不保证缓存命中；GPT-5.6 及之后的模型不依赖 key 优化缓存。命中需要匹配的上下文前缀及边界；首个请求、修改前缀或切换模型/推理档位都可能影响命中。`store: false` 并不表示关闭 prompt caching。

2026-10-21 的 [Codex / Work 公告](https://x.com/thsottiaux/status/2112712984644784534)承诺登录用户恢复旧会话时享有永久缓存；公告未明确说明第三方 Sign in with ChatGPT 客户端是否适用，因此本插件不保证同等缓存待遇，也不把普通 API 的 30 分钟 / 12 小时缓存时长当作订阅产品的规则。

## 代理

默认 `proxyMode: inherit`：读取 **Harness 进程启动时** 的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，也支持小写变量（小写优先）。HTTPS 未单独配置时回退到 HTTP_PROXY。认证、OpenID/JWKS、刷新、撤销、模型目录和 SSE 推理共用一个插件局部 HTTP transport。

```sh
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
dsh --profile web
```

自定义 composition patch：

```yaml
- id: chatgpt-sub
  config:
    proxyMode: custom
    proxyUrlEnv: CHATGPT_PROXY_URL
    callbackPort: 0
```

用 `CHATGPT_PROXY_URL=http://127.0.0.1:7890` 启动 Harness；如代理需要账号密码，把完整 URL 放进这个环境变量，不写入设置或版本库。`proxyMode: direct` 强制直连。配置由 Cordis 加载，修改后重载插件或重启 profile。

- 不覆盖宿主全局 dispatcher，不修改其他模型插件配置。
- 选中的代理失败时不会退回直连。
- 支持 HTTP/HTTPS 代理；不读取系统 PAC、浏览器代理或 `ALL_PROXY`，也不直接支持 SOCKS。SOCKS 用户可使用代理软件提供的 HTTP 端口。
- 登录网页使用**浏览器自己的网络设置**，与 Host transport 分开。
- 不关闭 TLS 验证。需要企业 CA 时，使用 Node 支持的信任配置启动 Harness。

## 远程 Harness

OAuth 回调只监听 `127.0.0.1`，默认选择空闲端口，路径固定为 `/auth/callback`。远程主机的 loopback 与本地浏览器不是同一台机器。

在远程插件配置中设定固定端口，例如 `callbackPort: 1455`，然后从运行浏览器的电脑转发：

```sh
ssh -N -L 1455:127.0.0.1:1455 user@harness-host
```

保持转发运行，再在 Harness 中开始登录。不要把回调监听地址改成 `0.0.0.0`。不支持转发的远程环境暂不提供 device-code 或复制裸授权码的替代入口。

## UI 与权限

使用 Harness 的 `settings.section`、locale 和 `--dsw-*` 主题变量，复用宿主 React。参考 General 页，以图标标题、横向设置行和细分隔区分账户、套餐与用量、网络。账户管理菜单点击外部、焦点移出或按 Escape 时关闭；网络说明按需展开，首次连接显示订阅使用说明。

标志是张嘴吞下 ChatGPT 绳结的黑色 Harness 鲸鱼，源 SVG 与来源见 [assets](assets/README.md)。标题与设置左侧导航随主题使用黑色或浅色前景，独立 SVG 为黑色。DSH 0.2.1 尚无导航图标字段，因此插件用局部兼容层只标记自己的导航项并替换图标样式；卸载后恢复齿轮，宿主 DOM 改变时可退回默认图标，不修改宿主安装文件。

## 项目结构

```text
src/
  host/       Cordis 入口、配置、受保护 RPC
  auth/       PKCE/OIDC、loopback 回调、账户与凭据生命周期
  network/    插件局部代理 transport
  adapter/    模型目录、Responses 请求、流与工具历史转换
  client/     设置页、独立样式、双语文案、图标与 RPC 调用
  shared/     前后端协议和严格校验
scripts/      Host ESM 与 Client ModuleLoader 构建
test/         协议、取消、代理、Host 集成和浏览器测试
dist/         生成的可安装产物
cordis.patch.yml
```
## 验证与范围

```sh
pnpm check                     # TypeScript、Node 回归测试、构建
pnpm exec playwright install chromium
pnpm test:browser              # 浅色桌面 / 深色手机 / 账户交互

# 已安装插件、完成首次启动提示的隔离 DSH Web 实例（英语界面、未登录）
# 日志由 dsh web --host 127.0.0.1 --port 17777 --no-open 重定向生成
DSH_WEB_LOG=/path/to/isolated-web.log pnpm exec playwright test dsh-web

# 只读检查 Models 页稳定性；已登录账户可覆盖凭据刷新反馈循环
DSH_WEB_LOG=/path/to/isolated-web.log pnpm exec playwright test dsh-models
```

Node 测试使用模拟 OAuth/JWKS 和本机 loopback 服务，无需真实账户。覆盖签名/issuer/audience/expiry/nonce、回调 state/client ID、取消与写入竞争、轮换刷新、撤销、代理/NO_PROXY、RPC 脱敏与权限、真实 Cordis 挂载/卸载、工具调用和不完整 SSE。取消在凭据写入开始前有效；若原子写入已开始，会等待写入并返回真实登录结果。

浏览器测试覆盖设置面板、账户操作、菜单关闭、主题与响应式布局；Host 和 Client 集成测试使用真实 Cordis runtime，验证 Remote 服务的注入与卸载。`dsh-web` 仅在指定 `DSH_WEB_LOG` 时运行，会开始并取消登录，请使用独立 `DSH_HOME` 的未登录实例；`dsh-models` 只读检查模型目录及页面请求稳定性。

当前 adapter 支持文本、工具调用、工具结果、usage 和加密 reasoning 历史续传。图像/文件由 Harness 按文本模型规则投影；不声称支持原生图像输入。Responses 请求强制 `store: false`、`stream: true`；只有 `response.completed` 算成功。系统指令映射为 `developer`，省略此登录通道不支持的 `temperature` 与 `max_output_tokens`（因此宿主的 maxTokens 不作为输出上限生效）。stop sequences 会明确报错；context window 和 reasoning effort 列表来自账户模型目录。

## 依据

- [Harness：插件打包与安装](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)
- [Harness：LLM adapter](https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/llm-adapter)
- [OpenAI：注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [OpenAI：账户与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [OpenAI：模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [OpenAI：预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Pi：新 ChatGPT Responses 实现（核对版本）](https://github.com/earendil-works/pi/blob/74f46864025c68504cd10c89eeb626b7e3d64cea/packages/ai/src/api/openai-responses.ts)
- [OpenAI：UI 指南](https://developers.openai.com/siwc/ui-ux-guidelines)
- [OpenAI：Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI：Codex / Work 用量](https://learn.chatgpt.com/docs/pricing)

协议、用量文档和宿主接口核对日期：2026-10-23。
