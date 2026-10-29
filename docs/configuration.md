# 配置

## 搜索模式

在 **Settings → ChatGPT → 网页搜索** 中选择；保存后从下一次请求生效，不打断在途响应，不改变其他 provider。使用 Harness 原生配置服务保存，只修改当前插件的 `searchMode`。

| 模式 | 当前行为 |
| --- | --- |
| `native`（未配置时的默认选择） | 在当前 ChatGPT 请求中提供 OpenAI 原生搜索，由 GPT 按需调用；移除 Harness 的标准搜索声明。此模式授权 OpenAI 托管浏览，不经过 Harness 的逐工具审批或 URL 规则。 |
| `harness` | 保留本次会话允许的 Harness 搜索，继续经过宿主的审批和执行守卫；不提供 OpenAI 原生搜索。 |
| `off` | 不添加原生搜索，并移除当前请求中直接声明的 Harness `web_search`。 |

搜索设置只选择当前请求的搜索声明。`web_fetch`、`run_code`、终端与 MCP 等工具继续由 Harness 管理，包括它们可能执行的搜索。插件不修改宿主权限、不注入跨工具限制指令；`off` 不是断网或禁止所有搜索的开关。

配置只支持 `searchMode: native / harness / off`。若使用过未发布开发版的 `webSearch` 或 `legacy-auto`，请改为所需的 `searchMode`。

搜索失败或模型不支持时明确报错，插件不自动切换方式。标题生成、上下文压缩等辅助请求省略原生搜索与直接声明的 `web_search`；切换模式保留历史调用、结果与引用。需要宿主审批或 URL 限制时选择 `harness`，这些规则不适用于 OpenAI 托管浏览。

保持 composition 中的标准 entry ID `chatgpt-sub`，原生配置表单以此定位插件。只读配置或自定义 entry ID 会禁用选择框；可通过相应配置文件修改。

## 模型目录

插件把 `chatgpt-sub` 注册为 Harness 的 configurable provider。**Settings → Models** 会显示 **ChatGPT plan** 行，便于在模型提供方目录中看到它；该行的登录卡片与 **Settings → ChatGPT** 页面使用同一份连接状态。

完整的账户、搜索和网络选项仍在 **Settings → ChatGPT** 页面。Models 页的通用编辑入口只显示配置提示；`callbackPort`、`imageQuality`、`nativeFiles` 等字段请在该页面或 `cordis.patch.yml` 中修改。代理由 Harness 启动器统一管理，不在插件配置中。

## 模型能力

也可以在 profile 的 `cordis.patch.yml` 中配置。下面显式选择原生搜索；图像和文件选项需重载插件或重启后生效：

```yaml
- id: chatgpt-sub
  config:
    imageQuality: auto
    nativeFiles: true
    searchMode: native
```

- `imageQuality`：默认 `auto`，模型目录声明支持时采用受限的原始细节；`balanced` 降低尺寸与编码目标，`original` 明确要求模型支持原始细节。
- `nativeFiles`：默认 `true`，支持的用户附件以内联文件发送；设为 `false` 使用 Harness 的路径说明与文件工具。

细节见[图像输入](images.md)、[文件输入](files.md)和[运行行为](behavior.md)。

## 代理

插件不维护自己的代理配置，而是使用 Harness 启动器安装的进程级代理策略（`dsh-http-proxy` 会把它装成 undici 的全局 dispatcher）。在启动 Harness 前设置标准环境变量即可：

```sh
HTTPS_PROXY=http://127.0.0.1:7890 \
HTTP_PROXY=http://127.0.0.1:7890 \
NO_PROXY=localhost,127.0.0.1 \
dsh --profile web
```

因此旧的 `proxyMode` / `proxyUrlEnv` 字段已移除；请从已有的 `cordis.patch.yml` 中删除它们。需要让 ChatGPT 单独走另一个代理时，应使用部署级的网络策略，而不是插件内再建一套 dispatcher。

## 远程 Harness

OAuth 回调只监听 `127.0.0.1`，默认选择空闲端口，路径固定为 `/auth/callback`。远程主机的 loopback 与本地浏览器不是同一台机器。

在远程插件配置中设定固定端口，例如 `callbackPort: 1455`，然后从运行浏览器的电脑转发：

```sh
ssh -N -L 1455:127.0.0.1:1455 user@harness-host
```

保持转发运行，再在 Harness 中开始登录。不要把回调监听地址改成 `0.0.0.0`。不支持转发的远程环境暂不提供 device-code 或复制裸授权码的替代入口。
