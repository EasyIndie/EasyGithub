# 实时响应方案（Event-driven vs Polling）

> EasyGithub 的任务触发与执行架构决策文档。三种"部署模式"见
> [README](../README.md#deploy-to-another-repository-cross-repo-reuse) 与 [agents.md](agents.md)；
> 本文聚焦**触发链路**：如何从"我打 `ai` 标签"最快、最省地走到"AI 开工"。

## 1. 一句话现状

任务触发有**两种通道**：

| 通道 | 延迟 | 成本 | 说明 |
| --- | --- | --- | --- |
| 事件驱动（webhook / 仓库内 workflow） | 秒级 | 只在真正有任务时花 | 理想形态 |
| 轮询（hub schedule） | 30 分钟级（默认） | 每次扫描都计费 | 当前 App 模式 |

**成本本质**：GitHub 托管 runner 按 job 计费（向上取整≈1 分钟/job）；Free 组织私有仓库
额度 **2000 分钟/月**（同组织所有私有仓库共享，公共仓库无限免费）。轮询意味着"没任务也在烧分钟"。

---

## 2. 可行方案清单

### 方案 A —— 模式 2（caller 文件）：仓库内原生事件触发 【实时 · $0 · 轻侵入】

目标仓库放置 1 个 ~15 行 workflow，监听自己的 `issues: labeled` 事件，调用 EasyGithub 的
reusable workflow + composite action（runner 逻辑集中在 hub，`@main` 自动更新）。

```text
目标仓库 .github/workflows/ai-agent.yml (15行 caller)
   └─ on: issues: [labeled]  ← GitHub 原生秒级触发，无需任何外部服务
   └─ job: uses EasyIndie/EasyGithub/.github/workflows/ai-agent-reusable.yml@main
```

- **延迟**：秒级（实时）
- **成本**：轮询零开销；仅真实任务消耗（与任何方案相同）
- **侵入**：每仓库 1 个 yml + `DEEPSEEK_API_KEY` secret + 若干标签（installer 可一键完成）
- **前提**：仓库允许 Actions；EasyGithub 需开组织共享（已开）
- **工作量**：已完成并验证（install-to-repo.sh 默认模式）
- **缺点**：新仓库仍要跑一次安装器；secret/标签随仓库走

### 方案 B —— App 轮询（现状）【延迟 · 配额成本 · 零侵入】

hub 的 `ghapp-scan.yml` 定时跑，用 App 安装令牌跨仓库扫任务。

- **延迟**：`*/30` 默认 ≈ 30 分钟（可调）
- **成本**：每次扫描 1 job ≈ 1 分钟私有分钟；`*/30`≈1440 分钟/月（占额度 72%），`*/5`≈8600+/月（严重超支）
- **侵入**：零（目标仓库全零配置）
- **价值**：作为"兜底保险丝"低成本可用（如 `0 * * * *` 每小时 ≈720 分钟/月）

### 方案 C —— App Webhook → Cloudflare Worker → repository_dispatch 【实时 · $0 · 零侵入 · 推荐终态】

唯一缺口是"App 收到 webhook 后把事件送进 hub Actions"需要一个公网接收端。
用 **Cloudflare Worker（免费层 10 万次请求/天）** 做 40 行薄转发，成本 $0、无服务器常驻。

```text
GitHub App (easygithub-ai)
  └─ Webhook: issues labeled / edited（+ 可选 issue_comment）
        │
        ▼
  Cloudflare Worker（免费）
     ├─ 校验 HMAC（webhook secret）
     ├─ 过滤：label==ai 或 title/body 含 easygh-ai
     └─ 用 App 私钥（存 Worker secret）签安装令牌
        └─ POST repos/EasyIndie/EasyGithub/dispatches
              │  repository_dispatch: ai-issue {repo, issue_number}
              ▼
        hub workflow on: repository_dispatch
              └─ 复用 dispatcher 的 ISSUE_TARGET 单仓模式直接跑现成 runner
```

- **延迟**：秒级
- **成本**：Worker $0；hub 仅真实任务计费（与 A 相同）
- **侵入**：零
- **改动**：① App 设置加 Webhook URL+Secret 并订阅 Issues；② 部署 Worker（需 Cloudflare 账号）；
  ③ hub 加 `repository_dispatch` 工作流 + dispatcher `ISSUE_TARGET` 模式；④ 移除/降频轮询 cron
- **注意**：Webhook 重试自带；worker 可去重；建议保留每小时轮询作保险丝

### 方案 D —— App Webhook → 自有小服务（`opc.jokerhub.cn` / EasyGate 隧道）【实时 · 低/免费 · 零侵入】

与 C 同构，仅接收端不同：在你们已有域名对应的服务器上跑一个几十行 Node 接收端
（或经 EasyGate/EasyNet 把内网端口暴露成公网 https）。

- 成本：视现有服务器是否已付费（若已有则 ≈$0）
- 工作量大些：部署、守护进程、TLS、可用性责任自己背
- 适合：已有常驻机器，且不想引入 Cloudflare 依赖时

### 方案 E —— 混合（推荐近期落地顺序）

| 阶段 | 动作 | 结果 |
| --- | --- | --- |
| 现在 | 重要仓库用 **方案 A**（模式 2 caller）→ 秒级 | 主力实时，$0 |
| 现在 | App 轮询降为 **每小时保险丝**（`0 * * * *`） | 兜底，~720 分/月 |
| 之后 | 有空部署 **方案 C**（Worker）→ 全部仓库零文件实时 | 终态，停掉轮询 |

---

## 3. 决策矩阵

| 方案 | 实时 | 轮询开销 | 目标仓库侵入 | 新增基础设施 | 工作量 |
| --- | --- | --- | --- | --- | --- |
| A caller 文件 | ✅ 秒级 | 无 | 1 yml+secret+标签 | 无 | ✅ 已完成 |
| B App 轮询 | ❌ 30min | 高(占额度) | 零 | 无 | ✅ 已完成 |
| C Worker 转发 | ✅ 秒级 | 无(可留保险丝) | **零** | Cloudflare(免费) | 中 |
| D 自有小服务 | ✅ 秒级 | 无 | 零 | 已有机器/网关 | 中 |
| E 混合 | ✅ | 低(仅保险丝) | 视阶段 | 可选 | 渐进 |

**建议默认答案**：
- 要"最省 + 实时 + 接受 1 文件" → **A**
- 要"零文件 + 实时 + $0" → **C**（需要一个 Cloudflare 账号）
- 兜底一律保留 **每小时轮询**（低成本保险丝，防漏事件）

---

## 4. 实施清单（决定后照此执行）

### 方案 C 具体改动
1. GitHub App（easygithub-ai）设置：
   - Webhook URL = Worker 地址；Webhook secret 生成并同存 hub/Worker
   - Subscribe: **Issues**（labeled/opened/edited/unlabeled 足够）
2. Worker：`git clone` 风格部署，代码含：HMAC 校验、事件过滤、JWT→installation token、
   POST repository_dispatch（payload: `repository`, `issue_number`）；App 私钥存 Worker secret
3. hub：
   - dispatcher 增加 `ISSUE_TARGET="owner/repo#N"` 单任务模式（跳过全仓扫描）
   - 新工作流 `ghapp-dispatch.yml`：`on: repository_dispatch: types: [ai-issue]`
     → mint token → 跑 dispatcher（ISSUE_TARGET）
   - `ghapp-scan.yml` cron 改 `0 * * * *`（保险丝）
4. 实测：零配置新仓库打 `ai` 标签 → 秒级出 PR

### 方案 A 已可用
```bash
bash scripts/install-to-repo.sh EasyIndie/<repo>          # 默认 caller
bash scripts/install-to-repo.sh EasyIndie/<repo> --copy   # 若需全复制
```

---

## 5. 附：实测沉淀的平台约束（影响所有方案）

- 组织内私有仓库共享 **2000 分钟/月**（Free）；公共仓库不计费 → 也可考虑把 hub 或目标公开
- GitHub App 安装令牌 **不支持 Search API**、不支持 `gh --paginate`（dispatcher 用逐仓列 Issue）
- `gh api -f` 在无 `-X` 时会当 POST；查询参数走 URL（如 `?state=open`）
- reusable workflow 跨仓库调用**不能声明 `permissions`**（启动即失败）→ 权限放 caller/仓库默认
- workflow_call 的 inputs/secrets 标识符**不能用连字符**、不能在 `steps.env` 引用 inputs
- GitHub 会拦截"由 Actions 创建的 PR"所触发的工作流（需人工/API 批准）→ AI 修复循环尽量跑在
  actor 为人类的事件链（issues labeled / repository_dispatch 由人触发时）内
- cron 最小粒度 5 分钟；schedule 也计入计费

> 决策记录：2026-09 于 EasyIndie 组织实测（三种模式均已端到端验证，含轮询与各约束）。
