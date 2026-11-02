# 2026 MCP 生态调研与选题报告

> 调研时间：2026-11-02  
> 方法：官方规范/文档 + 行业调查 + 公开 Registry/GitHub/NVD 数据 + 产品横评  
> 产物：本目录下的 `ctxkeeper`（可运行的本地项目记忆与上下文打包 MCP）

---

## 0. 结论先行

1. **MCP 已经过了"要不要做"的阶段。** 官方 Registry 约 4.7 万个活跃 server，Tier-1 SDK 月下载接近 5 亿次，45% 的大型软件公司已在生产环境运行 MCP。
2. **供给严重集中在"连接器"层。** 文件系统、GitHub、浏览器、抓取、数据库、SaaS 官方 server 应有尽有；这类 server 的边际价值正在快速下降。
3. **真正稀缺的是"上下文效率"，不是"更多工具"。** 70% 的用户同时跑 2–7 个 server，工具定义本身就在吃 context；能把"读什么、读多少、记住什么"做好的 server 很少。
4. **协议正在走向无状态。** 2026-07-28 规范移除了 `initialize` 会话，改为每请求携带版本/能力，新增 `server/discover`、MRTR、tasks 扩展；状态应由 server 自己用显式句柄或持久化存储管理。
5. **因此选题不是"再做一个 GitHub/filesystem"，而是"项目级长期记忆 + token 预算内的上下文打包"。** 它减少其他 server 和内置 grep/read 的调用次数，直接命中开发者最痛的点：每次会话重新认识项目。

---

## 1. 数据面：MCP 已经不是实验

| 指标 | 数值 | 口径 / 来源 |
| --- | --- | --- |
| 官方 Registry 活跃 server | **47,267** | 每个 server 只计最新版本，2026-10-21 读取 Registry API [1] |
| TypeScript SDK npm 月下载 | **231.9M**（2026-09） | 上年同期 31.3M [1] |
| Python SDK PyPI 月下载 | **260.8M**（截至 2026-10-20 的 30 天） | 不含镜像 [1] |
| GitHub `mcp-server` 话题仓库 | **38,336** | 2026-10-21 [1] |
| 大型软件公司生产使用率 | **45%** | Stacklok 2025-12 调查 [1] |
| 安全是首要障碍 | **64%** 受访者 | 同上 [1] |
| 同时运行 2–7 个 server | **70%** | Zuplo《State of MCP》2025-12 [2] |
| 认为主要 ROI 是开发效率/省时 | **49%** | 同上 [2] |
| 预计未来 12 个月用量增加 | **72%** | 同上 [2] |
| 构建者使用 Streamable HTTP / stdio | **59% / 34%** | 同上 [2] |
| NVD 中提及 MCP 的 CVE | **382** | 截至 2026-10-21 [1] |
| 去中心化 Registry 中托管于 GitHub 的比例 | **99.16%** | 52,102 / 52,539，arXiv 安全论文 [3] |

**口径提醒**：不同来源的 server 总数差异很大（5,800 / 17,000 / 47,000），因为统计的是"官方 Registry 最新版本"、"社区目录条目"还是"GitHub 仓库"。本报告优先采用可复核的 Registry/NVD/npm 数据，并把调查类数字标注为调查结果，而不是事实计数。

一个容易被忽略的信号：**SDK 下载量（~5 亿/月）远大于 server 数量（~4.7 万）**。这说明大量团队在写**私有** MCP server，而不是只装公开 server。机会在"每个团队都有自己的上下文"，不在"再抄一个公开连接器"。

---

## 2. 六个正在流行的方向

### 2.1 远程化、无状态化、OAuth

**现象**：2026-07-28 规范是 MCP 发布以来最大的一次结构性调整 [4]：

- 移除协议级 session 和 `Mcp-Session-Id`；`tools/list` 等列表接口不再随连接变化；
- 移除 `initialize` / `notifications/initialized` 握手，版本与客户端能力放到每个请求的 `_meta`；
- 新增 `server/discover`，用于版本协商与能力发现；
- 用 `subscriptions/listen` 取代 HTTP GET + `resources/subscribe`；
- 引入 Multi Round-Trip Requests（MRTR），把 server 发起的 elicitation/sampling 改成"返回 `input_required`，客户端重试"；
- tasks 从核心移入官方扩展；
- 明确弃用 Roots、Sampling、Logging，建议用工具参数/资源 URI/`stderr` 替代。

同时，GitHub、Vercel、Linear、Notion、Supabase、Stripe、Figma、Hugging Face 等都在 2026 年提供官方远程端点 [2]。Cloudflare 称新规范下的 MCP 已在其平台承载"数十亿次工具调用" [5]。

**机会**：无状态让水平扩展、网关、缓存、审计变得可行；`ttlMs` / `cacheScope` 让列表和资源可缓存，直接降低 token 与延迟。
**风险**：远程 server 把信任边界从"本机进程"扩展到"第三方 SaaS + OAuth 令牌"，审计与权限传播成为刚需。

### 2.2 官方 SaaS 垂直连接器

**现象**：GitHub（3.3 万 star）、Playwright（3.8 万 star）、Atlassian、Stripe、Sentry、Supabase、Figma、Linear 等官方 server 占据了大部分注意力 [1][6]。它们覆盖"把某个系统接进来"的确定性需求。

**机会**：垂直深挖（领域对象、权限、写入语义）比通用连接器更有壁垒。
**风险**：平台方自己会做，第三方很难竞争；且工具数量多、schema 大，容易挤爆上下文。OpenCode 官方文档也专门提醒："MCP server 会增加 context，谨慎启用" [7]。

### 2.3 编码 agent 工具链

**现象**：MCP 采用最深的地方是开发工具 [8]。当前最实用的组合是：

- **仓库上下文**：代码知识图谱 / 语义检索（如 Graphify、Serena 类方案），减少整文件读取；
- **文档上下文**：Context7 提供版本相关的库文档，避免模型背诵过时 API；
- **浏览器 QA**：Playwright / Chrome DevTools MCP 做真实页面检查、截图、表单；
- **可观测性**：Sentry 等把线上错误直接带进修复循环；
- **基础设施**：GitHub、Vercel、Cloudflare、Supabase、Railway 负责"改完能部署"。

**机会**：不是"再做一个 GitHub"，而是做**这些工具之间的上下文层**：在调用它们之前，先知道该调用哪个、该读哪一段。
**风险**：代码索引类产品已经拥挤，且索引质量、增量更新、超大仓库性能都是硬仗。

### 2.4 上下文工程与记忆

**现象**：2026 年社区讨论的焦点从"prompt engineering"转向"context engineering"：如何选择、压缩、排序、持久化上下文。MCP 侧对应的是 memory / knowledge / RAG 类 server 的爆发，以及"session handoff"、"project memory"这类需求。

**现有方案的不足**：

- 多数 memory server 依赖向量数据库、embedding API 或云服务，安装成本和隐私成本高；
- 多数只存"对话记忆"，不存**项目决策、坑、命令、待办**；
- 多数只做检索，不做**token 预算**和**代码窗口选择**；
- 很少有 server 把"项目简报（brief）"作为一等公民，导致 agent 仍然从零开始探索。

**机会**：本地优先、零外部依赖、事件日志、brief + pack + memory 一体化。
**风险**：记忆会过期、会矛盾、会被错误写入；必须有归档、去重、`replaces`、重要度和时间衰减。

### 2.5 安全、治理与网关

**现象**：382 个 CVE、64% 的组织把安全列为首要障碍 [1]；2026 路线图把企业能力归纳为四块：审计与可观测性、企业级 SSO 鉴权、网关/代理（含授权传播与会话亲和）、配置可移植性 [8]。研究还发现 Registry 层存在失效文件链接、空内容、README 缺失等问题 [3]。

**机会**：MCP gateway、策略执行、工具白名单、输出脱敏、调用审计。
**风险**：安全产品离"个人效率"较远，且需要企业采购；个人开发者更愿意用"默认安全"的工具，而不是再装一个网关。

### 2.6 MCP 作为产品界面 / 分发渠道

**现象**：Registry、市场、Docker Catalog、客户端内置目录（Claude 995 个连接器）让 MCP 成为独立的分发面 [1]。Server 不再只是"插件"，而是产品的一部分。

**机会**：做垂直工作流（招聘、房产、财务、法律检索）的 server，可以直接触达用户。
**风险**：需要领域数据和合规能力，不是纯工程问题。

---

## 3. 供给过剩与真实缺口

把公开 server 按"它替 agent 做了什么"分类：

| 层级 | 典型能力 | 供给 | 边际价值 |
| --- | --- | --- | --- |
| L1 连接 | 读文件、调 API、查数据库、开浏览器 | 极度过剩 | 低，官方/大厂通吃 |
| L2 操作 | 部署、发 PR、改工单、跑测试 | 过剩 | 中，依赖具体平台 |
| L3 领域工作流 | 财务对账、法律检索、招聘筛选 | 稀缺 | 高，但有数据壁垒 |
| L4 上下文 | 记住项目、选对片段、控制 token、交接 | **明显不足** | **高，且通用** |

`ctxkeeper` 选择 L4，理由：

1. **通用**：任何仓库、任何语言、任何客户端都需要；
2. **可度量**：token 数、工具调用次数、首次有效操作时间都能对比；
3. **不与平台方竞争**：它让 GitHub/Playwright/Context7 更好用，而不是替代它们；
4. **本地优先**：无网络、无 Key、无云端数据落地，安装成本最低；
5. **可渐进增强**：先关键词，后续可加 embedding、增量索引、团队同步。

---

## 4. 选题对比

| 候选 | 用户价值 | 差异化 | 实现成本 | 主要风险 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 代码知识图谱 / 语义索引 | 高 | 中（已有 Graphify、Serena 类） | 高（解析器、增量、性能） | 大仓库索引质量 | 不做 |
| Windows 桌面自动化（剪贴板/窗口/截图） | 高 | 高 | 中 | 权限与误操作风险高 | 不做 |
| 文档/PDF RAG | 中 | 低（供给过剩） | 中 | 依赖解析与向量服务 | 不做 |
| **项目记忆 + 上下文打包** | **高** | **高** | **中低** | 召回质量、记忆陈旧 | **选中** |

最终产品形态：**8 个工具 + 1 个 resource + 1 个 prompt + 握手 instructions**，覆盖"进入项目 → 定位代码 → 记录决策 → 交接"的完整闭环。

---

## 5. 设计如何对应趋势

| 趋势 | `ctxkeeper` 的对应设计 |
| --- | --- |
| 无状态协议 | 状态放 `.ctxkeeper/events.jsonl`，不依赖连接 session；任何客户端随时接入 |
| 工具上下文成本 | 只暴露 8 个动词清晰的工具；描述短；列表顺序确定（利于 prompt cache） |
| 结构化/可缓存 | `project_brief` 30s 扫描缓存；brief/pack 都有 token 预算与稳定格式 |
| 安全左移 | 只读代码边界、敏感文件跳过、凭据脱敏、无任意 shell、`forget` 可恢复 |
| 上下文工程 | brief 按优先级裁剪；pack 选"词覆盖 + 命中密度"最高的窗口；记忆按重要度/时间衰减排序 |
| 可观测性 | `status` 暴露根目录、存储、计数、git、扫描上限；事件日志天然可审计 |
| 企业化 | 事件日志可导出/审计；global/project 双作用域；后续可接网关与团队同步 |

一个刻意的取舍：**不追求"记住所有对话"**。只记四类高价值信息——决策（decision）、坑（gotcha）、事实（fact）、命令（command），外加待办（todo）和笔记（note）。记忆越少、越准，brief 才越短、越有用。

---

## 6. 如何衡量它是否真的提效

建议在真实项目上记录一周：

| 指标 | 采集方式 | 目标 |
| --- | --- | --- |
| Time-to-first-useful-action | 会话开始到第一次有效编辑/命令 | 降低 30%+ |
| 工具调用次数 | 客户端日志中 `read`/`grep`/`bash` 次数 | 降低 30%+ |
| 上下文 token | 每次 brief/pack 的 estimated tokens | 稳定在 1–2k |
| 召回命中率 | `recall` 后是否直接用上 | > 70% |
| 陈旧记忆率 | brief 中被用户纠正的条目 | < 10% |
| 交接成功率 | 新会话能否复述当前状态与下一步 | > 80% |

本仓库的冒烟数据（16 文件、2.7k LOC、Windows 11 / Node 22.23）：`project_brief` ~10 ms，`context_pack` ~8–10 ms；一次 pack 约 1.0k tokens，而直接读 `src/store.ts`（430 行）约 3.5–4k tokens。样本很小，只用于验证管线，不作为基准。

---

## 7. 风险与边界

1. **召回质量**：关键词/二元组不是语义检索。缓解：`recall` 支持多关键词、类型/标签过滤；后续可加本地 embedding 兜底。
2. **记忆陈旧/矛盾**：`replaces` 归档旧决策；重要度和时间衰减降低旧条目权重；`forget` 可恢复。
3. **提示注入**：仓库内容可能包含恶意指令。工具输出应被视为数据；brief/pack 不执行任何内容。
4. **隐私**：本地存储是明文。已跳过常见敏感文件并脱敏高置信度凭据，但用户仍需避免写入密钥。
5. **并发**：追加日志 + 大小/mtime 重载适合个人多客户端；不是数据库事务。事件日志过大后需要压缩。
6. **规范演进**：2026-07-28 的无状态规范会改变 SDK 与传输层；本项目状态外置，迁移成本主要在传输适配，不在业务逻辑。
7. **大仓库**：6000 文件 / 24 MB 扫描预算会漏文件；需要增量索引后才能服务超大 monorepo。

---

## 8. 参考

1. Digital Applied, *MCP Adoption Statistics 2026: Registry, SDK and CVE Data*, 2026-10. https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol
2. Firecrawl, *10 Best MCP Servers for Developers in 2026*, 2026. https://www.firecrawl.dev/blog/best-mcp-servers-for-developers
3. *A First Look at the Security Issues in the Model Context Protocol Ecosystem*, DSN 2026 / arXiv:2510.16558. https://arxiv.org/html/2510.16558v2
4. Model Context Protocol, *Key Changes — 2026-07-28*, 2026-07. https://modelcontextprotocol.io/specification/2026-07-28/changelog
5. Cloudflare, *The next generation of MCP*, 2026-08. https://blog.cloudflare.com/mcp-v2
6. mcpservers.org, *Awesome MCP Servers*（分类与官方 server 目录）, 2026-11 访问. https://mcpservers.org/
7. OpenCode, *MCP servers*（本地/远程配置、context 成本提醒）, 2026-11 访问. https://opencode.ai/docs/mcp-servers/
8. WorkOS, *Everything your team needs to know about MCP in 2026*. https://workos.com/blog/everything-your-team-needs-to-know-about-mcp-in-2026
9. Zuplo, *State of MCP Report*, 2025-12. https://zuplo.com/mcp-report
10. Model Context Protocol, *Specification 2026-07-28*. https://modelcontextprotocol.io/specification/2026-07-28

> 注：第 1、2 条中的调查数字（45%、64%、70%、49%、59%）为调查结果，不是全量统计；第 3 条为论文抽样统计。引用时请保留口径。
