# 缓存行为与排查

本插件使用服务端 prompt cache，不保存或管理模型的 KV 张量。前缀变化使下一次请求无法复用变化位置之后的缓存，并不等于客户端删除了服务端缓存。

## 统计口径

Responses 的 `input_tokens` 包含普通输入、缓存读取、缓存写入。插件在 `src/adapter/stream.ts` 映射成 Harness 的三个互斥桶：

```text
inputTokens      = input_tokens - cached_tokens - cache_write_tokens
cacheReadTokens  = cached_tokens
cacheWriteTokens = cache_write_tokens
命中率            = cacheReadTokens / (inputTokens + cacheReadTokens + cacheWriteTokens)
```

未报告的读取字段保持缺省，不在插件内伪造为零。检查过的 Harness 0.2.1-rc.3 顶部 UI 使用整个会话日志的累计 token 桶；单回合详情另行聚合该回合的请求。顶部百分比不是最近一步的命中率。新输入和缓存写入会降低读取比例，但不代表旧前缀遭到破坏。

## 插件与 Harness 的边界

| 路径 | 当前行为与缓存影响 |
| --- | --- |
| 普通工具循环 | 同账户、同模型、同工具及同配置下，追加调用和结果不会重新序列化成不同的早期内容。回归测试比较连续请求的已有 `input` 前缀、工具声明及配置。 |
| 缓存 key | `src/adapter/request.ts` 使用账户 ID 与 session ID 的稳定哈希，不随 step 或 token 刷新变化。不同会话有不同 key，不能据此期待跨会话共享缓存统计。 |
| 请求 ID | 每次随机生成的 `x-client-request-id` 是 HTTP 诊断头，不写入 prompt。 |
| 工具新增 | 插件声明 `toolUpdate: 'addition-only'`，直接转换 Harness 已投影的工具和消息：未标记 `deferLoading` 的定义保留在顶层 `tools`，新增定义按工具名映射成对应历史位置的 `additional_tools`；后续请求不把这些定义合并回顶层。新增内容仍需计算，原有前缀具备继续复用的条件。 |
| 工具移除与更新 | 仅声明当前可用且符合搜索模式的工具，移除时从初始或历史声明中排除；同名描述/schema 改动按 Harness 重建的基线发送。必要历史缺失时由 Harness 回退完整声明；辅助请求发送完整的投影后工具表。插件不重新推断 Harness 的历史规则。这些情况及搜索模式切换可能改变前缀。 |
| 系统提示变化 | 插件没有声明 `systemPromptUpdate`。Harness 会在有效系统提示变化时替换首条 system 消息；插件将其映射为 developer 消息。因此变化会影响早期前缀。 |
| 动态上下文与时间 | 检查过的 rc.3 将 runtime-context、time-context 快照追加进历史，保留之前的快照；没有证据表明它们每步重写开头。新增内容本身仍需处理。 |
| 历史压缩与裁剪 | Harness 的 compaction、工具结果裁剪、图像 offload 会改变保留的历史，从首个变化位置限制复用；这是上下文预算与缓存之间的权衡。 |
| 原始输出 | 同账户保留服务端 output，包括 encrypted reasoning 和工具 ID；换账户时回退到可见历史，不能期待相同前缀。搜索摘录插在对应历史组之后，后续普通追加不会把已有摘录移到开头。 |
| Effort 与模型 | 更换模型或请求级 reasoning effort 可能改变服务端渲染。不能把不同配置的请求当作相同前缀进行比较。 |

Harness 0.2.1-rc.3 的证据位置是 `dsh-agent-loop` 的 `SystemPromptProjection` / `buildRequest`、`dsh-llm` 的 `projectToolUpdates`、`dsh-system-prompt` 的 `orderTools`、`dsh-time-context` 的 pre-step 处理，以及 `dsh-client-ui-chat` 的 `cacheHitPercent`。宿主默认按工具名确定顺序；本次未发现无变化时随机重排工具的问题。

## GPT-6.1 Sol 的一次本地核查

2026-10-29，在实现动态工具追加适配之前，只读检查本地 rc.3 的一个 `chatgpt-sub / gpt-6.1-sol / max` 主会话及相关子会话。当时插件每次重发当前完整顶层工具表。以下为采样时已完成的 41 次主会话请求，未发送额外推理请求，也未重启宿主；这些数据不是新实现的线上效果验证：

| 主会话 step | 输入 token | 缓存读取 token | 命中率 | 请求前发生的变化 |
| --- | ---: | ---: | ---: | --- |
| 4 | 49,319 | 3,712 | 7.53% | 工具由 34 增至 52，三个已有工具定义变化；首条系统提示被替换 |
| 5 | 76,844 | 3,712 | 4.83% | 工具由 52 增至 53 |
| 7 | 94,587 | 3,712 | 3.92% | 工具由 53 增至 54；首条系统提示再次被替换 |

采样时，整个主会话按输入 token 加权的命中率为 **94.39%**，最近 10 次为 **99.16%**。这些低谷与前缀变更直接对应；工具稳定后缓存能被大量复用。样本没有 compaction 事件，effort 一直为 `max`。这支持“运行中加载工具导致阶段性失配”，不支持“每一步都破坏整个缓存”。这些数据仅描述所检查的本地会话，不代表其他任务或未来请求。

## 排查与优化顺序

1. 对比相邻请求的 usage，并同时检查 `request/header` 的工具表、系统消息替换和 compaction 事件。先区分累计比例、单次比例，以及大量新输入导致的分母增长。
2. 工具可按 Harness 的正常流程动态加载。检查新增是否落在 `additional_tools`，以及启用插件是否还修改了首条系统提示。不能为了缓存继续向模型声明已经移除的工具。
3. 当前自动测试覆盖真实 Harness 投影后的连续新增、调用与结果续传、恢复历史、移除/重新启用、同名定义重置、缺失事件、显式延迟激活、搜索模式及 SDK 请求序列化。测试确认请求前缀稳定性，不保证服务端缓存命中率。系统提示的历史更新尚未启用，需要另外验证“最新完整指令替换”的语义。
4. 若前缀稳定仍持续低命中，再检查服务端实际 `reasoning.context`、缓存边界和可用的 `prompt_cache_diagnostics`。当前插件没有保存这些诊断字段；仅从 session usage 不能确定服务端失配原因。不要先靠加长 TTL 或改 key 猜测修复。

OpenAI 官方文档说明 GPT-6.1 Sol 支持跨轮 reasoning，但应检查响应里的有效 `reasoning.context`，不能仅凭模型名称假定默认模式。当前插件保留 encrypted reasoning，省略 `reasoning.context`；本次未改变此策略。

HTTP 订阅登录通道要求 `store:false` 和完整历史，并禁止 `prompt_cache_retention`。`store:false` 本身不意味着禁用 prompt cache。通用 Responses 文档中的参数或保留策略仍需在此通道验证，不能直接假定所有 API-key 功能都适用。

参考：[Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[追加工具声明](https://developers.openai.com/api/docs/guides/tools-tool-search#add-tools-at-a-specific-point-in-the-input)、[缓存诊断](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)、[Reasoning](https://developers.openai.com/api/docs/guides/reasoning)、[ChatGPT 登录通道限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
