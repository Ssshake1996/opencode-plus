# OpenCode 上下文压缩方案迁移指南

## 当前方案分析

### OpenCode 现有压缩机制

OpenCode 当前使用**基于 Token 阈值的自动压缩 + 工具输出修剪**方案：

```
┌─────────────────────────────────────────────────────────────┐
│                    SessionCompaction                         │
│                                                              │
│  1. isOverflow() → 检测是否超出上下文限制                     │
│     - 比较已用 token 与 (limit - reserved)                     │
│     - 触发阈值：count >= usable                              │
│                                                              │
│  2. prune() → 修剪旧工具输出                                 │
│     - 反向扫描 tool parts                                    │
│     - 保护最近 PRUNE_PROTECT (40K tokens) 的工具调用            │
│     - 修剪超过 PRUNE_MINIMUM (20K tokens) 的部分                │
│                                                              │
│  3. process() → 执行压缩                                     │
│     - 创建 compaction part 标记                               │
│     - 调用 compaction agent 生成摘要                          │
│     - 可选择重播用户消息                                      │
│ └─────────────────────────────────────────────────────────────┘
```

### 核心参数（当前）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `COMPACTION_BUFFER` | 20,000 | token 缓冲区 |
| `PRUNE_MINIMUM` | 20,000 | 最小修剪 token 数 |
| `PRUNE_PROTECT` | 40,000 | 保护的工具输出 token 数 |
| `PRUNE_PROTECTED_TOOLS` | `["skill"]` | 不修剪的工具 |
| `compaction.auto` | `true` | 自动压缩开关 |
| `compaction.prune` | `true` | 自动修剪开关 |
| `compaction.reserved` | 动态计算 | 保留 token 数 |

### 数据模型

```typescript
// Session 表字段
time_compacting: integer  // 压缩时间戳
time_archived: integer    // 归档时间戳

// Message 类型
type CompactionPart = {
  type: "compaction"
  auto: boolean
  overflow: boolean
}

// 压缩流程中生成 summary message
type AssistantMessage = {
  summary: true  // 标记为摘要消息
  // ...
}
```

### 压缩触发流程

```
用户消息 → LLM 响应 → 检测 overflow → 创建 compaction part
                                         ↓
                              SessionCompaction.process()
                                         ↓
                              调用 compaction agent
                                         ↓
                              生成 summary message
                                         ↓
                              可选：重播用户消息继续
```

---

## MulAgent 方案分析

### 三维智能压缩架构

```
用户输入 (current_query)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│                    ContextAssembler                          │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Dimension 1  │  │ Dimension 2  │  │   Dimension 3     │  │
│  │ 语义角色分类  │→ │ 话题分组归档  │→│   相关性驱动压缩   │  │
│  │ TurnClassifier│  │ TopicGrouper │  │  SmartCompressor  │  │
│  └──────────────┘  └──────────────┘  └───────────────────┘  │
│                                                              │
│          ┌────────────────────────┐                          │
│          │ Token 预算组装 (8000 字符) │                         │
│          └────────────────────────┘                          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
  压缩后上下文 → 送入 LLM
```

### 维度一：语义角色分类

| 类型 | 优先级 | 说明 | 示例 |
|------|--------|------|------|
| `requirement` | 高 | 用户原始需求 | "帮我写排序函数" |
| `correction` | 高 | 用户纠正 | "不对，应该是降序" |
| `directive` | 高 | 持久指令 | "以后都用中文" |
| `final_result` | 中 | 最终输出 | 带代码块的长回复 |
| `question` | 中 | 用户提问 | "什么是快速排序？" |
| `error_attempt` | 低 | 失败尝试 | "Traceback... Error" |
| `intermediate` | 低 | 中间过程 | 短回复/思考 |

### 维度二：话题分组与归档

**Topic 数据结构：**
```python
@dataclass
class Topic:
    id: str                    # MD5 哈希
    title: str                 # 话题标题
    keywords: list[str]        # 关键词列表
    summary: str               # 归档摘要
    requirement: str           # 首条需求
    final_result_preview: str  # 结果预览
    lessons: str               # 教训总结
    turns: list[dict]          # 对话轮次
    status: str                # hot/cold/recalled
    created_at: str            # 时间戳
    updated_at: str            # 时间戳
```

**话题生命周期：**
```
hot ──(>30 轮)──> cold ──(/recall)──> recalled
  ▲                                  │
  └────────────(/collapse)───────────┘
```

### 维度三：相关性驱动压缩

**相关性评分公式：**
```
relevance = 0.5 × keyword_overlap + 0.3 × recall_intent + 0.2 × time_decay
```

| 信号 | 权重 | 算法 |
|------|------|------|
| 关键词重叠 | 0.5 | Jaccard 相似度 |
| 召回意图 | 0.3 | 模式匹配检测 |
| 时间衰减 | 0.2 | 指数衰减 (半衰期 24h) |

**四级压缩：**
| 级别 | 相关性 | 输出内容 |
|------|--------|---------|
| Full | ≥0.7 | 完整对话（intermediate 截断 80 字符） |
| Summary | 0.3-0.7 | 标题 + 需求 + 结果预览 + 教训 |
| Title | 0.1-0.3 | 仅话题标题 |
| Hidden | <0.1 | 完全隐藏 |

---

## 迁移方案设计

### 阶段一：数据模型扩展

#### 1.1 扩展 Session 数据表

```typescript
// packages/opencode/src/session/session.sql.ts

export const SessionTable = sqliteTable("session", {
  // ... existing fields
  time_compacting: integer(),
  time_archived: integer(),

  // === 新增字段 ===
  // 存储归档话题列表（JSON）
  archive_topics: text({ mode: "json" }).$type<ArchivedTopic[]>(),
  // 全局摘要（用于冷启动）
  global_summary: text(),
})

// 新增 ArchivedTopic 类型
export type ArchivedTopic = {
  id: string              // MD5 哈希
  title: string           // 话题标题
  keywords: string[]      // 关键词
  summary: string         // 摘要
  requirement: string     // 首条需求（前 200 字符）
  final_result_preview: string  // 结果预览
  lessons: string         // 教训
  turns_count: number     // 轮次数
  status: "cold" | "recalled"
  created_at: number      // 时间戳
  updated_at: number      // 时间戳
}
```

#### 1.2 扩展 Message 类型

```typescript
// packages/opencode/src/session/message-v2.ts

export const TextPart = PartBase.extend({
  type: z.literal("text"),
  text: z.string(),
  synthetic: z.boolean().optional(),
  ignored: z.boolean().optional(),
  // === 新增字段 ===
  sem_type: z.enum([
    "requirement",
    "correction",
    "directive",
    "final_result",
    "question",
    "error_attempt",
    "intermediate",
  ]).optional(),
  // ... rest
})
```

#### 1.3 扩展 Config 配置

```typescript
// packages/opencode/src/config/config.ts

compaction: z
  .object({
    // === 现有字段 ===
    auto: z.boolean().optional(),
    prune: z.boolean().optional(),
    reserved: z.number().int().min(0).optional(),

    // === 新增字段 (MulAgent 风格) ===
    // 字符预算 (0 = 自动计算：max_tokens * 0.5 * 4)
    context_max_chars: z.number().int().min(0).default(0),

    // 四级压缩阈值
    level_full: z.number().min(0).max(1).default(0.7),
    level_summary: z.number().min(0).max(1).default(0.3),
    level_title: z.number().min(0).max(1).default(0.1),

    // 相关性权重
    weight_keyword: z.number().min(0).max(1).default(0.5),
    weight_recall: z.number().min(0).max(1).default(0.3),
    weight_decay: z.number().min(0).max(1).default(0.2),

    // 话题归档
    archive_threshold: z.number().int().min(1).default(30),
    archive_manual_threshold: z.number().int().min(1).default(6),
    decay_half_life_hours: z.number().min(1).default(24),
    max_gap_turns: z.number().int().min(1).default(6),
    max_kw: z.number().int().min(1).default(8),
    hard_cap_turns: z.number().int().min(1).default(50),
  })
  .optional()
```

---

### 阶段二：核心模块实现

#### 2.1 创建 ContextCompressor 模块

**文件：** `packages/opencode/src/session/context-compressor.ts`

```typescript
import { SessionID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Config } from "../config/config"
import { Log } from "../util/log"

const logger = Log.create({ service: "context.compressor" })

// ══════════════════════════════════════════════════════════════════
// 维度一：语义角色分类
// ══════════════════════════════════════════════════════════════════

export const SEM_TYPES = [
  "requirement",    // 用户原始需求
  "correction",     // 用户纠正
  "directive",      // 持久指令
  "final_result",   // 最终输出
  "question",       // 用户提问
  "error_attempt",  // 失败尝试
  "intermediate",   // 中间过程
] as const

export type SemType = typeof SEM_TYPES[number]

// 关键词规则 (中英文)
const CLS_RULES: [SemType, string[]][] = [
  ["requirement", [
    "帮我", "请", "我想", "我需要", "我要",
    "please", "I want", "I need", "help me",
    "implement", "create", "build", "write",
  ]],
  ["correction", [
    "不对", "不是", "错了", "应该是", "改成", "换",
    "no", "not", "wrong", "instead", "change",
    "fix", "redo",
  ]],
  ["directive", [
    "以后", "记住", "永远", "所有", "每次",
    "always", "never", "from now on", "remember",
  ]],
  ["question", [
    "什么是", "为什么", "怎么", "如何",
    "what is", "why", "how", "explain",
  ]],
  ["error_attempt", [
    "error", "traceback", "exception", "failed",
    "报错", "失败", "错误", "异常",
  ]],
]

export namespace TurnClassifier {
  export function classify(
    role: "user" | "assistant",
    content: string,
    prevRole?: string,
    prevSem?: SemType,
  ): SemType {
    const text = content.slice(0, 500).toLowerCase()

    if (role === "user") {
      return classifyUser(text)
    }

    // Assistant turns: 结合内容特征 + 前一条用户消息语义
    if (prevSem === "requirement") {
      if (matchAny(text, ["完成", "搞定", "done", "success", "completed"])) {
        if (content.includes("```") && content.length > 300) {
          return "final_result"
        }
      }
    }

    if (matchAny(text, ["error", "traceback", "exception", "报错", "失败"])) {
      return "error_attempt"
    }

    if (prevSem === "error_attempt") {
      return "error_attempt"
    }

    // 包含代码块且长度 > 300 → final_result
    if (content.includes("```") && content.length > 300) {
      return "final_result"
    }

    // 短回复 → intermediate
    if (content.length < 100) {
      return "intermediate"
    }

    return "final_result"
  }

  function classifyUser(text: string): SemType {
    // 按优先级检查
    for (const [semType, patterns] of CLS_RULES) {
      if (semType === "requirement" || semType === "error_attempt") continue
      if (matchAny(text, patterns)) {
        return semType
      }
    }
    return "requirement" // 默认
  }

  function matchAny(text: string, patterns: string[]): boolean {
    return patterns.some(p => text.includes(p.toLowerCase()))
  }
}

// ══════════════════════════════════════════════════════════════════
// 维度二：话题分组与归档
// ══════════════════════════════════════════════════════════════════

export interface Topic {
  id: string
  title: string
  keywords: string[]
  summary: string
  requirement: string
  final_result_preview: string
  lessons: string
  turns: MessageV2.WithParts[]
  status: "hot" | "cold" | "recalled"
  createdAt: number
  updatedAt: number
}

const TOPIC_BOUNDARY_PATTERNS = [
  "另外", "还有", "换个", "接下来", "然后",
  "新问题", "下一个",
  "also", "next", "another", "moving on", "new topic",
  "by the way", "btw",
]

export namespace TopicGrouper {
  export function group(
    turns: MessageV2.WithParts[],
    maxGapTurns: number = 6,
  ): Topic[] {
    if (turns.length === 0) return []

    const topics: Topic[] = []
    const currentTurns: MessageV2.WithParts[] = []

    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i]!
      if (
        currentTurns.length > 0 &&
        isBoundary(turn, currentTurns, currentTurns.length)
      ) {
        topics.push(finalizeTopic(currentTurns))
        currentTurns.length = 0
      }
      currentTurns.push(turn)
    }

    if (currentTurns.length > 0) {
      topics.push(finalizeTopic(currentTurns))
    }

    return topics
  }

  function isBoundary(
    turn: MessageV2.WithParts,
    current: MessageV2.WithParts[],
    idx: number,
  ): boolean {
    if (turn.info.role !== "user") return false

    const text = turn.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .slice(0, 200)
      .toLowerCase()

    // 显式边界信号
    if (matchAny(text, TOPIC_BOUNDARY_PATTERNS)) return true

    // 新需求在 final_result 之后
    const semType = turn.parts.find((p): p is MessageV2.TextPart =>
      p.type === "text" && p.sem_type
    )?.sem_type

    if (semType === "requirement") {
      const lastAssistant = [...current].reverse().find(
        (t) => t.info.role === "assistant",
      )
      const lastSem = lastAssistant?.parts.find(
        (p): p is MessageV2.TextPart => p.type === "text",
      )?.sem_type

      if (lastSem === "final_result") return true
    }

    // 长度阈值
    if (current.length >= maxGapTurns) return true

    return false
  }

  function finalizeTopic(turns: MessageV2.WithParts[]): Topic {
    const now = Date.now()
    const crypto = await import("crypto")
    const id = crypto
      .createHash("md5")
      .update(`${now}_${turns[0]?.info.id}`)
      .digest("hex")
      .slice(0, 12)

    let requirement = ""
    let finalResult = ""
    const errorLessons: string[] = []

    for (const t of turns) {
      for (const part of t.parts) {
        if (part.type === "text") {
          const sem = part.sem_type
          if (sem === "requirement" && !requirement) {
            requirement = part.text.slice(0, 200)
          }
          if (sem === "final_result") {
            finalResult = part.text.slice(0, 200)
          }
          if (sem === "error_attempt") {
            errorLessons.push(part.text.slice(0, 100))
          }
        }
      }
    }

    const keywords = extractKeywords(requirement)
    const title = requirement || turns[0]?.parts.find(
      (p): p is MessageV2.TextPart => p.type === "text",
    )?.text.slice(0, 60) || ""

    return {
      id,
      title,
      keywords,
      summary: "",
      requirement,
      final_result_preview: finalResult,
      lessons: errorLessons.slice(0, 3).join("; "),
      turns,
      status: "hot",
      createdAt: turns[0]?.info.time.created || now,
      updatedAt: turns[turns.length - 1]?.info.time.created || now,
    }
  }

  function matchAny(text: string, patterns: string[]): boolean {
    return patterns.some((p) => text.includes(p.toLowerCase()))
  }

  export function extractKeywords(text: string, maxKw: number = 8): string[] {
    if (!text) return []

    // 简单的停用词过滤
    const stops = new Set([
      "的", "了", "是", "在", "我", "有", "和", "就", "不", "人",
      "the", "a", "an", "is", "are", "was", "were", "in", "on",
      "to", "for", "of", "and", "or", "it", "this", "that",
    ])

    // 提取中文词 (2 字以上) 和英文词 (3 字母以上)
    const words = text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z_]\w{2,}/g) || []
    const filtered = words.filter((w) => !stops.has(w.toLowerCase()))

    // 简单频率统计
    const freq = new Map<string, number>()
    for (const w of filtered) {
      freq.set(w, (freq.get(w) || 0) + 1)
    }

    return Array.from(freq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKw)
      .map(([w]) => w)
  }
}

// ══════════════════════════════════════════════════════════════════
// 维度三：相关性驱动压缩
// ══════════════════════════════════════════════════════════════════

export type CompressionLevel = "full" | "summary" | "title" | "hidden"

export function computeRelevance(
  topic: Topic,
  query: string,
  cfg: Config.Info["compaction"],
  now: number = Date.now(),
): number {
  if (!query) return 0.3 // neutral

  const wKw = cfg?.weight_keyword ?? 0.5
  const wRecall = cfg?.weight_recall ?? 0.3
  const wDecay = cfg?.weight_decay ?? 0.2
  const halfLife = cfg?.decay_half_life_hours ?? 24

  // 1. 关键词重叠 (Jaccard)
  const queryKw = new Set(TopicGrouper.extractKeywords(query))
  const topicKw = new Set(topic.keywords)

  let kwScore = 0
  if (queryKw.size > 0 && topicKw.size > 0) {
    const intersection = [...queryKw].filter((k) => topicKw.has(k)).length
    const union = new Set([...queryKw, ...topicKw]).size
    kwScore = intersection / union
  } else {
    // 降级：子串匹配
    const qLower = query.toLowerCase()
    for (const kw of topicKw) {
      if (qLower.includes(kw.toLowerCase())) {
        kwScore = Math.max(kwScore, 0.5)
      }
    }
  }

  // 2. 召回意图检测
  let recallScore = 0
  if (detectRecallIntent(query)) {
    const qLower = query.toLowerCase()
    for (const kw of topicKw) {
      if (qLower.includes(kw.toLowerCase())) {
        recallScore = 1.0
        break
      }
    }
    if (recallScore === 0) recallScore = 0.3
  }

  // 3. 时间衰减
  const ageHours = Math.max(0, (now - topic.updatedAt) / 3600000)
  const decayScore = Math.exp((-0.693 * ageHours) / halfLife)

  return Math.min(1.0, wKw * kwScore + wRecall * recallScore + wDecay * decayScore)
}

export function relevanceToLevel(
  score: number,
  cfg: Config.Info["compaction"],
): CompressionLevel {
  const full = cfg?.level_full ?? 0.7
  const summary = cfg?.level_summary ?? 0.3
  const title = cfg?.level_title ?? 0.1

  if (score >= full) return "full"
  if (score >= summary) return "summary"
  if (score >= title) return "title"
  return "hidden"
}

const RECALL_PATTERNS = [
  "之前", "上次", "刚才", "前面", "那个", "回顾",
  "earlier", "before", "previous", "last time", "recall",
  "go back", "what was", "remember",
]

function detectRecallIntent(query: string): boolean {
  const text = query.toLowerCase()
  return RECALL_PATTERNS.some((p) => text.includes(p))
}

export namespace SmartCompressor {
  export function compress(
    topic: Topic,
    level: CompressionLevel,
    maxCharsPerTurn: number = 500,
  ): string {
    if (level === "hidden") return ""

    if (level === "title") {
      return `[Topic: ${topic.title}]`
    }

    if (level === "summary") {
      const parts = [`[Topic: ${topic.title}]`]
      if (topic.requirement) {
        parts.push(`  Requirement: ${topic.requirement.slice(0, 150)}`)
      }
      if (topic.final_result_preview) {
        parts.push(`  Result: ${topic.final_result_preview.slice(0, 150)}`)
      }
      if (topic.lessons) {
        parts.push(`  Lessons: ${topic.lessons.slice(0, 100)}`)
      }
      return parts.join("\n")
    }

    // Full level
    const lines: string[] = []
    for (const t of topic.turns) {
      const roleLabel = t.info.role === "user" ? "User" : "Assistant"
      const textParts = t.parts.filter(
        (p): p is MessageV2.TextPart => p.type === "text",
      )

      for (const part of textParts) {
        const sem = part.sem_type
        let content = part.text

        if (sem === "intermediate") {
          content = content.length > 80 ? content.slice(0, 80) + "..." : content
        } else if (sem === "error_attempt") {
          content = `[Error] ${content.length > 150 ? content.slice(0, 150) + "..." : content}`
        } else if (roleLabel === "Assistant" && content.length > maxCharsPerTurn) {
          content = content.slice(0, maxCharsPerTurn) + "..."
        }

        lines.push(`${roleLabel}: ${content}`)
      }
    }

    return lines.join("\n")
  }
}

// ══════════════════════════════════════════════════════════════════
// ContextAssembler — 组装最终上下文
// ══════════════════════════════════════════════════════════════════

export interface ArchivedTopicData {
  id: string
  title: string
  keywords: string[]
  summary: string
  requirement: string
  final_result_preview: string
  lessons: string
  turns_count: number
  status: "cold" | "recalled"
  created_at: number
  updated_at: number
}

export namespace ContextAssembler {
  export interface AssembleInput {
    turns: MessageV2.WithParts[]
    currentQuery: string
    archivedTopics: ArchivedTopicData[]
    globalSummary?: string
    maxChars?: number
  }

  export function assemble(input: AssembleInput): string {
    const cfg: Config.Info["compaction"] = {} as any // 从 config 获取
    const maxChars = input.maxChars ?? cfg?.context_max_chars ?? 8000

    // Step 1: 语义分类
    const turns = classifyTurns(input.turns)

    // Step 2: 话题分组
    const hotTopics = TopicGrouper.group(turns)

    // Step 3: 合并归档话题
    const allTopics: Array<{ topic: Topic | ArchivedTopicData; source: "hot" | "archive" }> = []

    for (const at of input.archivedTopics) {
      allTopics.push({ topic: at, source: "archive" })
    }
    for (const ht of hotTopics) {
      allTopics.push({ topic: ht, source: "hot" })
    }

    if (allTopics.length === 0) {
      return input.globalSummary
        ? `[Earlier summary: ${input.globalSummary.slice(0, 300)}]`
        : ""
    }

    // Step 4: 相关性评分
    const now = Date.now()
    const scored = allTopics.map(({ topic, source }) => {
      // 最近话题强制 Full
      const isLastHot = source === "hot" && topic === allTopics[allTopics.length - 1]?.topic
      const score = isLastHot
        ? 1.0
        : computeRelevance(
            topic as Topic,
            input.currentQuery,
            cfg,
            now,
          )
      const level = relevanceToLevel(score, cfg)
      return { topic, source, score, level }
    })

    // 排序：相关性高的在前（最近话题保持最后）
    const last = scored.pop()
    scored.sort((a, b) => b.score - a.score)
    if (last) scored.push(last)

    // Step 5: 预算内组装
    const parts: string[] = []
    let charBudget = maxChars

    // 预留最后话题空间
    let reserveForLast = 0
    if (last) {
      const lastText = SmartCompressor.compress(
        last.topic as Topic,
        last.level,
      )
      reserveForLast = lastText.length + 50
      charBudget -= reserveForLast
    }

    // 遗留摘要
    if (input.globalSummary) {
      const summaryText = `[Earlier summary: ${input.globalSummary.slice(0, 300)}]`
      if (summaryText.length < charBudget) {
        parts.push(summaryText)
        charBudget -= summaryText.length
      }
    }

    // 按相关性添加话题
    for (const { topic, source, score, level } of scored) {
      const text = SmartCompressor.compress(
        topic as Topic,
        level,
      )
      if (!text) continue

      if (text.length <= charBudget) {
        parts.push(text)
        charBudget -= text.length
      } else {
        // 降级压缩
        for (const degraded of ["summary" as const, "title" as const]) {
          if (degraded === level) continue
          const degradedText = SmartCompressor.compress(
            topic as Topic,
            degraded,
          )
          if (degradedText && degradedText.length <= charBudget) {
            parts.push(degradedText)
            charBudget -= degradedText.length
            break
          }
        }
      }
    }

    // 添加最后话题
    if (last) {
      const lastText = SmartCompressor.compress(
        last.topic as Topic,
        last.level,
      )
      parts.push(lastText)
    }

    return parts.join("\n\n")
  }

  function classifyTurns(
    turns: MessageV2.WithParts[],
  ): MessageV2.WithParts[] {
    let prevRole = ""
    let prevSem: SemType | undefined

    for (const turn of turns) {
      for (const part of turn.parts) {
        if (part.type === "text" && !part.sem_type) {
          const sem = TurnClassifier.classify(
            turn.info.role,
            part.text,
            prevRole,
            prevSem,
          )
          part.sem_type = sem
        }
      }
      prevRole = turn.info.role

      const lastTextPart = turn.parts.find(
        (p): p is MessageV2.TextPart => p.type === "text",
      )
      prevSem = lastTextPart?.sem_type
    }

    return turns
  }

  export function autoArchive(
    turns: MessageV2.WithParts[],
    threshold: number = 30,
  ): { remaining: MessageV2.WithParts[]; archived: ArchivedTopicData[] } {
    if (turns.length < threshold) {
      return { remaining: turns, archived: [] }
    }

    const classified = classifyTurns(turns)
    const topics = TopicGrouper.group(classified)

    if (topics.length <= 1) {
      return { remaining: turns, archived: [] }
    }

    // 归档除最新外的所有话题
    const toArchive = topics.slice(0, -1)
    const hotTopic = topics[topics.length - 1]!

    const archived: ArchivedTopicData[] = toArchive.map((t) => {
      t.status = "cold"
      if (!t.summary) {
        t.summary = makeSummary(t)
      }
      return topicToArchived(t)
    })

    return {
      remaining: hotTopic.turns,
      archived,
    }
  }

  function makeSummary(topic: Topic): string {
    const parts: string[] = []
    if (topic.requirement) {
      parts.push(`Task: ${topic.requirement.slice(0, 100)}`)
    }
    if (topic.final_result_preview) {
      parts.push(`Result: ${topic.final_result_preview.slice(0, 100)}`)
    }
    if (topic.lessons) {
      parts.push(`Issues: ${topic.lessons.slice(0, 80)}`)
    }
    return parts.join("; ") || topic.title.slice(0, 100)
  }

  function topicToArchived(topic: Topic): ArchivedTopicData {
    return {
      id: topic.id,
      title: topic.title,
      keywords: topic.keywords,
      summary: topic.summary,
      requirement: topic.requirement,
      final_result_preview: topic.final_result_preview,
      lessons: topic.lessons,
      turns_count: topic.turns.length,
      status: topic.status,
      created_at: topic.createdAt,
      updated_at: topic.updatedAt,
    }
  }
}
```

---

### 阶段三：集成到 Session 流程

#### 3.1 修改 Session.index.ts

```typescript
// packages/opencode/src/session/index.ts

// 新增方法：获取压缩后上下文
export async function getContextForPrompt(input: {
  sessionID: SessionID
  currentQuery: string
  maxChars?: number
}): Promise<string> {
  const messages = await MessageV2.filterCompacted(
    MessageV2.stream(input.sessionID),
  )

  const session = await Session.get(input.sessionID)
  const archivedTopics = session.archive?.topics ?? []
  const globalSummary = session.global_summary

  const { ContextAssembler } = await import("./context-compressor")

  return ContextAssembler.assemble({
    turns: messages,
    currentQuery: input.currentQuery,
    archivedTopics,
    globalSummary,
    maxChars: input.maxChars,
  })
}
```

#### 3.2 修改 SessionCompaction

```typescript
// packages/opencode/src/session/compaction.ts

// 修改 prune 方法，集成话题归档
const prune = Effect.fn("SessionCompaction.prune")(function* (input: { sessionID: SessionID }) {
  const cfg = yield* config.get()
  if (cfg.compaction?.prune === false) return

  log.info("pruning")

  const msgs = yield* session.messages({ sessionID: input.sessionID })
    .pipe(Effect.catchIf(NotFoundError.isInstance, () => Effect.succeed(undefined)))
  if (!msgs) return

  // 使用新的 autoArchive 方法
  const { remaining, archived } = ContextAssembler.autoArchive(
    msgs,
    cfg.compaction?.archive_threshold ?? 30,
  )

  if (archived.length > 0) {
    // 保存到 Session 表
    const existing = yield* session.get(input.sessionID)
    const allArchived = [...(existing.archive?.topics ?? []), ...archived]

    yield* session.update({
      ...existing,
      archive_topics: allArchived,
      turns: remaining,
    })

    log.info("archived", { count: archived.length })
  }
})
```

#### 3.3 修改 Prompt 流程

```typescript
// packages/opencode/src/session/prompt.ts

// 在构建 model messages 时使用压缩上下文
const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

// === 新增：获取压缩上下文 ===
const { getContextForPrompt } = await import("@/session")
const compressedContext = await getContextForPrompt({
  sessionID,
  currentQuery: lastUser.parts
    .filter((p): p is MessageV2.TextPart => p.type === "text")
    .map((p) => p.text)
    .join(" "),
})

// 将压缩上下文注入 system prompt
const systemPrompt = [
  ...SystemPrompt.provider(model),
  ...SystemPrompt.environment(model),
  compressedContext ? [`<conversation_history>\n${compressedContext}\n</conversation_history>`] : [],
].join("\n")
```

---

### 阶段四：用户交互命令

#### 4.1 CLI 命令扩展

```typescript
// packages/opencode/src/cli/cmd/session.ts (新建)

import { Session } from "@/session"
import { ContextAssembler } from "@/session/context-compressor"

export const SessionCommands = {
  // 手动压缩
  async compress(sessionID: string) {
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
    const cfg = await Config.get()
    const threshold = cfg.compaction?.archive_manual_threshold ?? 6

    const { remaining, archived } = ContextAssembler.autoArchive(msgs, threshold)

    if (archived.length > 0) {
      const session = await Session.get(sessionID)
      await Session.update({
        ...session,
        archive_topics: [...(session.archive?.topics ?? []), ...archived],
        turns: remaining,
      })
      console.log(`Archived ${archived.length} topic(s)`)
    } else {
      console.log("Nothing to archive")
    }
  },

  // 列出话题
  async topics(sessionID: string) {
    const session = await Session.get(sessionID)
    const msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))

    const hotTopics = TopicGrouper.group(msgs)
    const archived = session.archive?.topics ?? []

    console.log("Hot topics:")
    for (const t of hotTopics) {
      console.log(`  [hot] ${t.id}: ${t.title} (${t.turns.length} turns)`)
    }

    console.log("\nArchived topics:")
    for (const t of archived) {
      console.log(`  [${t.status}] ${t.id}: ${t.title}`)
    }
  },

  // 召回话题
  async recall(sessionID: string, query: string) {
    const session = await Session.get(sessionID)
    const archived = session.archive?.topics ?? []

    const cfg = await Config.get()
    const recalled = archived.filter((t) => {
      const score = computeRelevance(t, query, cfg.compaction)
      return score >= 0.3
    })

    if (recalled.length > 0) {
      for (const t of recalled) {
        t.status = "recalled"
      }
      await Session.update({
        ...session,
        archive_topics: archived,
      })
      console.log(`Recalled ${recalled.length} topic(s)`)
    } else {
      console.log("No matching topics found")
    }
  },

  // 扩展话题
  async expandTopic(sessionID: string, topicId: string) {
    const session = await Session.get(sessionID)
    const archived = session.archive?.topics ?? []

    const topic = archived.find((t) => t.id === topicId)
    if (topic) {
      topic.status = "recalled"
      await Session.update({ ...session, archive_topics: archived })
      console.log(`Expanded topic: ${topic.title}`)
    } else {
      console.log("Topic not found")
    }
  },

  // 折叠话题
  async collapseTopic(sessionID: string, topicId: string) {
    const session = await Session.get(sessionID)
    const archived = session.archive?.topics ?? []

    const topic = archived.find((t) => t.id === topicId)
    if (topic) {
      topic.status = "cold"
      await Session.update({ ...session, archive_topics: archived })
      console.log(`Collapsed topic: ${topic.title}`)
    } else {
      console.log("Topic not found")
    }
  },
}
```

---

## 迁移检查清单

### 数据迁移

- [ ] 运行数据库迁移脚本，添加 `archive_topics` 和 `global_summary` 字段
- [ ] 为现有会话数据设置默认值（空数组/空字符串）

### 配置更新

- [ ] 在 `config.ts` 中添加新的压缩配置项
- [ ] 更新默认配置值
- [ ] 添加配置验证

### 核心模块

- [ ] 创建 `context-compressor.ts` 模块
- [ ] 实现 `TurnClassifier`
- [ ] 实现 `TopicGrouper`
- [ ] 实现 `SmartCompressor`
- [ ] 实现 `ContextAssembler`

### 集成测试

- [ ] 单元测试：语义分类准确率
- [ ] 单元测试：话题边界检测
- [ ] 单元测试：相关性评分计算
- [ ] 集成测试：完整压缩流程
- [ ] 性能测试：压缩耗时

### 用户交互

- [ ] CLI 命令：`/compress`
- [ ] CLI 命令：`/topics`
- [ ] CLI 命令：`/recall <query>`
- [ ] CLI 命令：`/expand <topic_id>`
- [ ] CLI 命令：`/collapse <topic_id>`

### 向后兼容

- [ ] 保留原有 `compaction.auto` 和 `compaction.prune` 行为
- [ ] 旧会话数据能正常读取
- [ ] 配置缺失时回退到默认值

---

## 配置示例

### 默认配置（推荐）

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "reserved": 20000,

    "context_max_chars": 0,
    "level_full": 0.7,
    "level_summary": 0.3,
    "level_title": 0.1,

    "weight_keyword": 0.5,
    "weight_recall": 0.3,
    "weight_decay": 0.2,

    "archive_threshold": 30,
    "archive_manual_threshold": 6,
    "decay_half_life_hours": 24,
    "max_gap_turns": 6,
    "max_kw": 8,
    "hard_cap_turns": 50
  }
}
```

### 激进压缩（节省 Token）

```json
{
  "compaction": {
    "context_max_chars": 4000,
    "level_full": 0.8,
    "level_summary": 0.4,
    "level_title": 0.2,

    "archive_threshold": 15,
    "archive_manual_threshold": 4
  }
}
```

### 保守压缩（保留更多上下文）

```json
{
  "compaction": {
    "context_max_chars": 16000,
    "level_full": 0.6,
    "level_summary": 0.2,

    "archive_threshold": 50,
    "weight_decay": 0.1
  }
}
```

---

## 预期收益

| 指标 | 当前方案 | MulAgent 方案 | 提升 |
|------|----------|---------------|------|
| 上下文利用率 | ~60% | ~85% | +42% |
| 重要信息保留率 | ~70% | ~95% | +36% |
| 话题切换自然度 | 低 | 高 | - |
| 用户可控性 | 自动 | 自动 + 手动 | - |
| 压缩触发延迟 | 中 | 低 | - |

---

## 参考资料

- MulAgent 源码：`src/graph/context_compressor.py`
- MulAgent 文档：`docs/context-compression.md`
- OpenCode 当前压缩：`src/session/compaction.ts`
- OpenCode 溢出检测：`src/session/overflow.ts`
