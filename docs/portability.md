# 适配不同项目（通用化手册）

EasyGithub 的设计目标是**项目无关**：同一套 runner 服务 Node / Rust / Swift / Java / Go / Python / 多语言仓库。
本文说明哪些是通用的、哪些需要按仓库配置，以及接入一个新项目的完整清单。

## 1. 已经是通用的部分

| 能力 | 说明 |
|---|---|
| 触发契约 | Issue 标签 `ai`（或成员写 `easygh-ai`），状态标签 `ai-*` 固定不变 |
| 三种接入模式 | Mode 1 全复制 / Mode 2 caller workflow / Mode 3 零文件（GitHub App） |
| 引擎适配 | `pi` / `claude` / `codex`，统一在 `CodingAgent` 接口后（`src/agents/`） |
| 仲裁 | 验证命令在 agent 启动前冻结；篡改检测；路径/密钥审计；凭据隔离 |
| 交付 | 风险分级（low/medium/high）、草稿 PR、auto-merge、事故看护、周报 |
| 经验注入 | `docs/learnings.md`（可按仓库改名，见 profile） |
| 评测 | `eval/tasks/*.json` 冻结任务 + 隐藏测试 |

## 2. 需要按仓库配置的部分 = 仓库画像（profile）

配置文件：**`agent-runner/config/repos.json`**（放在 hub，因为零文件模式的目标仓库不能有流水线文件；
集中存放也便于 review 和回滚）。

```json
{
  "_defaults": {},
  "repos": {
    "OrzMC/OrzMCApp": {
      "verify": ["bash scripts/check-platform-split.sh"],
      "protectedPaths": [".github/", "scripts/", "Sources/", "OrzMC/", "OrzMC.xcodeproj/"],
      "dependencyFiles": ["Package.swift", "Package.resolved"],
      "learningsFile": "docs/iteration-flow.md"
    }
  }
}
```

### 字段

| 字段 | 作用 | 默认 |
|---|---|---|
| `verify` | 验证命令数组，按顺序用 ` && ` 连接；**在 agent 启动前冻结** | 自动探测 |
| `verifyTimeoutMs` | 单次验证超时 | 600000（10 分钟） |
| `verifyContainer` | 在指定 Docker 镜像里执行验证（Swift/.NET/特定 JDK…） | 宿主直接执行 |
| `runsOn` | 该仓库的任务交给这些 runner label（自托管 macOS/Windows 也行） | hub 的 `ubuntu-latest` |
| `protectedPaths` / `protectedFiles` | 改到这些路径 → **high 风险**（草稿 PR + code owner） | `.github/`、`agent-runner/`、`scripts/`、`eval/`、`LICENSE` |
| `blockedPaths` / `blockedFiles` | 直接拒绝提交（运行失败） | `.github/workflows/`、`.github/actions/`、`LICENSE` |
| `sensitivePaths` / `sensitiveFiles` | 允许提交但打 `ai-core` 标签，必须人工审查 | `agent-runner/`、`.github/`、`scripts/`、`package.json` |
| `ignoredPaths` | 永不提交（vendored/生成物），即使仓库忘了 .gitignore | `node_modules/`、`dist/`、`build/`、`target/` … |
| `dependencyFiles` | 改到视为供应链变更 → high | `package.json`、`Cargo.toml`、`go.mod` … |
| `learningsFile` | 注入 TASK.md 的经验文件 | `docs/learnings.md` |
| `locale` | 该仓库提示词语言（`AI_LOCALE` 可覆盖） | `en` |
| `promptsDir` | 该仓库的提示词变体目录（`prompts/<dir>/`） | 共享模板 |
| `agent` | 默认引擎（标签 `agent:<name>` 仍优先） | `pi` |
| `model` | 默认模型（`MODEL` 环境变量仍优先） | `deepseek-v4-flash` |
| `maxAttempts` / `maxPrsPerDay` | 重试次数 / 每日 PR 配额 | 3 / 10 |

### 优先级（从低到高）

```
内置默认 -> _defaults -> repos["owner/repo"] -> 旧配置 config/verify.json -> 环境变量覆盖
```

环境变量：`VERIFY_CMD`（单仓库一次性覆盖）、`EASYGH_VERIFY_CMDS`（JSON map，运维临时覆盖）、
`AI_MAX_ATTEMPTS`、`AI_MAX_PRS_PER_DAY`、`MODEL`、`AGENT`、`PI_TIMEOUT_MS`。

> 列表字段是**替换**而不是叠加：profile 里写了 `protectedPaths` 就完全取代内置值。
> 但 `.github/`、`.git/`、`LICENSE` 这类信任锚点在任何 profile 下都保持生效。

## 3. 验证命令的运行环境（重要约束）

验证在 **hub 的 runner（默认 `ubuntu-latest`）** 上执行，不是目标仓库的 CI：

- 命令必须能在 Ubuntu 上跑，且**不依赖目标仓库的 CI 环境**（服务、密钥、macOS 工具链）。
- 需要 macOS/Xcode 的项目（如 iOS）→ 在 profile 里给一个 Ubuntu 可跑的轻量门禁（脚本/静态检查），
  重量级构建交给目标仓库自己的 CI（作为非必需检查）。
- 需要私有依赖/密钥的构建 → 在 hub 加 secret，或把命令收窄到静态检查。
- 没有可跑的检查时，结果会被标记为**未验证**（high 风险 → 草稿 PR），不会被当成"通过"。

### 自托管 / 指定 runner（`runsOn`）

macOS（Xcode）、Windows（MSVC）这类无法用 Linux 容器的项目，可以指定 runner：

```json
"Org/iOSApp": {
  "runsOn": ["self-hosted", "macos", "xcode-26"],
  "verify": ["xcodebuild -scheme OrzMC -destination 'platform=iOS Simulator,name=iPhone 17' test"]
}
```

工作方式（仅 App / 零文件模式）：

1. `ghapp-scan` 发现该仓库的 Issue 后**不在 hub 上跑**，而是 `workflow_dispatch` 一个
   `ai-run.yml`，把 `repo` / `issue` / `runs_on`（JSON 数组）传过去（用 hub 自己的 `GITHUB_TOKEN`；
   需要工作流有 `actions: write`，已配置）。
2. `ai-run.yml` 在 `runs-on: fromJSON(runs_on)` 上启动，签发目标组织的 installation token、
   克隆目标仓库到 `$RUNNER_TEMP`，再跑标准 runner。
3. 没有匹配 label 的 runner 时，任务会**一直排队**（这是有意的：静默退回 ubuntu 会给出不可信的验证结果）。
   取消排队或补 runner 即可。

- 自托管 runner 需要：`node >= 22`（`setup-node` 会自动装）、`git`、`gh`；容器验证还需要 Docker。
- `runsOn` 与 `verifyContainer` 可以并用（容器只在 Linux runner 上有意义）。
- Mode 1/2（目标仓库自己的 workflow）不需要 `runsOn`：直接在 caller workflow 里写 `runs-on:` 即可。

### 容器化验证（`verifyContainer`）

宿主 runner 没有的工具链（Swift、.NET、特定 JDK、Flutter…）可以用镜像补齐：

```json
"org/app": { "verify": ["swift test"], "verifyContainer": "swift:6.0" }
```

实际执行：`docker run --rm -v <worktree>:/work -w /work --entrypoint bash <image> -c "<cmd>"`。

- 镜像必须自带 `bash` 与工具链；工作区可写（依赖缓存会写进去）。
- 容器模式下**不会**在宿主预装 npm 依赖（避免二进制不匹配），依赖由镜像/命令负责。
- 每次运行都会拉镜像（hosted runner 是临时的）；大镜像更慢，按需开启。
- Docker 不可用时**明确失败**（不会假装"已验证"）。
- **Agent 仍在宿主执行**，容器只负责"裁判"这一段。若 agent 必须编译才能推理，走 Mode 1/2 + 自托管 runner。
- macOS/Xcode 没有官方镜像 → 用 Mode 1/2 的 caller workflow 指定自托管 `runs-on: macos-*`，
  或像 OrzMCApp 那样给一个 Ubuntu 可跑的轻量门禁（`check-platform-split.sh`）。

### 自动探测顺序（没有 profile 时）

1. `package.json` 的 `check` → `verify` → `test` → `lint`
2. `Cargo.toml` → `cargo test`
3. `go.mod` → `go test ./...`
4. `pytest.ini` / `tox.ini` → `python -m pytest -q`
5. `Package.swift` → `swift test`
6. `gradlew` → `./gradlew check`
7. `pom.xml` → `mvn -B test`
8. `mix.exs` → `mix test`
9. 都没有 → 跳过（未验证）

### 提示词变体与语言（`promptsDir` / `locale`）

模板放在 `agent-runner/prompts/`，按「最具体优先」解析：

```
1. <promptsDir>/<locale>/<kind>.md
2. <promptsDir>/<kind>.md
3. <locale>/<kind>.md
4. <kind>.md              # en，始终存在，最终回退
```

```json
"OrzMC/OrzMCApp": { "locale": "zh-cn" },
"Acme/Strict":   { "promptsDir": "strict", "locale": "en" }
```

- 语言优先级：`AI_LOCALE`（环境/仓库变量）> 画像 `locale` > `en`。
- 变体目录优先级：`EASYGH_PROMPTS_DIR` > 画像 `promptsDir`。
- 已内置语言：`en`（根目录）、`zh-cn`（`prompts/zh-cn/`）。
- 缺什么回退什么：某语言缺某个 kind → 回退英文；不存在的语言直接回退英文。
- 不合法的 locale/目录（含 `..`、`/`、绝对路径）会被丢弃，不会当成路径用。
- 新增语言：建 `prompts/<locale>/` 放同名三个文件；测试会校验与英文的 token 集合一致。

## 4. 平台抽象（provider）

Runner 里所有"平台侧"的调用都收在 `agent-runner/src/providers/`：

```text
providers/
  types.ts     # Provider 接口 + capabilities（零文件发现/原子锁/auto-merge/草稿 PR/事故闭锁）
  github.ts    # 当前唯一实现（gh CLI + tag-ref 锁）
  index.ts     # 注册表 + resolveProvider()（EASYGH_PROVIDER，默认 github）
```

- 抽象范围：Issue 读取、标签、评论、可信评论、PR 创建、auto-merge、认领锁、事故闭锁。
- 仍未抽象（GitHub 专属，通过 capabilities 标记）：App 安装发现、workflow_dispatch、rulesets/分支保护、`ai-watch` 的 run 查询。
- 选择实现：`EASYGH_PROVIDER=gitlab`（未实现会**明确报错**，不会静默回退到 GitHub）。
- 新增平台：实现 `Provider` → 在 `providers/index.ts` 注册 → 补上该平台的"发现仓库"机制
  （GitHub 用 App installation；GitLab 可用 group token + 项目列表）。

> 目前**只实现了 GitHub**。GitLab/Gitea 留作接口，未做实际适配（按当前需求）。

## 5. 新项目接入清单

```
[ ] 触发标签 `ai` 已建（App 模式会自动补建）
[ ] 仓库画像：config/repos.json 加一条（verify 必填；否则走自动探测）
[ ] protectedPaths：把"改了必须人看"的目录写进去（CI、发布脚本、签名、生成代码…）
[ ] dependencyFiles：该项目的依赖清单（lockfile / Package.resolved / go.sum …）
[ ] macOS/Windows：设置 `runsOn`（需要对应的自托管 runner），否则只能跑 Linux 可用的门禁
[ ] 非英文项目：设置 `locale`（或仓库变量 `AI_LOCALE`），或新增 `prompts/<locale>/`
[ ] 目标仓库：allow_auto_merge + 0 批准 + 必需检查（bash scripts/enable-ai-gate.sh）
[ ] 周报：把仓库加进 EASYGH_RETRO_REPOS
[ ] 冒烟：一个 docs-only 的 `ai` Issue，确认 PR → auto-merge → Issue 关闭
```

## 6. 典型画像示例

**Node / TypeScript 库**

```json
"org/lib": {
  "verify": ["npm ci --ignore-scripts", "npm run lint && npm test"],
  "protectedPaths": [".github/", "scripts/", "src/generated/"],
  "dependencyFiles": ["package.json", "package-lock.json"]
}
```

**Rust workspace（重量级）**

```json
"org/bot": {
  "verify": ["cargo test --workspace"],
  "verifyTimeoutMs": 1500000,
  "protectedPaths": [".github/", "crates/core/src/", "migrations/"],
  "dependencyFiles": ["Cargo.toml", "Cargo.lock"]
}
```

**iOS / Swift（hub 跑 Ubuntu）**

```json
"org/app": {
  "verify": ["bash scripts/check-platform-split.sh"],
  "protectedPaths": [".github/", "scripts/", "Sources/", "*.xcodeproj/"],
  "dependencyFiles": ["Package.swift", "Package.resolved"]
}
```

**多语言 monorepo**

```json
"org/mono": {
  "verify": ["make verify"],
  "protectedPaths": [".github/", "infra/", "packages/shared/"],
  "learningsFile": "docs/agent-notes.md"
}
```

## 7. 仍然是“项目相关”的部分（有意保留）

- **提示词语气与语言**：`agent-runner/prompts/*.md` 是模板，按需改（属于流水线自身，改它需要走 PR）。
- **`docs/learnings.md` 的内容**：每个仓库自己积累，流水线不自动写。
- **标签契约**（`ai`、`ai-*`）：固定，避免每个仓库一套状态机。
- **周报/评论的语言**：目前中文；需要多语言时再加 `AI_LOCALE`。

## 8. 给 EasyGithub 自己加项目时的心态

1. 先跑**自动探测**，看它选了什么命令（日志里 `gate frozen: cmd=...`）。
2. 不可用/太慢 → 写 profile，而不是改 runner 代码。
3. 只有在"新的判定语义"出现时才改代码（例如新增一种必须人工确认的路径类型）。
4. 每次改 profile 都算"改流水线"：走 PR，`ai-core` 标签，人工审查。
