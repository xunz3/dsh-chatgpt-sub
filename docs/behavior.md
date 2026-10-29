# 运行行为

## 账户与模型

设置页显示当前账户；切换、添加与退出收在 **管理** 中。**Settings → Models** 的 **ChatGPT plan** 行显示同一连接状态，并提供登录/退出快捷操作；完整选项仍在 **Settings → ChatGPT**。同一邮箱可以有多个工作区注册，选项用注册标识末六位区分。切换账户会中止旧账户请求并刷新模型目录。退出会撤销 refresh token、清除本地 token，保留邮箱、账户注册与安装 ID 供重新登录，不自动切换到其他账户；远程撤销未确认时提示去 ChatGPT 断开应用。

模型列表、上下文窗口、图像能力与 Effort 档位来自当前账户目录。支持文本、[图像](images.md)、[文件](files.md)、工具调用、搜索、usage 和加密 reasoning 历史续传。插件不估算套餐余额；设置页提供 ChatGPT 用量入口，不承诺缓存命中或缓存保留时长。

请求使用 `store: false`、`stream: true`。`response.completed` 按成功处理；因输出上限产生的 `response.incomplete`（`incomplete_details.reason = max_output_tokens`）在没有本地工具调用时，以 `finish.reason.kind = max-tokens` 结束并保留已生成内容与 replayState。若本次响应已产生本地工具调用，则报 `INTERRUPTED_STREAM`，由 Harness 处理流中断，避免将没有对应结果的调用提交为成功历史；即使某个调用参数完整，也不能直接执行，因为整个响应已被截断。内容过滤等其他 incomplete 仍报错。系统指令映射为 `developer`；省略此登录通道不支持的 `temperature` 和 `max_output_tokens`，因此宿主的 maxTokens 不作为输出上限生效。stop sequences 会明确报错。依据：[SIWC 请求限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。

缓存命中取决于模型实际接收的前缀及服务端缓存状态；诊断路径和 Harness 集成边界见[缓存行为与排查](cache.md)。

Harness 根据其 `toolHistory` 投影请求；插件只转换投影后的 `messages` 和 `tools`，不读取或重建工具历史。未标记 `deferLoading` 的声明保留在顶层 `tools`；标记延迟加载的工具按 `tool-addition.toolName` 解析，通过 developer-role `additional_tools` 放在对应事件的位置，续传时保持原位。插件声明 `toolUpdate: 'addition-only'`，不自行发现或加载其他插件；加载时机、执行和权限仍由 Harness 管理。移除工具会从初始及历史声明中排除，可能影响对应位置之后的缓存；同名定义变化按 Harness 重建的基线发送。必要历史缺失时，由 Harness 移除 developer 更新并提供当前完整声明；插件直接发送这些声明。辅助请求使用完整的投影后工具表。搜索模式同时作用于初始和新增声明。系统提示更新仍沿用原有处理，变化时可能影响早期缓存。

辅助请求的内容由 Harness 决定：当前标题生成只发送文字，压缩会保留原消息及附件。插件不擅自删除压缩所需的图像或文件，附件仍适用相同的本地请求预算。

## 搜索与历史

[搜索模式](configuration.md#搜索模式)只作用于本插件当前请求的声明。原生搜索直接使用当前模型与账户，不发独立搜索请求、不选择额外搜索模型。宿主工具仍由 Harness 执行。

原生搜索的查询、打开页面等状态显示在折叠过程区；引用转成 Markdown 链接，仅接受不带凭据的 HTTP(S) 地址。已完成段落的引用在后续流中断时仍保留。

HTTP 对话需要重发历史。原始输出保存在 replayState，保留加密 reasoning、调用 ID 和搜索状态；换账户时不回传旧账户的加密状态。另将搜索来源与摘录保存在消息内容中，供 Harness 计量和压缩：实测仅回传原始搜索项不足以在本地工具执行后恢复可读搜索结果。

续传时，摘录作为标明来源的非可信 user 内容，放在所属 assistant 及其连续工具结果之后。每次响应最多保存 32 条来源、每条 3,000 字符摘录，总计不超过 48,000 个序列化字符；截断会标记，缺少摘录不等于没有搜索结果。为复用折叠显示与计量，目前借用 reasoning 内容块；其他 provider 的压缩器可能不保留它。

## 与内置 provider 的关系

本插件实现的是 **ChatGPT plan-sharing OAuth**（与 pi-ai 的 `openai-chatgpt` 同一条 flow：动态 `dynamic_agent_client`、`resource.invoke`/`chatgpt.tokens.use.direct`、`https://api.openai.com/v1`），并用持久化的 `urn:uuid` 安装标识补上 Harness 内置 `openai` route 缺少的 installation ID。DSH 内置的 `openai-codex` 是另一条 **Codex** OAuth（固定 Codex client、不同 scopes、`chatgpt.com/backend-api`），不能与本插件的凭据互换；两者不是同一个登录入口。

## 错误处理

- 额度耗尽提示到 ChatGPT 管理用量；不推测重置时间。上下文溢出交给 Harness 压缩。
- 尚未输出时，临时限流、服务或连接故障交给 Harness 重试。已有输出后发生可重试故障或流提前结束时，返回 `INTERRUPTED_STREAM`，避免自动重新生成整段回答。当前 Harness 对非 abort 失败记录 `assistant/attempt` 诊断，不将部分响应提交为 assistant 历史；额度、内容过滤等错误保留原分类。
- 确认失效的 refresh token 会清除并要求重新登录；暂时故障保留凭据。插件不切换账户、模型或搜索方式重试。
- 诊断保留错误分类、请求阶段及校验过的代码、request ID 和 Retry-After。SDK 原始日志关闭，不输出凭据、请求正文或原始错误对象。

## 验证

`pnpm check` 覆盖类型、单元与宿主集成测试及构建；`pnpm test:browser` 检查设置面板与 Models provider 卡片；`pnpm check:package` 检查实际发布包的入口、RPC、资源和文档链接。

真实浏览器测试须指向隔离、已安装本地构建且已登录的英语 DSH Web，设置 `DSH_WEB_LOG=/path/to/web.log`，并按需开启以下变量后运行 `pnpm test:browser --workers=1`：

| 环境变量 | 验证内容 |
| --- | --- |
| `DSH_IMAGE_TEST=1` | 图片识别和历史追问 |
| `DSH_CAPABILITIES_TEST=1` | PDF 随机标记读取 |
| `DSH_SEARCH_SETTINGS_TEST=1` | 保存搜索模式后恢复原设置 |
| `DSH_NATIVE_SEARCH_TEST=1` | 搜索引用及关闭搜索后的续传 |
| `DSH_SEARCH_CHECKPOINT_TEST=1`、`DSH_SEARCH_WORKSPACE=/absolute/disposable/workspace` | 搜索后读取临时文件，再引用保留摘录 |
| `DSH_SEARCH_HISTORY_TEST=1`、`DSH_SEARCH_HISTORY_TITLE='test session title'` | 在指定的可丢弃旧会话中续传 |

可用 `DSH_SEARCH_MODEL` 指定搜索测试模型。真实推理测试消耗套餐额度并创建或更新测试会话；同一宿主应串行运行，期间避免从其他窗口切换会话。不要提交含登录链接的 Web 日志。
