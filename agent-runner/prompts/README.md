# 提示词模板

```
prompts/
  bug-fix.md  feature.md  review.md     # en（默认，始终存在）
  zh-cn/                                # 简体中文变体
  <variant>/                            # 可选：按项目/技术栈定制
    bug-fix.md feature.md review.md
    <locale>/                           # 变体内的语言子目录
```

## 选择顺序（命中即用）

1. `<promptsDir>/<locale>/<kind>.md` — 项目变体 + 指定语言
2. `<promptsDir>/<kind>.md` — 项目变体 + 默认语言
3. `<locale>/<kind>.md` — 共享模板 + 指定语言
4. `<kind>.md` — 共享模板 + 默认语言（`en`）

- `locale`：环境变量 `AI_LOCALE`，否则仓库画像里的 `locale`，否则 `en`。
  取值形如 `zh-cn`、`zh-CN`、`en`；未知语言自动回退英文。
- `promptsDir`：环境变量 `EASYGH_PROMPTS_DIR`，否则画像里的 `promptsDir`（相对本目录）。
- 变量：`{{repo}}` `{{issue_number}}` `{{title}}` `{{url}}` `{{labels}}` `{{branch}}` `{{provider}}` `{{model}}` `{{body}}`。
- 新增语言：新建 `<locale>/` 并放同名三个文件；缺哪个回退到英文。
