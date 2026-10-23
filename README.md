# ChatGPT subscription for DeepSeek Harness

English · [简体中文](README.zh-CN.md)

Use GPT models from your ChatGPT subscription in DeepSeek Harness with **Sign in with ChatGPT**. Account eligibility and available models are determined by OpenAI.

The plugin connects accounts, discovers models, and adapts Responses requests. Harness manages sessions, tool execution, permissions, and retries.

## Install

Requires **Node.js 22.12+** and **DeepSeek Harness 0.2.1-rc.2**.

Install from npm into your Harness profile (`web` in this example):

```sh
dsh plugin --profile web add @xunz03/dsh-chatgpt-sub
```

## Usage

1. Restart the Harness profile and open **Settings → ChatGPT**.
2. Click **Continue with ChatGPT**, open the sign-in link, and complete authorization.
3. Select a model under **ChatGPT plan** in the model picker.

GPT uses **OpenAI native search** as needed by default. In ChatGPT settings, you can select Harness search or disable direct search declarations. See [search configuration](docs/configuration.md) for the scope of each mode.

Switch, add, or sign out of accounts under **Manage**. The plugin inherits the Harness process's proxy environment variables by default. Signing in on a remote host requires forwarding the callback port.

## Documentation

- [Search modes, proxies, and remote sign-in](docs/configuration.md) (Chinese)
- [Accounts, models, search history, and error handling](docs/behavior.md) (Chinese)
- [Native image input and validation](docs/images.md) (Chinese)
- [Native file input](docs/files.md)

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:browser
pnpm check:package
```

Routine checks use mocked requests. Live Harness tests require explicit opt-in; see [validation](docs/behavior.md#验证).

After the package check, install the local build with `dsh plugin --profile web add ./xunz03-dsh-chatgpt-sub-0.1.0.tgz`.

[Release workflow](docs/releasing.md)

## License

[MIT](LICENSE). See [assets/README.md](assets/README.md) for logo attribution and trademark notices.
