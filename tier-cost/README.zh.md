# dsh-tier-cost

按**路由档位（L0–L3）**拆账的小插件，配合
[`@apinggithub/mydsh-auto-model-router`](../README.zh.md) 使用。

自动路由会把每次请求派发到不同档位的模型上，计费面板虽然能按**模型**分账，
但如果你把四个档位都指向同一个模型（只靠思考强度区分，这是推荐配置），
**费用就会挤在同一行里，看不出是哪个档位花的钱**。本插件补上这一维。

## 它怎么算

```
会话日志（每个 assistant/message 的 usage）
        │  按它前面最近一条 request/header.config 的 provider/model/effort
        ▼
路由插件的档位表  ──▶  每个 turn 归属到 L0/L1/L2/L3/free/manual/unknown
        │
        ▼
计费插件 /api/billing/usage-stats 的 byTurn  ──▶  按 (sessionId, turn) 连接金额
        │
        ▼
GET /api/tier-cost/usage  ──▶  设置页「档位花费」一栏
```

- **Token 自己数**：从会话日志里读，不依赖别的插件。
- **金额向计费插件借**：`@kenz1117/dsh-ui-usage-billing` 若在场，按其 per-turn
  费用连接（含峰谷/缓存单价），本插件不维护价目表，因此不会和面板打架；
  它不在场时只统计 token，费用列为 ¥0 并给出提示。
- **档位表向路由插件借**：读 `/api/mydsh-auto-model-router/status` 的
  `levels` + `freeQuota`，因此改配置后无需重装本插件。

## 归集口径

| 桶 | 含义 |
| --- | --- |
| `L0`–`L3` | 命中路由插件档位表的请求（先按 provider+model+effort 精确匹配，再退化为 provider+model） |
| `free` | 由 `freeQuota.routes` 声明的免费路由（不在档位表里） |
| `manual` | 你手动选了真实模型，路由插件没参与 |
| `unknown` | 档位表存在但没匹配上（标题生成、压缩等旁路调用） |

**已知口径限制**：如果两个档位的 provider/model/effort 完全相同，日志里无从分辨，
会归到其中较低的那一档——所以请让各档位至少在思考强度或模型上有所区别。

## 安装

```bash
dsh plugin --profile desktop add ./tier-cost
```

## 配置

```yaml
- id: dsh-tier-cost
  name: '@apinggithub/dsh-tier-cost'
  config:
    sessionsDir: null      # 默认 <DSH_HOME>/sessions（或 ~/.dsh/sessions）
    baseUrl: null          # 默认用请求的 Host 头推回环地址，反代场景可显式指定
    cacheMs: 10000         # 档位表 / 计费数据的缓存时长
    timeoutMs: 15000       # 读取上层插件接口的超时
    includeSubagents: true # 是否把子代理会话也计入（默认计入）
```

## 接口

```
GET /api/tier-cost/usage
```

返回 `{ ok, generatedAt, turns, sessionLogs, levels:{L0..}, totals, costPriced,
costPartial, levelTable, levelLabels, notes }`。只接受回环请求。

## 测试

```bash
node --test *.test.mjs
```

## License

MIT
