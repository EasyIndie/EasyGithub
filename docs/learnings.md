# Learnings

> 仓库经验库：`agent-runner` 会在渲染 `TASK.md` 时按 Issue 标题/正文匹配 `## 小节`，
> 把最相关的 2 段（上限约 2400 字符）交给 AI。**流水线不会写这个文件**——由人或周报
> 通过普通 PR 维护，改这里等于改此后所有运行的上下文。

## pipeline: check gate
- 本仓库的检查命令是 `npm run check` = `tsc --noEmit` + `node --test test/*.test.ts`。
- 闸门在 agent 启动前冻结；改 `package.json` 的 `check` 不会让运行"通过"，只会得到 `ai-verify-changed`。
- 新增逻辑要同时加测试（`agent-runner/test/`），否则验证强度不会提升。

## pipeline: protected paths
- `.github/**`、`agent-runner/**`、`scripts/**`、`eval/**`、`LICENSE` 属于 high 风险：AI 只能开草稿 PR，必须由 code owner 批准。
- 不要尝试修改 `.github/workflows/**` 或 `LICENSE`：runner 会直接拒绝整次运行。

## pipeline: conventions
- 类型检查是 strict + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`：导入类型必须写 `import type`，索引要处理 `undefined`。
- 运行时零依赖：只能用 Node 内置模块和 `gh` / `git` / agent CLI。
- 提交信息用 Conventional Commits（`fix:` / `feat:` / `ci:` / `docs:` / `test:`）。
