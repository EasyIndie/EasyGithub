# 在其它组织中使用 EasyGithub

EasyGithub 的 runner / workflow 本身与组织无关；组织相关的只有三样东西：
**GitHub App 安装、hub 的 secret/variable、以及触发标签**。按你的情况选一条路线即可。

> **License 前置**：EasyGithub 采用 [BUSL-1.1](../LICENSE)。
> 组织内部使用、用它开发你自己的项目 = 免费；**把 EasyGithub 本身当托管/付费服务卖** = 需要商业授权；
> 目前**不接受外部代码贡献**（合并外部 PR 前需先有 CLA）。

## 选路线

| 你的情况 | 路线 | 侵入性 | 延迟 |
| --- | --- | --- | --- |
| 只是想在**自己仓库**里让 AI 修 Issue | **A. 复用 EasyIndie hub**（Mode 2 / 1） | 1 个文件 / 全复制 | 秒级（标签事件） |
| 想要**零文件**、且能接受轮询；或想完全独立 | **B. 自建 hub + 自己的 GitHub App**（Mode 3） | 0 文件（目标仓库） | ≤5 分钟（可调密） |
| 想用一个 hub 服务**多个组织** | **C. 共享 hub 多组织**（需小改造） | 0 文件 | ≤5 分钟 |

---

## 路线 A：复用 EasyIndie 的 hub（最省事）

EasyGithub 是公开仓库，所以外部组织可直接引用 `EasyIndie/EasyGithub@main`。

### 前置条件
- 对目标仓库有 **admin**（安装器要设 secret / 标签 / Actions 权限）
- `gh` 已登录，且有目标仓库权限
- 一个 **DeepSeek API key**（platform.deepseek.com）
- 目标组织允许 Actions 运行；若组织禁止 "Allow GitHub Actions to create and approve pull requests"，首次 PR 需人工批准（或用 API 批准）
- 私有仓库会消耗该组织 Actions 分钟（Free 2000/月）；**public 仓库免费无限**

### 操作（30 秒）
```bash
gh repo clone EasyIndie/EasyGithub ~/easygh

# Mode 2（推荐，1 个 caller 文件，runner 更新自动生效）
bash ~/easygh/scripts/install-to-repo.sh <Org>/<repo>

# 或 Mode 1（完全自包含，不依赖 EasyIndie hub）
bash ~/easygh/scripts/install-to-repo.sh <Org>/<repo> --copy
```

安装器会自动：
1. 写 `.github/workflows/ai-agent.yml`（caller 引用 `EasyIndie/EasyGithub/.github/workflows/ai-agent-reusable.yml@main`）
2. 创建标签（`ai` / `ai-running` / `ai-pr` / `ai-failed` / `ai-done`）
3. 尝试设置 `DEEPSEEK_API_KEY` secret（读不到本地 key 时提示手动：
   `gh secret set DEEPSEEK_API_KEY -R <Org>/<repo>`）
4. 设目标仓库 `default_workflow_permissions=write`（跨仓库 reusable 不能声明 `permissions`）
5. 开一个安装 PR

### 使用与验证
```bash
# 合并安装 PR
gh pr merge <PR#> -R <Org>/<repo>

# 触发：给任意 Issue 打 ai 标签（秒级）
gh issue edit <N> -R <Org>/<repo> --add-label ai

# 验证是否触发
gh issue view <N> -R <Org>/<repo> --json labels --jq '[.labels[].name]'   # ai 消失→ai-running→ai-pr/ai-failed
gh run list -R <Org>/<repo> --workflow ai-agent.yml --limit 3
```
可选：`feature`/`bug` 标签选模板；`agent:claude` / `agent:codex` 换引擎；变量 `AI_MODEL` / `AI_THINKING` /
`AI_MAX_ATTEMPTS` 调参（见 README）。

### 局限
- **依赖 EasyIndie hub 的 `@main`**；要固定版本可把 caller 里的 ref 改成 tag/commit。
- Mode 2 期间 EasyIndie hub 若被禁用/删除，目标仓库失效；Mode 1 不受影响。

---

## 路线 B：自建 hub + 自己的 GitHub App（零文件 Mode 3）

目标仓库**零改动**：不需要 workflow、runner、secret。

### 1. 复制 hub
Fork `EasyIndie/EasyGithub`，或 `git clone` 后推到自己的组织（public fork → Actions 依然免费）。

### 2. 建 GitHub App 并安装
在目标组织（Settings → Developer settings → GitHub Apps → New）：
- **Permissions**：`Issues: Read & write`、`Contents: Read & write`、`Pull requests: Read & write`、`Metadata: Read-only`
- **Webhook**：取消勾选（用轮询；要做实时见 `docs/realtime.md` 方案 C）
- 生成 **Private key**，记录 **App ID**
- **Install** 到目标组织（All repositories）

### 3. 配置 hub 的 secret / variable

| 名称 | 类型 | 值 |
| --- | --- | --- |
| `EASYGH_APP_PRIVATE_KEY` | secret | App 私钥 PEM 全文 |
| `EASYGH_APP_ID` | variable | App ID |
| `DEEPSEEK_API_KEY` | secret | 你的 DeepSeek key |
| `EASYGH_ORG` | variable | 目标组织名（**已参数化**，默认 `EasyIndie`） |
| `EASYGH_REPO_FILTER` | variable（可选） | 逗号分隔仓库白名单，如 `Org/a,Org/b` |
| `EASYGH_MAX_ISSUES` | variable（可选） | 每次运行最多处理几个 Issue（默认 4） |

```bash
gh secret set EASYGH_APP_PRIVATE_KEY -R <hub>/<repo> < app.private-key.pem
gh secret set DEEPSEEK_API_KEY -R <hub>/<repo>
gh variable set EASYGH_APP_ID -R <hub>/<repo> --body "<app-id>"
gh variable set EASYGH_ORG   -R <hub>/<repo> --body "<TargetOrg>"
```

### 4. 触发与验证
- 给目标仓库任意 Issue 打 `ai` 标签，**或**在标题/正文写 `easygh-ai`
- hub 每 5 分钟轮询；验证：
```bash
gh run list -R <hub>/<repo> --workflow ghapp-scan.yml --limit 3
gh run view <run-id> -R <hub>/<repo> --log | grep -E "\[dispatch\] (org=|accessible repos|skip|===|done)"
#   org=<TargetOrg>            ← 确认组织正确
#   accessible repos: N       ← 安装范围里能看到目标仓库
#   === <Org>/<repo> #N ===   ← 命中并开始处理
```

### 常见坑
- `no installation found for org <X>`：App 没装到该组织，或 `EASYGH_ORG` 写错。
- `accessible repos` 里没有目标仓库：App 安装时选了 "Only select repositories"。
- 仓库里没有 `ai` 标签时，UI 里加不了 → 用 `easygh-ai` 标记触发（App 处理时会自动补建标签）。

---

## 路线 C：一个 hub 服务多组织（需小改造）

现状：`scripts/ghapp-token.mjs` 按 `ORG` 找一个安装并签发该安装的 token，`dispatcher.ts` 用
`/installation/repositories` 列仓库——**一次运行只覆盖一个组织的安装**。

多组织有两种做法：

1. **matrix（各组织独立 App）**：在 `ghapp-scan.yml` 把 `scan` job 改成
   `strategy.matrix.org: [OrgA, OrgB]`，per-org 提供 App id/key（用带后缀的 secret 名或 environment）。
2. **一个 App 装到多个组织**：App 所有者设为 EasyIndie 且允许任意账号安装；matrix 只切 `ORG`，
   凭证共用（App 私钥集中托管 → 风险与信任更高，仅适合邀请制合作方）。

无论哪种，都需要决定：**DeepSeek 费用归谁**、**Actions 分钟归谁**、**App 私钥由谁托管**。

---

## 平台限制速查（均为实测）

| 事项 | 结论 |
| --- | --- |
| 跨仓库 reusable workflow | **不能声明 `permissions`**，否则 `startup_failure`；靠 caller job 权限 + 目标仓库 default=write |
| `workflow_call` inputs/secrets | 标识符**不能带连字符**；不能放进 `steps.env` 映射，需内联在 `run:` |
| GitHub App 安装令牌 | **不能用 Search API**、**不能用 `gh --paginate`**（404）；查询参数要写在 URL 里 |
| cron 最小粒度 | 5 分钟；`schedule` 也计费（public 仓库免费） |
| Actions 创建的 PR | 组织需允许 "Allow GitHub Actions to create and approve pull requests"，否则需人工/API 批准 |
| 私有 vs 公开仓库 | 私有按分钟计费；公开仓库 Actions 免费无限 |

## 检查清单

```
[ ] License 允许我的用法（BUSL：内部使用免费；转售服务需授权）
[ ] 目标仓库有 admin 权限
[ ] DeepSeek key 就位
[ ] 路线 A：安装器已跑 + PR 已合并 + ai 标签可触发
[ ] 路线 B：App 已建/已装 + 4 个 secret/variable 已配 + EASYGH_ORG 正确
[ ] 路线 C：multi-org 方案与费用/密钥归属已确定
[ ] 验证：Issue 标签流 ai→ai-running→ai-pr，或 ghapp-scan 日志出现 === Org/repo #N ===
```
