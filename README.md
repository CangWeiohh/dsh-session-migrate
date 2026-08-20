# dsh-session-migrate

安全、快捷地把 DeepSeek Harness 会话迁移到另一个已注册工作区。

> **重要：真实迁移只在线下执行。** 插件运行时只生成计划和绝对命令；必须完全退出 DSH Desktop 后再运行 CLI。这样可避开 persistence、Workspace、projection 与 live Session 的进程内缓存。

## 功能

- 当前会话 Header 快捷入口
- Sidebar 全局“会话迁移”入口
- 选择已注册目标 Workspace
- 生成持久化 plan、dry-run 命令和 execute 命令
- 自动发现并验证唯一 Session artifact
- 支持 plaintext JSONL 和多 frame Zstandard JSONL
- 使用当前 DSH 的 `decodeStorageRecord` 验证 packed chunks、事件词汇与连续 seq
- frame 0 只改 `cwd`，其余 zstd frames 原字节保留
- 显式更新 Workspace domain v2，保留归档集合
- 删除目标 Session 的 projection-cache v3 row，使其下次惰性重建
- staging、完整备份、source quarantine、事务 manifest、自动 rollback
- 可选 best-effort 迁移 `dsh-recall-plugin` 快照；目标 store 已存在时不冒险合并

## 安装

```bash
dsh plugin --profile web add link:/Users/cangwei/Personal.localized/develop/github/dsh-session-migrate
```

然后完全重启 DSH Desktop。仅安装到 `node_modules` 不够，命令会把插件加入 profile bundles/Loader composition。

## 使用

1. 打开会话 Header 的迁移图标，或点击 Sidebar 底部“会话迁移”。
2. 选择 Session 和目标 Workspace。
3. 生成计划，复制两条绝对命令。
4. **⌘Q 完全退出 DSH Desktop**，确认 Dock 与相关进程均已消失。
5. 在终端执行 dry-run 命令。
6. dry-run 成功后执行正式命令。
7. 重新打开 DSH Desktop。

CLI 也可直接使用：

```bash
/path/to/node /path/to/bin/migrate-session.mjs dry-run --plan /absolute/plan.json
/path/to/node /path/to/bin/migrate-session.mjs execute --plan /absolute/plan.json
/path/to/node /path/to/bin/migrate-session.mjs rollback --backup /absolute/backup-dir
```

## 安全限制

- v0.1 拒绝运行中的 Session。
- v0.1 拒绝 `parentSession` 或存在子 Session 的非孤立会话；后续版本可增加整棵 Session tree 迁移。
- 只支持 Workspace domain v2 和 projection-cache v3；未知版本 fail closed。
- CLI 必须能够通过 `ps`、`lsof` 和文件稳定窗口证明 DSH 已停止。
- Harness root 必须来自 Host plan 或显式输入，不从 `process.cwd()` / Desktop launch-root 推导。
- Recall 是第三方可选适配，失败只 warning，不损坏核心迁移。
- Session ID 不变，事件字节不变，因此 attachment refs 不改写；事务保存原 Session 物理字节，rollback 原样恢复。

## 备份与回滚

备份位于：

```text
<DSH_HOME>/.session-migrate-backups/<timestamp>-<session-id>/
```

包含原始 Session 目录、Workspace、projection cache、manifest 和 source quarantine。执行结果会返回 `backupDir`。

## 开发验证

```bash
npm run check
```

测试包含：

- projectKey 编码
- zstd 多 frame 头部改写
- packed storage record/seq 校验
- 显式 Harness root 校验
- 隔离的临时 Harness root 上 execute + rollback 集成测试

测试不会访问真实 DSH_HOME。
