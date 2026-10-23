# ChatGPT subscription for DeepSeek Harness

[English](README.md) · 简体中文

在 DeepSeek Harness 中使用 ChatGPT 订阅账户的 GPT 系列模型，通过 **Sign in with ChatGPT** 登录。账户资格与可用模型以 OpenAI 实际返回为准。

插件负责账户连接、模型发现和 Responses 请求适配。会话、工具执行、权限与重试由 Harness 管理。

## 安装

需要 **Node.js 22.12+** 和 **DeepSeek Harness 0.2.1-rc.2**。

从 npm 安装到你使用的 profile（以下以 `web` 为例）：

```sh
dsh plugin --profile web add @xunz/dsh-chatgpt-sub
```

## 使用

1. 重启相应的 Harness profile，进入 **Settings → ChatGPT**。
2. 点击 **Continue with ChatGPT**，打开登录链接并完成授权。
3. 在模型选择器的 **ChatGPT plan** 下选择模型。

默认由 GPT 按需调用 **OpenAI 原生搜索**。在 ChatGPT 设置页可改用 Harness 搜索或关闭直接搜索声明，具体范围见[搜索配置](docs/configuration.md)。

账户切换、添加与退出在设置页的 **管理** 中。插件默认继承 Harness 进程的代理环境变量；远程主机登录需要转发回调端口。

## 文档

- [搜索模式、代理与远程登录](docs/configuration.md)
- [账户、模型、搜索历史与错误处理](docs/behavior.md)
- [原生图像输入与验证](docs/images.md)
- [原生文件输入](docs/files.md)

## 开发

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm check:package
```

常规检查使用模拟请求；真实 Harness 测试需要显式开启，见[验证说明](docs/behavior.md#验证)。

本地验证安装可在上述打包检查后运行 `dsh plugin --profile web add ./xunz-dsh-chatgpt-sub-0.1.0.tgz`。

## 许可证

[MIT](LICENSE)。Logo 的第三方来源与商标说明见 [assets/README.md](assets/README.md)。
