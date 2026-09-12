# mydsh-auto-model-router

一个适配 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的混合式自动模型路由插件。通过 **L0–L3 四个能力层级**为每个 agent 请求选择模型——日常问答、代码测试、编写审查、复合多步任务——支持用户可配置的成本策略、可选的 LLM 任务分类器、以及失败降级链。

> 设计思路参考 [open-world-project/model-router](https://github.com/open-world-project/model-router)（Hermes Agent）与 [opencode-model-router](https://github.com/marco-jardim/opencode-model-router)（fast/medium/heavy 分层）：层级化路由 + 成本模式决定模糊时的偏移方向。

## 致谢

本插件的思路来自以下开源项目：

- [open-world-project/model-router](https://github.com/open-world-project/model-router) — Hermes Agent 的自动模型路由器，含关键词评分和成本感知分层选择
- [opencode-model-router](https://github.com/marco-jardim/opencode-model-router) — OpenCode 的 fast/medium/heavy 分层委托插件
- [openclaw-routing-yaml](https://github.com/glasshousehq-os/openclaw-routing-yaml) — OpenClaw 的声明式 YAML 按任务路由
- [openmarkai/openclaw-router](https://github.com/openmarkai/openclaw-router) — 基于基准测试驱动的模型路由
- [MoeAisaka/openclaw-model-policy-router](https://github.com/MoeAisaka/openclaw-model-policy-router) — OpenClaw 的策略驱动 fail-closed 路由
- [NanmiCoder/dsh-auto-mode](https://github.com/NanmiCoder/dsh-auto-mode) — DSH 的自动权限模式；客户端设置页实现参考
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — 本插件所适配的宿主平台

- [English](README.md)
- 中文（本文档）

## 工作原理

```
用户消息
  │
  ▼
① agent/pre-step         任务文本 + token 记账
  │
  ▼
② system-prompt/assemble 让 {{model}} 与路由结果保持一致
  │
  ▼
③ agent/request   ★ 决策点：
  │
  ├─ Tier 1 规则：        子串 / 正则匹配 → 层级（L0…L3）——永远优先
  ├─ Tier 2 成本：        预算耗尽 → 钉到最便宜层级；
  │                      未命中规则 → 模式决定默认层级
  ├─ Tier 3 分类器：      可选便宜 LLM → 层级；层级缺模型 → 按模式漂移
  └─ Tier 4 降级：        请求失败 → 沿链切换模型并重试
  │
  ▼
LLM 分发
```

### 四个层级

| 层级 | 典型任务 | 模型建议 |
| --- | --- | --- |
| `L0` | 日常问答、快速回答 | 最便宜/最快 |
| `L1` | 小改动、简单测试 | 普通 |
| `L2` | 写代码、审查、重构 | 较强 |
| `L3` | 复杂 BUG 修复、多步任务、汇报 | 最强 |

每个层级是一个用户自行指定的 provider/model 路由，**必须**附带
`reasoningEffort`（省略时默认 `off`）：`off` = 无思考模式，`high`/`max` =
思考强度。层级可以留空不配置；路由会落到最近的已配置层级（方向由成本模式决定）。

## 模型选择框中的 Auto 模式

插件注册了一个虚拟的 `auto` provider，模型选择框会出现 **Auto Router** 分组，
内含一个 **Auto** 模型：

```
Auto Router
  └─ Auto
deepseek-official
  ├─ deepseek-v4-flash
  └─ deepseek-v4-flash
```

- 选 **Auto** → 插件接管，按 L0–L3 层级自动路由。
- 选**具体模型** → 插件原样放行，你手选的模型优先，路由不干预。

### 设置界面页签（浏览器端）

浏览器端会在 DSH 设置面板（齿轮图标 → 侧栏）注册一个 **Auto Router**
页签，展示当前路由策略——即 host 在会话开始时注入的
`<mydsh-auto-model-router-status>` 状态报告——并附提示文案：如需修改配置，
直接在对话中告诉 AI（例如"把 L2 改成 deepseek-v4-flash 且 max 思考"或
"成本模式切换为 cost-first"），AI 会帮你编辑 `cordis.patch.yml`，
重启 DSH 后生效。

在模型选择框选 **Auto** 立即生效，不再有确认弹窗。

无需额外构建步骤：`client.js` 是本仓库维护的自包含 ModuleLoader bundle
（`pnpm run build:client` 可从 `client/` 源码重新生成）。

## 安装

```bash
dsh plugin --profile web add ./mydsh-auto-model-router
```

或通过已发布的 npm 包安装：

```bash
npm install @apinggithub/mydsh-auto-model-router
dsh plugin --profile web add @apinggithub/mydsh-auto-model-router
```

## 配置

在 profile 的 `cordis.patch.yml` 中添加：

```yaml
- insert:
    - id: mydsh-auto-model-router
      name: '@deepseek-ai/cordis-plugin-group'
      group: true
      isolate:
        modelRouter: true
      config:
        - id: mydsh-auto-model-router-runtime
          name: '@apinggithub/mydsh-auto-model-router'
          config:
            # ── 四个层级（出厂默认）────────────────────────────────────
            # reasoningEffort：off = 无思考，medium/high/max = 思考强度
            levels:
              L0:                              # 日常问答
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: off
              L1:                              # 代码与测试
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: medium
              L2:                              # 编写与审查
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: high
              L3:                              # 复合多步任务
                provider: deepseek-official
                model: deepseek-v4-flash
                reasoningEffort: max

            # 关键词规则仅在全自动模式生效，默认为空
            rules: []

            # ── 模式A：字符统计锁（零延迟）────────────────────────────
            heuristic:
              windowSize: 3        # 统计最近 N 次用户输入
              counting: cjk2       # 中文计2字符/其他计1；可选 tokens
              thresholds:          # 宽度 → 层级（用户可改）
                - maxChars: 10
                  level: L0
                - maxChars: 100
                  level: L1        # 锁顶；超过 100 弹窗询问用户

            # ── 模式C：关键词积分（全自动）────────────────────────────
            scoring:
              weights:             # 每次命中积分（按层级）
                L1: 1
                L2: 2
                L3: 3
              bands:               # 积分 → 层级（用户可改）
                - maxScore: 0
                  level: L0
                - maxScore: 5
                  level: L1
                - maxScore: 15
                  level: L2
                - maxScore: null
                  level: L3

            # ── Tier 2：成本控制（用户可配置）─────────────────────────
            costControl:
              enabled: true
              mode: balanced        # cost-first | quality-first | balanced
              defaultLevel: L1      # 未命中规则时使用的层级
              tokenBudgetPerSession: 0   # 0 = 不设预算（默认）；
                                        # 设置正值即按会话封顶
              # 会话预算耗尽时的行为：
              #   silent  — 静默切到最便宜层级（不告知用户）
              #   notify  — 注入用户可见消息说明降级原因
              #   ask     — 弹窗询问；用户可选"继续用当前模型"
              #             （本会话豁免预算）
              downgradeBehavior: notify

            # ── LLM 分类器（全自动模式兜底；默认开启）───────────────────
            llmClassifier:
              enabled: true
              model:
                provider: deepseek-official
                model: deepseek-v4-flash
              requestTimeoutMs: 10000

            # 固定层级模式每 N 次用户输入重新弹窗询问
            askEveryInputs: 3

            # ── Tier 4：失败降级链（模型级）───────────────────────────
            fallbackChain:
              - provider: deepseek-official
                model: deepseek-v4-flash

            maxRetries: 1
```

### costControl 三种模式

| 模式 | 默认层级（未命中规则） | 模糊时偏移方向 |
| --- | --- | --- |
| `cost-first` | 最低已配置层级 | **向下**（更便宜） |
| `quality-first` | 最高已配置层级 | **向上**（更强） |
| `balanced` | `costControl.defaultLevel` | 不动 |

规则命中永远优先于成本模式：用户显式匹配到的层级不会被成本层降级。

### 预算降级可见

`tokenBudgetPerSession` **默认为 0（不设预算）**——成本层不会因预算耗尽而强制
降级，`downgradeBehavior` 此时不生效。设置一个正值即可开启按会话封顶：

- 例如 `tokenBudgetPerSession: 300000`：会话用满 30 万 token 后降级。
- 降级行为由 `downgradeBehavior` 控制（默认 `notify`）：
  - `notify`：注入一条用户可见消息，说明预算耗尽、剩余请求使用哪个模型、
    如何调高上限。
  - `ask`：弹窗询问"切到便宜模型还是继续用当前模型"；选"继续"则本会话
    豁免预算。
  - `silent`：静默切换（不推荐——用户会疑惑回答质量为何变化）。

### 加载时询问（无需客户端界面）

安装或热插拔插件后的**第一个会话**，DSH 会：

1. 注入一条状态汇报消息（当前层级→模型映射、成本模式、预算、降级链）。
   语言跟随 `settings.yaml` 的 `locale.preference`（`zh`/`en`，默认 `en`）。
2. 弹窗询问三个问题（每轮插件加载只问一次）：

| 问题 | 选项 |
| --- | --- |
| Q1 匹配规则 (T1) | 保持现有规则 / **查看现有规则**（注入规则清单） |
| Q2 成本模式 (T2) | 保持当前 / cost-first / balanced / quality-first（选择立即生效） |
| Q3 其他配置 | 跳过 / **检查某项配置**（输入 budget、fallbackChain、classifier 等，注入当前值） |

Q1/Q3 注入的清单与当前值让用户**决定**是否调整；持久修改仍落在
`cordis.patch.yml`（消息中会说明）。headless 或无可询问通道时自动降级为
只汇报、不询问，不会阻塞。

## 规则语法

- 纯文本：`match: 'refactor'` —— 大小写不敏感的子串匹配。
- 正则字面量：`match: '/\\bdebug\\b/'` —— 首尾斜杠界定正则，末尾可加标志（如 `/.../i`）。
- 规则**按顺序**求值，第一个命中生效。
- `match` 可匹配用户消息文本、工具调用结果文本，或会话 `cwd`（以 `cwd:<path>` 匹配）。

## 挂载点

| DSH 事件 | 作用 |
| --- | --- |
| `agent/session-start` | 重置每会话路由状态 |
| `agent/pre-step` | token 记账（预算跟踪） |
| `system-prompt/assemble` | 保持 `{{model}}` 提示词变量一致 |
| `agent/request` | **路由决策点** —— 替换 provider/model |
| `agent/request-error` | 降级链 → `{ kind: 'retry' }` |
| `session/event` | 从 assistant 消息统计 token 消耗 |

## 测试

```bash
npm test        # node --test *.test.mjs
```

无需外部服务——所有层级均以 fixture 做单元测试。

## 已知问题

- **全自动模式延迟**：开启 LLM 分类器后，每个新用户输入的第一步会增加一次分类器调用（LLM 请求）。虽然同一输入内的后续步骤已缓存、无额外开销，但多步任务的整体响应时间仍比直接选择模型慢。欢迎贡献优化方案——例如跨会话缓存分类结果，或用轻量启发式作为 LLM 分类的前置过滤。

## License

MIT
