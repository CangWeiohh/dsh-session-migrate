# AGENTS.md

## 目的

本仓库是一个 **仅通过本地链接安装** 的 DeepSeek Harness（DSH）插件。不要假设它已发布到 npm，也不要尝试执行 `npm publish`、`pnpm publish` 或按包名从 npm 安装。

## 安装前检查

1. 确认 DSH Desktop 已安装在：
   ```text
   /Applications/DSH Desktop.app
   ```
2. 确认 `pnpm` 可从当前 shell 的 `PATH` 使用；`dsh plugin` 会调用它来管理 profile。
3. 需要安装到 DSH 的 `web` profile。安装命令必须在本仓库根目录执行，或使用下面给出的绝对路径。

## 安装（本地链接）

在本仓库根目录执行：

```bash
APP="/Applications/DSH Desktop.app/Contents/Resources/app"
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"
"$APP/node_modules/node/bin/node" \
  "$APP/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add "link:$PWD"
```

关键要求：

- 必须使用 `link:$PWD`（或等价的 `link:/绝对/仓库路径`），以创建本地链接；不能只写包名。
- 不要改为仅运行 `pnpm add`：`dsh plugin` 在成功后会把插件同步进 DSH profile 的 bundle 配置。
- 不要用 `npm install` 安装到 DSH Desktop 的应用目录，也不要修改 DSH Desktop 内置的 `node_modules`。
- 命令完成后，完全退出并重新打开 DSH Desktop，令 web profile 重新加载插件。

## 验证与卸载

安装完成后可在仓库根目录执行：

```bash
npm run check
```

卸载时执行：

```bash
APP="/Applications/DSH Desktop.app/Contents/Resources/app"
export DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness"
"$APP/node_modules/node/bin/node" \
  "$APP/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web remove dsh-session-migrate
```

卸载后同样需要完全重启 DSH Desktop。

## 修改约束

- 保持 `package.json` 的 `dsh.bundle.patch` 配置、包名 `dsh-session-migrate` 与 `cordis.patch.yml` 中的插件 ID 一致。
- 修改插件代码后先运行 `npm run check`；不要将生成的安装产物、profile 文件或 DSH_HOME 数据提交到仓库。
- 会话迁移的真实写入只能在 DSH Desktop **完全退出** 后，通过插件生成的 CLI 命令执行；不要为了测试绕过此安全限制。
