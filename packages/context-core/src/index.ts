export type Role = "user" | "assistant"

export type SemanticType =
  | "requirement"
  | "correction"
  | "directive"
  | "final_result"
  | "question"
  | "error_attempt"
  | "intermediate"

export type TopicStatus = "hot" | "cold" | "recalled"
export type CompressionLevel = "full" | "summary" | "title" | "hidden"

export interface Turn {
  id: string
  role: Role
  content: string
  ts?: string
  semType?: SemanticType
}

export interface Topic {
  id: string
  title: string
  keywords: string[]
  summary: string
  requirement: string
  finalResultPreview: string
  lessons: string
  turns: Turn[]
  status: TopicStatus
  createdAt?: string
  updatedAt?: string
}

export interface WorkingFact {
  source: string
  content: string
  round: number
  relevance: number
  pinned: boolean
}

export interface WorkingMemorySnapshot {
  directives: string[]
  state: Record<string, unknown>
  facts: WorkingFact[]
}

export interface RelevanceWeights {
  keyword: number
  recall: number
  decay: number
}

export interface CompressionSettings {
  maxChars: number
  maxGapTurns: number
  maxKeywords: number
  levelFull: number
  levelSummary: number
  levelTitle: number
  decayHalfLifeHours: number
  weights: RelevanceWeights
}

export interface ToolCompressionOptions {
  maxTokens?: number
}

export const DEFAULT_SETTINGS: CompressionSettings = {
  maxChars: 12_000,
  maxGapTurns: 6,
  maxKeywords: 8,
  levelFull: 0.7,
  levelSummary: 0.3,
  levelTitle: 0.1,
  decayHalfLifeHours: 24,
  weights: {
    keyword: 0.5,
    recall: 0.3,
    decay: 0.2,
  },
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "it",
  "this",
  "that",
  "with",
  "as",
  "by",
  "from",
  "be",
  "have",
  "has",
  "had",
  "do",
  "does",
  "i",
  "you",
  "we",
  "they",
  "me",
  "my",
  "your",
  "的",
  "了",
  "是",
  "在",
  "和",
  "就",
  "都",
  "而",
  "及",
  "与",
  "着",
  "或",
  "一个",
  "可以",
  "帮我",
  "请",
])

const CLASSIFICATION_RULES: Array<[SemanticType, RegExp[]]> = [
  [
    "directive",
    [/以后/u, /记住/u, /永远/u, /always/i, /never/i, /from now on/i, /remember/i],
  ],
  [
    "correction",
    [/不对/u, /错了/u, /应该/u, /改成/u, /重新/u, /instead/i, /fix/i, /redo/i, /change it/i],
  ],
  [
    "requirement",
    [/帮我/u, /我想/u, /我需要/u, /实现/u, /创建/u, /写一个/u, /please/i, /help me/i, /implement/i, /create/i, /build/i, /write/i],
  ],
  [
    "question",
    [/什么是/u, /为什么/u, /怎么/u, /如何/u, /what is/i, /why/i, /how/i, /explain/i, /tell me about/i],
  ],
  [
    "error_attempt",
    [/error/i, /traceback/i, /exception/i, /failed/i, /报错/u, /失败/u, /错误/u, /异常/u],
  ],
  [
    "final_result",
    [/完成/u, /搞定/u, /成功/u, /done/i, /success/i, /completed/i, /here'?s the result/i],
  ],
]

const TOPIC_BOUNDARIES = [
  /另外/u,
  /还有/u,
  /接下来/u,
  /换个/u,
  /new topic/i,
  /by the way/i,
  /moving on/i,
  /next/i,
  /another/i,
]

const RECALL_PATTERNS = [
  /之前/u,
  /上次/u,
  /前面/u,
  /回顾/u,
  /earlier/i,
  /before/i,
  /previous/i,
  /last time/i,
  /go back/i,
  /remember when/i,
]

function estimateTokens(text: string) {
  if (!text) return 0
  return Math.max(1, Math.ceil(text.length / 4))
}

function truncateToTokens(text: string, maxTokens: number) {
  if (estimateTokens(text) <= maxTokens) return text
  const chars = Math.max(32, maxTokens * 4)
  return text.slice(0, chars).trimEnd() + "..."
}

function truncateMiddle(text: string, maxTokens: number) {
  if (estimateTokens(text) <= maxTokens) return text
  const chars = Math.max(64, maxTokens * 4)
  const head = Math.floor(chars * 0.6)
  const tail = chars - head
  return text.slice(0, head).trimEnd() + "\n...\n" + text.slice(-tail).trimStart()
}

function stableId(input: string) {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

export function extractKeywords(text: string, maxKeywords = DEFAULT_SETTINGS.maxKeywords) {
  if (!text) return []
  const words = text.toLowerCase().match(/[\u4e00-\u9fff]{2,}|[a-z_][a-z0-9_]{2,}/gi) ?? []
  const counts = new Map<string, number>()
  for (const word of words) {
    if (STOP_WORDS.has(word)) continue
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxKeywords)
    .map(([word]) => word)
}

export function classifyTurn(turn: Turn, previous?: Turn): SemanticType {
  const text = turn.content.slice(0, 500).toLowerCase()
  const errorPatterns = CLASSIFICATION_RULES.find(([type]) => type === "error_attempt")?.[1] ?? []
  if (turn.role === "user") {
    for (const [semType, patterns] of CLASSIFICATION_RULES) {
      if (patterns.some((pattern) => pattern.test(text))) return semType
    }
    return "requirement"
  }

  if (previous?.semType === "requirement" && (text.includes("```") || text.length > 300)) {
    return "final_result"
  }
  if (errorPatterns.some((pattern) => pattern.test(text))) {
    return "error_attempt"
  }
  if (previous?.semType === "error_attempt") return "error_attempt"
  if (text.includes("```") && turn.content.length > 300) return "final_result"
  if (turn.content.length < 100) return "intermediate"
  return "final_result"
}

export function classifyTurns(turns: Turn[]) {
  let previous: Turn | undefined
  return turns.map((turn) => {
    const semType = turn.semType ?? classifyTurn(turn, previous)
    const next = { ...turn, semType }
    previous = next
    return next
  })
}

function detectBoundary(next: Turn, current: Turn[], maxGapTurns: number) {
  if (next.role !== "user") return false
  if (TOPIC_BOUNDARIES.some((pattern) => pattern.test(next.content.slice(0, 200)))) return true
  if (next.semType === "requirement") {
    const lastAssistant = [...current].reverse().find((item) => item.role === "assistant")
    if (lastAssistant?.semType === "final_result") return true
  }
  return current.length >= maxGapTurns
}

function makeTopic(turns: Turn[]): Topic {
  const requirement = turns.find((turn) => turn.semType === "requirement")?.content.slice(0, 200) ?? ""
  const finalResultPreview =
    [...turns].reverse().find((turn) => turn.semType === "final_result")?.content.slice(0, 200) ?? ""
  const lessons = turns
    .filter((turn) => turn.semType === "error_attempt")
    .slice(0, 3)
    .map((turn) => turn.content.slice(0, 100))
    .join("; ")
  const title = (requirement || turns[0]?.content || "Untitled topic").slice(0, 80)
  const createdAt = turns[0]?.ts
  const updatedAt = turns[turns.length - 1]?.ts
  return {
    id: stableId(`${createdAt ?? ""}:${turns[0]?.id ?? ""}:${title}`),
    title,
    keywords: extractKeywords(requirement || title),
    summary: "",
    requirement,
    finalResultPreview,
    lessons,
    turns,
    status: "hot",
    createdAt,
    updatedAt,
  }
}

export function groupTopics(turns: Turn[], settings: Partial<CompressionSettings> = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  if (!turns.length) return []
  const classified = classifyTurns(turns)
  const topics: Topic[] = []
  let current: Turn[] = []
  for (const turn of classified) {
    if (current.length && detectBoundary(turn, current, merged.maxGapTurns)) {
      topics.push(makeTopic(current))
      current = []
    }
    current.push(turn)
  }
  if (current.length) topics.push(makeTopic(current))
  return topics
}

export function detectRecallIntent(query: string) {
  return RECALL_PATTERNS.some((pattern) => pattern.test(query))
}

function parseTime(ts?: string) {
  if (!ts) return Date.now()
  const value = Date.parse(ts)
  return Number.isFinite(value) ? value : Date.now()
}

export function computeRelevance(topic: Topic, query: string, settings: Partial<CompressionSettings> = {}, now = Date.now()) {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  if (!query.trim()) return 0.3

  const queryKeywords = new Set(extractKeywords(query, merged.maxKeywords))
  const topicKeywords = new Set(topic.keywords)

  let keywordScore = 0
  if (queryKeywords.size && topicKeywords.size) {
    const intersection = [...queryKeywords].filter((item) => topicKeywords.has(item)).length
    const union = new Set([...queryKeywords, ...topicKeywords]).size
    keywordScore = union ? intersection / union : 0
  } else if ([...topicKeywords].some((item) => query.toLowerCase().includes(item))) {
    keywordScore = 0.5
  }

  let recallScore = 0
  if (detectRecallIntent(query)) {
    recallScore = [...topicKeywords].some((item) => query.toLowerCase().includes(item)) ? 1 : 0.3
  }

  const ageHours = Math.max(0, (now - parseTime(topic.updatedAt)) / 3_600_000)
  const decayScore = Math.exp((-0.693 * ageHours) / merged.decayHalfLifeHours)

  const score =
    merged.weights.keyword * keywordScore +
    merged.weights.recall * recallScore +
    merged.weights.decay * decayScore

  return Math.min(1, score)
}

export function relevanceToLevel(score: number, settings: Partial<CompressionSettings> = {}): CompressionLevel {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  if (score >= merged.levelFull) return "full"
  if (score >= merged.levelSummary) return "summary"
  if (score >= merged.levelTitle) return "title"
  return "hidden"
}

export function summarizeTopic(topic: Topic) {
  const parts = [`[Topic: ${topic.title}]`]
  if (topic.requirement) parts.push(`Requirement: ${topic.requirement.slice(0, 150)}`)
  if (topic.finalResultPreview) parts.push(`Result: ${topic.finalResultPreview.slice(0, 150)}`)
  if (topic.lessons) parts.push(`Lessons: ${topic.lessons.slice(0, 100)}`)
  return parts.join("\n")
}

export function compressTopic(topic: Topic, level: CompressionLevel) {
  if (level === "hidden") return ""
  if (level === "title") return `[Topic: ${topic.title}]`
  if (level === "summary") return summarizeTopic(topic)

  return topic.turns
    .map((turn) => {
      let content = turn.content
      if (turn.semType === "intermediate") content = content.length > 80 ? content.slice(0, 80) + "..." : content
      if (turn.semType === "error_attempt") content = `[Error] ${content.slice(0, 150)}${content.length > 150 ? "..." : ""}`
      if (turn.role === "assistant" && content.length > 500) content = content.slice(0, 500) + "..."
      return `${turn.role === "user" ? "User" : "Assistant"}: ${content}`
    })
    .join("\n")
}

export function assembleCompressedContext(
  turns: Turn[],
  currentQuery = "",
  archivedTopics: Topic[] = [],
  settings: Partial<CompressionSettings> = {},
) {
  const merged = { ...DEFAULT_SETTINGS, ...settings }
  const hotTopics = groupTopics(turns, merged)
  const allTopics = [...archivedTopics, ...hotTopics]
  if (!allTopics.length) return ""

  const latestHotId = hotTopics.at(-1)?.id
  const scored = allTopics.map((topic) => {
    const score = topic.id === latestHotId ? 1 : computeRelevance(topic, currentQuery, merged)
    const level = relevanceToLevel(score, merged)
    return { topic, score, level }
  })

  const latest = scored.find((item) => item.topic.id === latestHotId)
  const rest = scored.filter((item) => item.topic.id !== latestHotId).sort((a, b) => b.score - a.score)

  const result: string[] = []
  let budget = merged.maxChars
  const ordered = latest ? [...rest, latest] : rest

  for (const item of ordered) {
    const candidates: CompressionLevel[] =
      item.topic.id === latestHotId ? ["full", "summary", "title"] : [item.level, "summary", "title", "hidden"]
    for (const candidate of candidates) {
      const text = compressTopic(item.topic, candidate)
      if (!text) break
      if (text.length <= budget || candidate === "title") {
        result.push(text)
        budget -= Math.min(text.length, budget)
        break
      }
    }
    if (budget <= 0) break
  }

  return result.join("\n\n")
}

function searchStyleToolName(name: string) {
  const normalized = name.toLowerCase()
  return normalized === "websearch" || normalized === "web_search" || normalized === "search"
}

function shellStyleToolName(name: string) {
  const normalized = name.toLowerCase()
  return normalized === "bash" || normalized === "batch" || normalized === "execute_shell" || normalized === "shell"
}

export function compressToolResult(raw: string, toolName: string, options: ToolCompressionOptions = {}) {
  const maxTokens = options.maxTokens ?? 1500
  if (estimateTokens(raw) <= maxTokens) return raw

  if (searchStyleToolName(toolName)) {
    const blocks = raw.split("---")
    const kept = truncateToTokens(blocks.slice(0, 5).join("---"), maxTokens)
    return blocks.length > 5 ? `${kept}\n... (${blocks.length} results total)` : kept
  }

  if (shellStyleToolName(toolName)) {
    return truncateMiddle(raw, maxTokens)
  }

  return truncateToTokens(raw, maxTokens)
}

export function createContinuationSummaryPrompt() {
  return [
    "Produce a continuation summary for the session using a compact, execution-oriented structure.",
    "Do not call tools. Respond only with plain text.",
    "",
    "Required structure:",
    "## Goal",
    "[Current user objective and acceptance target]",
    "",
    "## Constraints",
    "- [Persistent user instructions, safety constraints, platform constraints]",
    "",
    "## Active topic",
    "[What topic is still hot and why it matters now]",
    "",
    "## Archived topics",
    "- [Older topic title] :: [requirement] :: [result/lesson]",
    "",
    "## Discoveries",
    "- [Important findings worth carrying forward]",
    "",
    "## Progress",
    "- done: [completed work]",
    "- next: [immediate next step]",
    "",
    "## Files",
    "- [file or directory path] :: [why it matters]",
  ].join("\n")
}

export class WorkingMemory {
  private directives = new Set<string>()
  private state: Record<string, unknown> = {}
  private facts: WorkingFact[] = []

  addDirective(value: string) {
    if (value.trim()) this.directives.add(value.trim())
  }

  updateState(key: string, value: unknown) {
    this.state[key] = value
  }

  addFact(source: string, content: string, round: number, pinned = false) {
    this.facts = this.facts.map((fact) =>
      fact.pinned ? fact : { ...fact, relevance: Math.max(0.1, fact.relevance * 0.95) },
    )
    this.facts.push({ source, content, round, relevance: 1, pinned })
  }

  compactFacts(keepRecent = 5) {
    if (this.facts.length <= keepRecent) return
    const pinned = this.facts.filter((fact) => fact.pinned)
    const regular = this.facts.filter((fact) => !fact.pinned)
    if (regular.length <= keepRecent) return
    const recent = regular.slice(-keepRecent)
    const old = regular.slice(0, -keepRecent)
    const grouped = new Map<string, WorkingFact[]>()
    for (const fact of old) {
      const list = grouped.get(fact.source)
      if (list) list.push(fact)
      else grouped.set(fact.source, [fact])
    }
    const merged = [...grouped.entries()].map(([source, facts]) => {
      const best = facts.sort((a, b) => b.relevance - a.relevance).slice(0, 3)
      return {
        source,
        content: `[${facts.length} calls] ${best.map((item) => item.content.slice(0, 120)).join(" | ")}`,
        round: facts.at(-1)?.round ?? 0,
        relevance: 0.3,
        pinned: false,
      } satisfies WorkingFact
    })
    this.facts = [...pinned, ...merged, ...recent]
  }

  snapshot(): WorkingMemorySnapshot {
    return {
      directives: [...this.directives],
      state: { ...this.state },
      facts: [...this.facts],
    }
  }

  buildContextMessage(maxFacts = 10) {
    const parts: string[] = []
    if (this.directives.size) {
      parts.push(`## Rules\n${[...this.directives].map((item) => `- ${item}`).join("\n")}`)
    }
    if (Object.keys(this.state).length) {
      parts.push(`## Current Progress\n${JSON.stringify(this.state, null, 2)}`)
    }
    if (this.facts.length) {
      const facts = [...this.facts]
        .sort((a, b) => b.relevance - a.relevance || b.round - a.round)
        .slice(0, maxFacts)
        .map((fact) => `- [${fact.source}] ${fact.content}`)
        .join("\n")
      parts.push(`## Gathered Information\n${facts}`)
    }
    return parts.join("\n\n")
  }
}
