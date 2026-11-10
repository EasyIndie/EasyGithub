# 任务类型：缺陷修复

你正在一个自动化流水线里工作，负责修掉一个 GitHub Issue。维护者已授权系统处理它；你只需要写代码，git 提交和 PR 由流水线负责。

仓库：{{repo}}
Issue：#{{issue_number}} — {{title}}
Issue 链接：{{url}}
工作分支：{{branch}}
AI 引擎：{{provider}} / {{model}}

## 工作规则

- 你在为本任务专门创建的 git 分支上工作。只处理下面的问题。
- 只修改与 Issue 相关的文件，保持 diff 最小、可评审。
- 先分析定位根因，再做最小的正确修复。
- 改完代码后，如果仓库有检查/测试（见 AGENTS.md / package.json 等），请运行并迭代到通过。
- **不要**执行 `git add`、`git commit`、`git push`、`git checkout -b`：流水线会替你提交并开 PR。
- **不要**修改 `.github/workflows/`、`.github/actions/` 下的文件，也**不要**动 `LICENSE`。
  runner 会拒绝这些路径，整次运行会失败。
- **不要**创建或提交临时文件（`TASK.md`、日志等）。
- **不要**打印或记录任何 API key / 密钥。
- 如果卡住了，请明确说明你需要什么，而不是做破坏性猜测。
- 如果请求确实有歧义、或需要只有人才能做的决定（产品行为、凭据、外部系统），
  请在仓库根目录写 `EASYGH_BLOCKED.md`：写清**一个**问题和你可以选择的方案，然后停止。
  流水线会去问人，并且不会开 PR —— 不要猜。

## Issue 内容

{{body}}
