/**
 * Three-dimensional intelligent context compression
 *
 * Dimension 1 — Semantic Role Classification:
 *   Classifies each turn as requirement/correction/error_attempt/
 *   final_result/intermediate/directive/question
 *
 * Dimension 2 — Topic-based Archiving:
 *   Detects topic boundaries, groups related turns, archives cold topics
 *   while keeping hot topics in context
 *
 * Dimension 3 — Relevance-driven Dynamic Compression:
 *   Computes per-topic relevance using keyword overlap, recall-intent detection,
 *   and time decay. Four compression levels: Full | Summary | Title | Hidden
 */

import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { Config } from "../config/config"
import crypto from "crypto"

const logger = Log.create({ service: "context.compressor" })

// ══════════════════════════════════════════════════════════════════
// Dimension 1 — Semantic Turn Classification
// ══════════════════════════════════════════════════════════════════

export const SEM_TYPES = [
  "requirement",    // user's original request or goal
  "correction",     // user correcting / redirecting assistant
  "directive",      // persistent rule ("always use Chinese")
  "final_result",   // confirmed successful output
  "question",       // user asking for info (non-task)
  "error_attempt",  // failed attempt or error output
  "intermediate",   // thinking / partial progress
] as const

export type SemType = typeof SEM_TYPES[number]

// Keywords/patterns for classification (Chinese + English)
const CLS_RULES: [SemType, string[]][] = [
  ["requirement", [
    "帮我", "请", "我想", "我需要", "我要", "能不能", "能否",
    "please", "I want", "I need", "help me", "could you",
    "implement", "create", "build", "write",
  ]],
  ["correction", [
    "不对", "不是", "错了", "应该是", "改成", "换", "不要", "别", "重新", "修改",
    "no", "not", "wrong", "instead", "change",
    "fix", "redo",
  ]],
  ["directive", [
    "以后", "记住", "永远", "所有", "每次",
    "always", "never", "from now on", "remember",
  ]],
  ["question", [
    "什么是", "为什么", "怎么", "如何", "是什么",
    "what is", "why", "how", "explain", "tell me",
  ]],
  ["error_attempt", [
    "error", "traceback", "exception", "failed",
    "报错", "失败", "错误", "异常",
  ]],
]

export namespace TurnClassifier {
  /**
   * Classify a single turn by its semantic role
   */
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

    // Assistant turns: infer from content + preceding user sem_type
    if (prevSem === "requirement") {
      if (matchAny(text, ["完成", "搞定", "done", "success", "completed", "here's"])) {
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

    // Long assistant content with code blocks → likely final result
    if (content.includes("```") && content.length > 300) {
      return "final_result"
    }

    // Short assistant reply → intermediate
    if (content.length < 100) {
      return "intermediate"
    }

    return "final_result"
  }

  function classifyUser(text: string): SemType {
    // Check in priority order (directive > correction > requirement > question)
    for (const [semType, patterns] of CLS_RULES) {
      if (semType === "requirement" || semType === "error_attempt") continue
      if (matchAny(text, patterns)) {
        return semType
      }
    }
    return "requirement" // default for user turns
  }

  function matchAny(text: string, patterns: string[]): boolean {
    return patterns.some(p => text.includes(p.toLowerCase()))
  }
}

// ══════════════════════════════════════════════════════════════════
// Dimension 2 — Topic Grouping & Archiving
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

// Signals that a new topic is starting
const TOPIC_BOUNDARY_PATTERNS = [
  "另外", "还有", "换个", "接下来", "然后",
  "新问题", "下一个",
  "also", "next", "another", "moving on", "new topic",
  "by the way", "btw",
]

export namespace TopicGrouper {
  /**
   * Detect topic boundaries and group turns into Topics
   */
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
        isBoundary(turn, currentTurns, maxGapTurns)
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
    maxGapTurns: number,
  ): boolean {
    if (turn.info.role !== "user") return false

    const text = turn.parts
      .filter((p): p is MessageV2.TextPart => p.type === "text")
      .map((p) => p.text)
      .join(" ")
      .slice(0, 200)
      .toLowerCase()

    // Explicit boundary signals
    if (matchAny(text, TOPIC_BOUNDARY_PATTERNS)) return true

    // New requirement after a final_result in the current group
    const semType = turn.parts.find(
      (p): p is MessageV2.TextPart => p.type === "text" && p.sem_type,
    )?.sem_type

    if (semType === "requirement") {
      const lastAssistant = [...current].reverse().find(
        (t) => t.info.role === "assistant",
      )
      const lastTextPart = lastAssistant?.parts.find(
        (p): p is MessageV2.TextPart => p.type === "text",
      )
      if (lastTextPart?.sem_type === "final_result") return true
    }

    // Length threshold
    if (current.length >= maxGapTurns) return true

    return false
  }

  function finalizeTopic(turns: MessageV2.WithParts[]): Topic {
    const now = Date.now()
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
    const title = requirement ||
      turns[0]?.parts.find((p): p is MessageV2.TextPart => p.type === "text")?.text.slice(0, 60) ||
      ""

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

  /**
   * Extract keywords from text using simple word frequency
   */
  export function extractKeywords(text: string, maxKw: number = 8): string[] {
    if (!text) return []

    // Common stop words (CN + EN)
    const stops = new Set([
      "的", "了", "是", "在", "我", "有", "和", "就", "不", "人",
      "都", "一", "这", "中", "大", "为", "上", "个", "来", "也",
      "到", "说", "要", "与",
      "the", "a", "an", "is", "are", "was", "were", "in", "on", "at",
      "to", "for", "of", "and", "or", "it", "this", "that", "with",
      "as", "by", "from", "be", "have", "has", "had", "do", "does",
      "i", "you", "he", "she", "we", "they", "me", "my", "your",
    ])

    // Extract Chinese words (2+ chars) and English words (3+ letters)
    const words = text.match(/[\u4e00-\u9fff]{2,}|[a-zA-Z_]\w{2,}/g) || []
    const filtered = words.filter((w) => !stops.has(w.toLowerCase()))

    // Frequency-based selection
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
// Dimension 3 — Relevance-driven Dynamic Compression
// ══════════════════════════════════════════════════════════════════

export type CompressionLevel = "full" | "summary" | "title" | "hidden"

/**
 * Compute relevance score of a topic to the current query
 *
 * Three signals (weights from config):
 * 1. Keyword overlap (Jaccard similarity)
 * 2. Recall intent detection
 * 3. Time decay
 */
export function computeRelevance(
  topic: Topic | ArchivedTopicData,
  query: string,
  cfg: Config.Info["compaction"],
  now: number = Date.now(),
): number {
  if (!query) return 0.3 // neutral

  const wKw = cfg?.weight_keyword ?? 0.5
  const wRecall = cfg?.weight_recall ?? 0.3
  const wDecay = cfg?.weight_decay ?? 0.2
  const halfLife = cfg?.decay_half_life_hours ?? 24

  // 1. Keyword overlap (Jaccard)
  const queryKw = new Set(TopicGrouper.extractKeywords(query))
  const topicKw = new Set(topic.keywords)

  let kwScore = 0
  if (queryKw.size > 0 && topicKw.size > 0) {
    const intersection = [...queryKw].filter((k) => topicKw.has(k)).length
    const union = new Set([...queryKw, ...topicKw]).size
    kwScore = intersection / union
  } else {
    // Fallback: substring match on title/requirement
    const qLower = query.toLowerCase()
    const title = "title" in topic ? topic.title : topic.title
    const requirement = "requirement" in topic ? topic.requirement : ""

    for (const kw of topicKw) {
      if (qLower.includes(kw.toLowerCase()) ||
          title.toLowerCase().includes(kw.toLowerCase()) ||
          requirement.toLowerCase().includes(kw.toLowerCase())) {
        kwScore = Math.max(kwScore, 0.5)
      }
    }
  }

  // 2. Recall intent detection
  let recallScore = 0
  if (detectRecallIntent(query)) {
    const qLower = query.toLowerCase()
    for (const kw of topicKw) {
      if (qLower.includes(kw.toLowerCase())) {
        recallScore = 1.0
        break
      }
    }
    if (recallScore === 0) recallScore = 0.3 // general recall intent
  }

  // 3. Time decay (exponential with half-life)
  const topicTime = "updated_at" in topic ? topic.updated_at : topic.updatedAt
  const ageHours = Math.max(0, (now - topicTime) / 3600000)
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

// ══════════════════════════════════════════════════════════════════
// SmartCompressor — Produces compressed output per compression level
// ══════════════════════════════════════════════════════════════════

export namespace SmartCompressor {
  /**
   * Compress a topic according to its compression level
   */
  export function compress(
    topic: Topic | ArchivedTopicData,
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

    // Full level — include all turns but compress intermediates
    const lines: string[] = []
    const turns = "turns" in topic ? topic.turns : []

    for (const t of turns) {
      const roleLabel = t.info.role === "user" ? "User" : "Assistant"
      const textParts = t.parts.filter(
        (p): p is MessageV2.TextPart => p.type === "text",
      )

      for (const part of textParts) {
        const sem = part.sem_type
        let content = part.text

        if (sem === "intermediate") {
          // Collapse intermediate turns
          content = content.length > 80 ? content.slice(0, 80) + "..." : content
        } else if (sem === "error_attempt") {
          // Keep first 150 chars + lesson marker
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
// ContextAssembler — Assemble final context within token budget
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
  expanded?: boolean
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

  /**
   * Assemble compressed context for the LLM prompt
   *
   * Steps:
   * 1. Classify turns by semantic role
   * 2. Group into topics
   * 3. Merge with archived topics
   * 4. Compute relevance and assign compression levels
   * 5. Assemble within budget
   */
  export function assemble(input: AssembleInput): string {
    const cfg: Config.Info["compaction"] = {} as any
    const maxChars = input.maxChars ?? cfg?.context_max_chars ?? 8000

    // Step 1: Classify turns
    const turns = classifyTurns(input.turns)

    // Step 2: Group into topics
    const maxGapTurns = cfg?.max_gap_turns ?? 6
    const hotTopics = TopicGrouper.group(turns, maxGapTurns)

    // Step 3: Merge with archived topics
    interface ScoredTopic {
      topic: Topic | ArchivedTopicData
      source: "hot" | "archive"
      score: number
      level: CompressionLevel
    }

    const allTopics: ScoredTopic[] = []

    for (const at of input.archivedTopics) {
      if (at.status === "recalled") {
        allTopics.push({ topic: at, source: "archive", score: 0, level: "full" })
      }
    }
    for (const ht of hotTopics) {
      allTopics.push({ topic: ht, source: "hot", score: 0, level: "full" })
    }

    if (allTopics.length === 0) {
      return input.globalSummary
        ? `[Earlier summary: ${input.globalSummary.slice(0, 300)}]`
        : ""
    }

    // Step 4: Compute relevance and assign compression levels
    const now = Date.now()
    const lastHotIndex = allTopics.findLastIndex((t) => t.source === "hot")

    for (let i = 0; i < allTopics.length; i++) {
      const item = allTopics[i]!
      // Most recent hot topic always gets full treatment
      const isLastHot = i === lastHotIndex
      item.score = isLastHot
        ? 1.0
        : computeRelevance(item.topic, input.currentQuery, cfg, now)
      item.level = relevanceToLevel(item.score, cfg)
    }

    // Sort: highest relevance first (but keep most recent hot topic last)
    const last = allTopics.pop()
    allTopics.sort((a, b) => b.score - a.score)
    if (last) allTopics.push(last)

    // Step 5: Assemble within budget
    const parts: string[] = []
    let charBudget = maxChars

    // Reserve space for the last (most recent) topic
    let reserveForLast = 0
    if (last) {
      const lastText = SmartCompressor.compress(last.topic, last.level)
      reserveForLast = lastText.length + 50
      charBudget -= reserveForLast
    }

    // Add legacy summary if present
    if (input.globalSummary) {
      const summaryText = `[Earlier summary: ${input.globalSummary.slice(0, 300)}]`
      if (summaryText.length < charBudget) {
        parts.push(summaryText)
        charBudget -= summaryText.length
      }
    }

    // Add topics by relevance (degrade if over budget)
    for (const { topic, source, score, level } of allTopics) {
      const text = SmartCompressor.compress(topic, level)
      if (!text) continue

      if (text.length <= charBudget) {
        parts.push(text)
        charBudget -= text.length
      } else {
        // Degrade compression level
        for (const degraded of ["summary" as const, "title" as const]) {
          if (degraded === level) continue
          const degradedText = SmartCompressor.compress(topic, degraded)
          if (degradedText && degradedText.length <= charBudget) {
            parts.push(degradedText)
            charBudget -= degradedText.length
            break
          }
        }
      }
    }

    // Add the most recent topic last
    if (last) {
      const lastText = SmartCompressor.compress(last.topic, last.level)
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

  /**
   * Archive old topics when turns exceed threshold
   *
   * Returns remaining hot turns and newly archived topic data
   */
  export function autoArchive(
    turns: MessageV2.WithParts[],
    threshold: number = 30,
  ): { remaining: MessageV2.WithParts[]; archived: ArchivedTopicData[] } {
    if (turns.length < threshold) {
      return { remaining: turns, archived: [] }
    }

    const classified = classifyTurns(turns)
    const maxGapTurns = Config.getSync?.()?.compaction?.max_gap_turns ?? 6
    const topics = TopicGrouper.group(classified, maxGapTurns)

    if (topics.length <= 1) {
      return { remaining: turns, archived: [] }
    }

    // Archive all topics except the most recent one
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

  /**
   * Find and mark archived topics that match a recall query
   * @returns Array of topics that match the query (score >= threshold)
   */
  export function recallTopic(
    archivedTopics: ArchivedTopicData[],
    query: string,
    threshold: number = 0.3,
  ): ArchivedTopicData[] {
    if (!archivedTopics.length || !query) return []

    const cfg: Config.Info["compaction"] = {} as any
    const now = Date.now()
    const recalled: ArchivedTopicData[] = []

    for (const topic of archivedTopics) {
      const score = computeRelevance(topic, query, cfg, now)
      if (score >= threshold) {
        topic.status = "recalled"
        recalled.push(topic)
        logger.info("Recalled topic", { id: topic.id, title: topic.title, score })
      }
    }

    return recalled
  }

  /**
   * List all topics (hot + archived) with their status
   */
  export function listTopics(
    turns: MessageV2.WithParts[],
    archivedTopics: ArchivedTopicData[] = [],
  ): Array<{
    id: string
    title: string
    status: "hot" | "cold" | "recalled"
    turns_count: number
    requirement: string
  }> {
    const classified = classifyTurns(turns)
    const hotTopics = TopicGrouper.group(classified)

    const result: Array<{
      id: string
      title: string
      status: "hot" | "cold" | "recalled"
      turns_count: number
      requirement: string
    }> = []

    for (const t of archivedTopics) {
      result.push({
        id: t.id,
        title: t.title,
        status: t.status,
        turns_count: t.turns_count,
        requirement: t.requirement,
      })
    }

    for (const t of hotTopics) {
      result.push({
        id: t.id,
        title: t.title,
        status: "hot",
        turns_count: t.turns.length,
        requirement: t.requirement,
      })
    }

    return result
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
      expanded: false,
      created_at: topic.createdAt,
      updated_at: topic.updatedAt,
    }
  }

  /**
   * Check if context compression should be triggered
   * Returns true if current context exceeds threshold
   */
  export function shouldTriggerCompression(
    turns: MessageV2.WithParts[],
    archivedTopics: ArchivedTopicData[] = [],
    config?: Config.Info["compaction"],
  ): boolean {
    const threshold = config?.archive_threshold ?? 30
    const hardCap = config?.hard_cap_turns ?? 50

    const totalTurns = turns.length

    // Hard cap - always compress
    if (totalTurns >= hardCap) return true

    // Auto threshold
    if (config?.auto && totalTurns >= threshold) return true

    return false
  }

  /**
   * Auto-archive old topics when turns exceed threshold
   * Returns true if archiving was performed
   */
  export function autoArchiveIfNeeded(
    turns: MessageV2.WithParts[],
    archivedTopics: ArchivedTopicData[] = [],
    config?: Config.Info["compaction"],
  ): { shouldArchive: boolean; remaining: MessageV2.WithParts[]; archived: ArchivedTopicData[] } {
    if (!shouldTriggerCompression(turns, archivedTopics, config)) {
      return { shouldArchive: false, remaining: turns, archived: [] }
    }

    const result = autoArchive(turns, config?.archive_threshold)
    return {
      shouldArchive: true,
      remaining: result.remaining,
      archived: result.archived,
    }
  }
}
