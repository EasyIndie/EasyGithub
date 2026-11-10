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
| `EASYGH_VERIFY_CMDS` | variable（可选） | JSON map，零文件仓库的验证命令；覆盖 `agent-runner/config/verify.json` |

> **验证命令（零文件目标）**：因为目标仓库没有自己的 variables，App 模式从 **hub** 取验证配置：
> 提交在 `agent-runner/config/verify.json`（如 `{"Org/repo":{"cmd":"cargo test","timeout_ms":900000}}`），
> 或用 hub variable `EASYGH_VERIFY_CMDS`（同结构，优先级更高）。
> 未配置时自动检测：`package.json` 脚本 → `cargo test` → `go test ./...` → `swift test` → 其它（见 `docs/portability.md`）→ 跳过。
> 推荐把长期配置写进 `agent-runner/config/repos.json`（可 review），`EASYGH_VERIFY_CMDS` 仅作临时覆盖。
> Mode 2 则在**目标仓库**设 `VERIFY_CMD`（caller 已接好 `vars.VERIFY_CMD`）。
>
> **调优（实测数据，EasyBot Rust workspace）**：一次真实运行中 `cargo test` 耗时
> 首次 ~1 分钟、修复后重跑 ~2.5 分钟；真正的大头是 AI agent（4~23 分钟）。
> 所以**默认保留全量 `cargo test`**（覆盖最完整）。只有在确认编译确实成为瓶颈时才收窄：
> `cargo test -p <crate>`（仅测指定 crate，会漏掉其它 crate/bin 的回归）或
> `cargo clippy --all-targets -- -D warnings`（静态检查，快但不跑测试）。
> 大仓也可把 `timeout_ms` 调高（默认 900000 = 15 分钟）。
> 另外：每次运行都会上传 `ghapp-dispatch-logs` artifact（TASK.md / `pi-*.jsonl` / `verify-*.log`），
> 排查“第一次为什么没过验证”直接下载即可。

```bash
gh secret set EASYGH_APP_PRIVATE_KEY -R <hub>/<repo> < app.private-key.pem
gh secret set DEEPSEEK_API_KEY -R <hub>/<repo>
gh variable set EASYGH_APP_ID -R <hub>/<repo> --body "<app-id>"
gh variable set EASYGH_ORG   -R <hub>/<repo> --body "<TargetOrg>"
```

### 4. 触发与验证
- 给目标仓库任意 Issue 打 `ai` 标签，**或**以仓库成员/协作者身份在标题/正文写 `easygh-ai`
  （外部作者的 marker 会被忽略，`ai` 标签仍有效——加标签需要 triage 权限）
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

## 路线 C：一个 hub 服务多个组织（已支持）

`ghapp-scan` 现在按 `vars.EASYGH_ORGS`（逗号分隔）做 **matrix**：每个组织一个 job，各自签发
该组织安装的 installation token；`dispatcher` 用 `/installation/repositories` 只能看到该安装
范围内的仓库，所以组织之间天然隔离，凭证也不用按组织分开（同一个 App）。

### 一次性前提

1. **App 允许任意账号安装**：App settings → "Where can this GitHub App be installed?" = *Any account*。
2. **App 仓库权限**（Repository permissions）：

   | 权限 | 级别 | 用途 | 缺了会怎样 |
   | --- | --- | --- | --- |
   | Contents | Read and write | 推分支、建 PR、revert | 无法交付 |
   | Issues | Read and write | 标签、评论、`ai-incident` | 无法回写状态 |
   | Pull requests | Read and write | 建 PR、`gh pr merge --auto` | 自动合并失效 |
   | Actions | **Read-only** | 跨仓库看护读 workflow runs | 看护退化为 `skipped`（日志会写 "app needs Actions: read"） |
   | Workflows | Read and write（可选） | 万一需要改 workflow 文件 | 改 workflow 的推送会被拒（策略层已禁止） |
   | Metadata | Read-only（自动） | 基础读取 | — |

   改完权限后，**每个组织需要在安装页重新批准**（GitHub 会提示）。
3. **在每个目标组织安装 App**：`https://github.com/apps/easygithub-ai/installations/new`
   → 选组织 → All repositories（或选定）。安装需要该组织 **admin**。

   > **GitHub 没有"在 App 里添加组织"的设置项。** 能装到哪里由 General 页的
   > "Where can this GitHub App be installed?" 单选决定（`Any account` / `Only on this account`），
   > 安装入口在 App 页面（Install App 标签）或 `https://github.com/apps/<slug>/installations/new`。
   >
   > 如果安装页只显示 EasyIndie、看不到目标组织，说明 App 是**私有**（`Only on this account`）：
   > 未登录访问 `https://api.github.com/apps/<slug>` 会返回 404（公开 App 返回 200）。
   >
   > **解法 A（推荐，1 分钟）**：App settings → General → "Where can this GitHub App be installed?"
   > 改成 **Any account** → Save，然后重新打开安装页。
   >
   > **解法 B 可脚本化**：`node scripts/ghapp-manifest.mjs --org <Org> --out <dir> --open`
   > 会在本地起回调服务、打开浏览器；你只需点 **Create GitHub App** 和 **Install** 两次。
   > 结束后 `<dir>/<Org>.pem` 即私钥（0600），用下面的 `gh secret set` 写入后立即删除该文件。
   >
   > **解法 B（保持私有，每组织独立 App）**：让每个组织拥有自己的 App（owner = 该组织），
   > 装到它自己；然后给 hub 配按组织命名的凭证（大写、非字母数字换成 `_`）：
   > ```bash
   > gh variable set EASYGH_APP_ID_ORZMC        -R EasyIndie/EasyGithub --body "<orz-app-id>"
   > gh secret   set EASYGH_APP_PRIVATE_KEY_ORZMC -R EasyIndie/EasyGithub < orz.private-key.pem
   > gh variable set EASYGH_APP_ID_ORZGEEKER        -R EasyIndie/EasyGithub --body "<geeker-app-id>"
   > gh secret   set EASYGH_APP_PRIVATE_KEY_ORZGEEKER -R EasyIndie/EasyGithub < geeker.private-key.pem
   > ```
   > `ghapp-scan` / `ai-decide` 会优先用 `EASYGH_APP_ID_<ORG>` / `EASYGH_APP_PRIVATE_KEY_<ORG>`，
   > 找不到才回落到共享 App。每个组织的 App 也需要同样的仓库权限（含 `Actions: Read-only`）。
4. **hub 变量**：
   ```bash
   gh variable set EASYGH_ORGS -R EasyIndie/EasyGithub --body "EasyIndie,OrzMC,OrzGeeker"
   # EASYGH_ORG 单组织写法仍兼容（EASYGH_ORGS 优先）
   ```

机密（`EASYGH_APP_ID` / `EASYGH_APP_PRIVATE_KEY` / `DEEPSEEK_API_KEY`）仍然**只放在 hub**，
不需要给目标组织任何 secret——这正是零文件模式的意义。

### 验证

```bash
gh workflow run ghapp-scan -R EasyIndie/EasyGithub
gh run view <run-id> -R EasyIndie/EasyGithub --log | grep -E "matrix:|\[watch\]|\[dispatch\] (org=|accessible repos)"
# 期望：
#   matrix: ["EasyIndie","OrzMC","OrzGeeker"]
#   [dispatch] org=OrzMC accessible repos: 22
#   [watch] OrzMC/<repo>: skipped — no ai-pr label (pipeline never used here)
```

触发一个任务：在目标组织任意仓库给 Issue 打 `ai` 标签（或成员在标题/正文写 `easygh-ai`）。

### 跨组织的人工操作（`ai-decide`）

`ai-decide` 现在带 `repo` 输入，hub 可以直接操作目标组织的 Issue：

```bash
gh workflow run ai-decide -R EasyIndie/EasyGithub \
  -f repo=OrzMC/<repo> -f issue=42 -f action=retry

# 回答 AI 的问题
gh workflow run ai-decide -R EasyIndie/EasyGithub \
  -f repo=OrzMC/<repo> -f issue=42 -f action=answer -f note="用方案 B，别动 public API"

# 取消卡住的运行
gh workflow run ai-decide -R EasyIndie/EasyGithub \
  -f repo=OrzMC/<repo> -f issue=42 -f action=cancel
```

授权检查针对 **hub** 的协作者（控制平面），动作通过目标组织的 installation token 执行；
`set-automerge` 需要 `EASYGH_PR_TOKEN`（admin PAT），因为仓库变量 API 不接受 App token。

### 权限模型（防"陌生人无审查合并"）

GitHub 的 `required_approving_review_count` 是**全仓库统一**的，且实测 **auto-merge 不认 ruleset 的
bypass actor**（`Integration`，`pull_request`/`always` 两种模式都试过，App 的 PR 依然 `REVIEW_REQUIRED`）。
所以"人类必须审查 + App 零点击"无法用同一个开关实现。做法是**把"谁能合并"交给权限**：

```bash
# 1) 组织默认权限 read：成员只能读/开 fork PR，没有合并按钮
gh api -X PATCH orgs/<Org> -f default_repository_permission=read

# 2) 只给维护者写权限（team 或 outside collaborator）
gh api -X PUT orgs/<Org>/teams/maintainers/repos/<Org>/<repo> -f permission=push

# 3) 有分支保护的仓库统一配成：必需检查 + 0 批准 + admin 可应急绕过
bash scripts/enable-ai-gate.sh <Org>/<repo> [<Org>/<repo>...] [--contexts "a,b"] --dry-run
bash scripts/enable-ai-gate.sh <Org>/<repo> [<Org>/<repo>...]
```

`enable-ai-gate.sh` 的行为：
- 只处理**已有经典分支保护**的仓库；已有 ruleset 在管检查的仓库不重复叠加。
- 检查名优先沿用仓库原有的必需检查，其次取最近 PR 上**非 SKIPPED** 的检查，最后取 head 提交的检查。
- 经典 `required_status_checks` 子接口返回 404（"not enabled"）时，自动改为建 `ai-gate` ruleset。
- 默认 `strict=false`（避免主干前进后旧 PR 被卡死），可用 `--strict` 打开。
- 不碰 force-push / 删除保护。

结果：陌生人（无写权限）根本无法合并；App 只对 low 风险 + 冻结检查通过的 PR 开 auto-merge；
高风险仍是草稿 PR（谁都不能合）。若要"连有写权限的人也必须被审查"，需要额外的自动审批器（方案 B）。

### 每个目标仓库仍需自己配的合并策略

hub 不能修改别人的仓库设置，所以 auto-merge 开关与分支保护要在目标仓库里配：

```bash
# 1) 允许 auto-merge（否则低风险 PR 只会停在那里）
gh api -X PATCH repos/OrzMC/<repo> -F allow_auto_merge=true

# 2) 单人维护者：0 批准 + 必需检查（否则自己的 PR 无法自我批准）
gh api -X PATCH repos/OrzMC/<repo>/branches/main/protection/required_pull_request_reviews \
  -F required_approving_review_count=0 -F dismiss_stale_reviews=true

# 3) 必需检查：用目标仓库自己的 CI（没有就跳过；无必需检查时，低风险 PR
#    在 hub 侧验证通过后会被 auto-merge 直接合并）
gh api -X PUT repos/OrzMC/<repo>/branches/main/protection/required_status_checks \
  -f strict=true -f 'contexts[]=<job-name>'
```

### 配额与成本

- `AI_MAX_PRS_PER_DAY`：**按仓库**统计（该仓库最近 24h 的 `[AI]` PR 数）。
- `MAX_ISSUES`：**每个组织每次扫描**的上限；matrix 后总处理量 ≈ 组织数 × MAX_ISSUES。
- Actions：hub 是 public（免费）；目标仓库的 **PR CI** 消耗**目标组织**的分钟数。
- DeepSeek 费用集中在 hub 的 key（所有组织共用）。

### 常见坑

- matrix 里某个组织没有安装 → 该 job 在 `Mint ... token` 步失败（`no installation found for org X`），
  其它组织不受影响（`fail-fast: false`）。
- 安装时选了 "Only select repositories" → `accessible repos` 里只有选中的仓库。
- 看护一直是 `skipped — cannot read workflow runs` → App 缺 `Actions: Read-only`（改权限后要在每个组织重新批准）。
- `set-automerge` 报 404/403 → 没有 `EASYGH_PR_TOKEN`，或该 PAT 不是 hub 的 admin。

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
[ ] 路线 C：`EASYGH_ORGS` 已设 + App 已装到每个组织 + App 有 `Actions: Read-only`
[ ] 路线 C：目标仓库已开 `allow_auto_merge` + 0 批准（单人）+ 必需检查
[ ] 验证：Issue 标签流 ai→ai-running→ai-pr，或 ghapp-scan 日志出现 === Org/repo #N ===
```
