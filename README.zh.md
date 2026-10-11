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

            # ── Tier 3：免费额度优先（可选）──────────────────────────
            # 声明哪些路由是「免费额度」：优先走它们，额度用尽/报错自动换线。
            freeQuota:
              enabled: true          # 没有任何免费声明时自动失效
              routes:                # 不在 levels 里的额外免费路由
                - provider: glm
                  model: glm-4.7-flash
                  maxLevel: L1       # 这一档及以下的活可以交给它（含），默认 L1
                  reasoningEffort: off
              demoteOnError: true    # 该路由一报错即在本会话内降级到付费路由
              notify: true           # 降级时插入一次可见提示

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

### 免费额度优先（freeQuota）

很多 provider 会送免费额度（例如智谱的 `glm-4.7-flash` 长期免费），但免费通道
同时意味着**限流、额度耗尽、参数上限更严**。这一层让「免费」变成可声明的路由属性，
并在它不可用时自动换线，而不是把整轮对话做废。

声明方式有两种，可以混用：

```yaml
levels:
  L0: { provider: glm, model: glm-4.7-flash, reasoningEffort: off, freeQuota: true }
  L1: { provider: glm, model: glm-4.7-flash, reasoningEffort: low,  freeQuota: true }
  L2: { provider: deepseek-account, model: deepseek-flash, reasoningEffort: high }
  L3: { provider: deepseek-account, model: deepseek-flash, reasoningEffort: max }

# 或者：层级仍指向付费模型，另外声明免费路由来「抢」这些档位的活
freeQuota:
  routes:
    - { provider: glm, model: glm-4.7-flash, maxLevel: L1, reasoningEffort: off }
```

行为：

1. **优先**——决策落在 `maxLevel` 及以下的档位时，走声明的免费路由（免费路由
   总是带着显式 `reasoningEffort`，默认 `off`，不会掉进适配器的默认思考档）。
2. **失败即降级**——免费路由上任何一次请求失败（额度耗尽、429 限流、鉴权被拒、
   参数被拒……）都会把该路由在**本会话内**标记为已耗尽，请求立刻重试到下一跳
   可用路由（通常就是该档位原本的付费路由）。
3. **不再重试坏路由**——降级后，fallbackChain 的游走会跳过所有已耗尽的免费路由，
   同一个会话不会反复撞同一堵墙。
4. **可见**——`notify: true` 时插入一条说明「哪个免费路由、为什么、现在改用什么」
   的消息，每个会话最多一条。
5. **会话级**——降级只在当前会话内生效，下个会话重新尝试免费路由；`freeQuota`
   完全未声明时整层失效，老配置行为不变。

> 注意：免费的**视觉**模型通常有更小的输出上限（例如 `glm-4v-flash` 只允许
> `max_tokens ≤ 1024`）。这类限制要在 provider 的 `models` 条目上写 `maxTokens`
> 修正，路由器无法替你猜——遇到 `INVALID_REQUEST: max_tokens参数非法` 时按提示
> 给该模型加 `maxTokens` 即可。

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

## 配套插件：按档位拆账

`tier-cost/` 里是本仓库附带的第二个插件 **`@apinggithub/dsh-tier-cost`**：
它把会话日志按路由档位折叠成 L0–L3 的 token 与花费（金额向计费插件
`@kenz1117/dsh-ui-usage-billing` 借 per-turn 数据，本身不维护价目表），
在设置页多出一栏「档位花费」——因为四个档位常常共用同一个模型，计费面板
按模型分账时看不出是哪一档花的钱。

```bash
dsh plugin --profile desktop add ./tier-cost
```

细节见 [tier-cost/README.zh.md](tier-cost/README.zh.md)。

## License

MIT

### 上下文窗口守卫（contextGuard）

档位可声明其模型的 `contextWindow`。会话实际上下文（最近一次请求的输入侧
token，含缓存读写）超过 `window × headroom`（默认 0.85）时，**该档位被跳过**，
路由向上漂到最近的装得下的档位；没有任何声明窗口装得下时保持原档（fail-open），
让 provider 用真实错误说话、交给降级链处理。跳过每 (档位, 会话) 记录一次，
`/status` 的 `contextGuard` 字段可见。未声明任何窗口时整层不生效。

```yaml
levels:
  L0: { provider: bailian, model: qwen-max, contextWindow: 32768 }   # 小窗口模型的保护
contextGuard: { enabled: true, headroom: 0.85 }
```

## 部署到其它电脑

一台机器 = 两条命令（本仓库含两个插件）：

```powershell
git clone https://github.com/apinggithub/mydsh-auto-model-router
cd mydsh-auto-model-router; cd ..
# 宿主 0.2.x 会因插件 peer 钉死旧版本而拒装，先授予精确版本豁免（每个新版本各授一次）：
dsh plugin --profile desktop allow-version '@apinggithub/mydsh-auto-model-router@0.1.1' --dsh-version 0.2.0-rc.2 --accept-risk
dsh plugin --profile desktop add ./mydsh-auto-model-router
dsh plugin --profile desktop add ./mydsh-auto-model-router/tier-cost   # 可选：按档位拆账
```

然后在该机器的 `profiles/<profile>/cordis.patch.yml` 里写完整档位块，**provider/model 必须
是那条机器自己能用的路由，别照抄 id**：

```yaml
- id: mydsh-auto-model-router-runtime
  name: '@apinggithub/mydsh-auto-model-router'
  config:
    levels:
      L0: { provider: ..., model: ..., reasoningEffort: off,  contextWindow: ..., freeQuota: true }
      L1: { provider: ..., model: ..., reasoningEffort: low,   contextWindow: ..., freeQuota: true }
      L2: { provider: ..., model: ..., reasoningEffort: high,  contextWindow: ..., freeQuota: true }
      L3: { provider: ..., model: ..., reasoningEffort: max,   contextWindow: ... }
    contextGuard: { enabled: true, headroom: 0.85 }
    freeQuota:    { enabled: true, demoteOnError: true, notify: true }
```

⚠️ 内置默认 levels 是历史值（`deepseek-v4-flash` + `medium`），在 0.2.x 宿主上**两者都不是
合法值**——新机器必须自带档位块，否则选 Auto 会直接失败。
`tier-cost` 对宿主其余部分零依赖：缺路由插件时全部归 manual/unknown，缺计费插件时只统计
token、费用记 0，均会在面板 notes 里说明。

### 目录新鲜度守卫（modelsGuard）

模型版本升级后，provider 不再公布的 id 会变成「过期路由」。守卫在激活时与每
`refreshMs`（默认 10 分钟）用 `ctx.llm.listModels(provider)` 读取各 provider
实际公布的模型：过期档位的请求**自动漂移到最近的鲜活档位**（绝不静默打死），
状态报告列出过期档位与**同族候选 id**，改档位仍是一行编辑的事。目录读不到或
为空时一律 fail-open（不判过期）。未注册 listModels 的环境整层惰性。

```yaml
modelsGuard: { enabled: true, refreshMs: 600000 }
```

> 静态列表本身仍是配置（`cordis.patch.yml`）——这是刻意的：插件不会替你决定
> 换成哪个模型（窗口/单价/能力都变了），它只保证**坏档位不再被选中**并告诉你该换什么。

## 发布到 npm

两个插件同一仓库、各自独立发布（root 与本目录的 package.json 都可直接 publish）：

```bash
npm publish                 # @apinggithub/mydsh-auto-model-router（root）
cd tier-cost && npm publish # @apinggithub/dsh-tier-cost
```

0.2.0 起 peerDependencies 已放宽为宿主自适应范围，新机器安装**不再需要**
allow-version 豁免（豁免仅 0.1.1 及更早需要）。发布前各自 `npm login --scope=apinggithub`。
