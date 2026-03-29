import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import {
  TurnClassifier,
  SEM_TYPES,
  TopicGrouper,
  Topic,
  computeRelevance,
  relevanceToLevel,
  SmartCompressor,
  ContextAssembler,
  type CompressionLevel,
  type ArchivedTopicData,
} from "../../src/session/context-compressor"

// Helper to create mock turns
function createTurn(
  role: "user" | "assistant",
  text: string,
  semType?: typeof SEM_TYPES[number],
  time?: number,
): MessageV2.WithParts {
  const id = MessageID.ascending()
  const sessionID = SessionID.generate()
  return {
    info: {
      id,
      sessionID,
      role,
      agent: "build",
      model: { providerID: "test", modelID: "test" },
      time: { created: time || Date.now() },
    },
    parts: [
      {
        id: PartID.ascending(),
        sessionID,
        messageID: id,
        type: "text",
        text,
        sem_type: semType,
      },
    ],
  }
}

// ══════════════════════════════════════════════════════════════════
// TurnClassifier Tests
// ══════════════════════════════════════════════════════════════════

describe("context-compressor.TurnClassifier", () => {
  describe("classify user turns", () => {
    test("classifies requirement in Chinese", () => {
      expect(TurnClassifier.classify("user", "帮我写一个快速排序函数")).toBe("requirement")
    })

    test("classifies requirement in English", () => {
      expect(TurnClassifier.classify("user", "Please implement a sorting function")).toBe("requirement")
    })

    test("classifies correction in Chinese", () => {
      expect(TurnClassifier.classify("user", "不对，应该是升序排列")).toBe("correction")
    })

    test("classifies correction in English", () => {
      expect(TurnClassifier.classify("user", "No, that's wrong. It should be ascending")).toBe("correction")
    })

    test("classifies directive in Chinese", () => {
      expect(TurnClassifier.classify("user", "以后都用中文回答")).toBe("directive")
    })

    test("classifies directive in English", () => {
      expect(TurnClassifier.classify("user", "Always use TypeScript from now on")).toBe("directive")
    })

    test("classifies question in Chinese", () => {
      expect(TurnClassifier.classify("user", "什么是快速排序？")).toBe("question")
    })

    test("classifies question in English", () => {
      expect(TurnClassifier.classify("user", "What is quicksort?")).toBe("question")
    })

    test("defaults to requirement for unknown input", () => {
      expect(TurnClassifier.classify("user", "你好")).toBe("requirement")
    })
  })

  describe("classify assistant turns", () => {
    test("classifies final_result with code block", () => {
      const content = "```python\ndef sort(arr):\n    return sorted(arr)\n```\n这是排序函数的实现。" + "x".repeat(300)
      expect(TurnClassifier.classify("assistant", content, "user", "requirement")).toBe("final_result")
    })

    test("classifies error_attempt", () => {
      expect(TurnClassifier.classify("assistant", "error: traceback in module X")).toBe("error_attempt")
    })

    test("classifies error_attempt after user error", () => {
      expect(TurnClassifier.classify("assistant", "Let me fix this", "user", "error_attempt")).toBe("error_attempt")
    })

    test("classifies short reply as intermediate", () => {
      expect(TurnClassifier.classify("assistant", "OK, let me try.")).toBe("intermediate")
    })

    test("classifies long reply without code as final_result", () => {
      expect(TurnClassifier.classify("assistant", "x".repeat(300))).toBe("final_result")
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// TopicGrouper Tests
// ══════════════════════════════════════════════════════════════════

describe("context-compressor.TopicGrouper", () => {
  describe("group turns into topics", () => {
    test("single topic for related turns", () => {
      const turns = [
        createTurn("user", "帮我写排序"),
        createTurn("assistant", "```python\ndef sort(): pass\n```", "final_result"),
      ]
      const topics = TopicGrouper.group(turns)
      expect(topics).toHaveLength(1)
      expect(topics[0].title).toContain("帮我写排序")
    })

    test("splits on explicit boundary", () => {
      const turns = [
        createTurn("user", "帮我写排序"),
        createTurn("assistant", "done", "final_result"),
        createTurn("user", "另外，帮我写搜索"),
        createTurn("assistant", "search done", "final_result"),
      ]
      const topics = TopicGrouper.group(turns)
      expect(topics).toHaveLength(2)
    })

    test("splits after final_result + new requirement", () => {
      const turns = [
        createTurn("user", "帮我写排序"),
        createTurn("assistant", "sorted()", "final_result"),
        createTurn("user", "帮我写搜索"),
        createTurn("assistant", "search()", "final_result"),
      ]
      const topics = TopicGrouper.group(turns)
      expect(topics).toHaveLength(2)
    })

    test("splits on max gap turns", () => {
      const turns: MessageV2.WithParts[] = []
      for (let i = 0; i < 14; i++) {
        turns.push(
          createTurn(
            i % 2 === 0 ? "user" : "assistant",
            i % 2 === 0 ? `msg ${i}` : `reply ${i}`,
            i % 2 === 0 ? "requirement" : "intermediate",
          ),
        )
      }
      const topics = TopicGrouper.group(turns, 6)
      expect(topics.length).toBeGreaterThanOrEqual(2)
    })

    test("returns empty array for empty input", () => {
      expect(TopicGrouper.group([])).toEqual([])
    })
  })

  describe("finalizeTopic", () => {
    test("extracts requirement from first user turn", () => {
      const turns = [
        createTurn("user", "帮我写一个降序排序函数"),
        createTurn("assistant", "```python\ndef sort_desc(): ...\n```", "final_result"),
      ]
      const topics = TopicGrouper.group(turns)
      expect(topics[0].requirement).toContain("降序排序")
    })

    test("extracts final_result_preview", () => {
      const turns = [
        createTurn("user", "帮我写排序"),
        createTurn("assistant", "```python\ndef sort(): ...\n```", "final_result"),
      ]
      const topics = TopicGrouper.group(turns)
      expect(topics[0].final_result_preview).toContain("def sort")
    })

    test("generates topic ID", () => {
      const turns = [createTurn("user", "test")]
      const topics = TopicGrouper.group(turns)
      expect(topics[0].id).toHaveLength(12)
    })

    test("extracts keywords from requirement", () => {
      const turns = [createTurn("user", "实现一个快速排序算法，使用 Python 语言")]
      const topics = TopicGrouper.group(turns)
      expect(topics[0].keywords.length).toBeGreaterThan(0)
    })
  })
})

describe("context-compressor.TopicGrouper.extractKeywords", () => {
  test("extracts Chinese keywords", () => {
    const keywords = TopicGrouper.extractKeywords("实现一个快速排序算法，使用 Python 语言")
    expect(keywords.some((kw) => kw.includes("排序") || kw.toLowerCase().includes("python"))).toBe(true)
  })

  test("extracts English keywords", () => {
    const keywords = TopicGrouper.extractKeywords("implement a binary search tree in JavaScript")
    expect(keywords.some((kw) => ["binary", "search", "javascript"].includes(kw.toLowerCase()))).toBe(true)
  })

  test("returns empty array for empty input", () => {
    expect(TopicGrouper.extractKeywords("")).toEqual([])
  })

  test("filters stop words", () => {
    const keywords = TopicGrouper.extractKeywords("这是一个很好的功能")
    expect(keywords).not.toContain("的")
    expect(keywords).not.toContain("是")
  })
})

// ══════════════════════════════════════════════════════════════════
// Relevance Computation Tests
// ══════════════════════════════════════════════════════════════════

describe("context-compressor.relevance", () => {
  const createTopic = (overrides?: Partial<Topic | ArchivedTopicData>): Topic => ({
    id: "test",
    title: "排序函数实现",
    keywords: ["排序", "函数", "降序"],
    summary: "",
    requirement: "帮我写一个降序排序函数",
    final_result_preview: "def sort_desc(arr): ...",
    lessons: "",
    turns: [],
    status: "hot",
    createdAt: Date.now() - 3600000,
    updatedAt: Date.now() - 1800000,
    ...overrides,
  })

  describe("computeRelevance", () => {
    test("high relevance for keyword match", () => {
      const topic = createTopic()
      const score = computeRelevance(topic, "帮我修改排序函数", {})
      expect(score).toBeGreaterThan(0.5)
    })

    test("low relevance for unrelated query", () => {
      const topic = createTopic()
      const score = computeRelevance(topic, "今天的天气怎么样", {})
      expect(score).toBeLessThan(0.5)
    })

    test("boosts relevance for recall intent with keyword match", () => {
      const topic = createTopic()
      const score = computeRelevance(topic, "之前那个排序函数怎么写的", {})
      expect(score).toBeGreaterThan(0.6)
    })

    test("time decay reduces relevance for old topics", () => {
      const oldTopic = createTopic({
        updatedAt: Date.now() - 48 * 3600000, // 48 hours ago
      })
      const newTopic = createTopic({
        updatedAt: Date.now() - 3600000, // 1 hour ago
      })

      const oldScore = computeRelevance(oldTopic, "排序", {})
      const newScore = computeRelevance(newTopic, "排序", {})

      expect(newScore).toBeGreaterThan(oldScore)
    })

    test("returns neutral score for empty query", () => {
      const topic = createTopic()
      const score = computeRelevance(topic, "", {})
      expect(score).toBeCloseTo(0.3, 1)
    })
  })

  describe("relevanceToLevel", () => {
    test("returns full for score >= 0.7", () => {
      expect(relevanceToLevel(0.8, {})).toBe("full")
      expect(relevanceToLevel(0.7, {})).toBe("full")
    })

    test("returns summary for score 0.3-0.7", () => {
      expect(relevanceToLevel(0.5, {})).toBe("summary")
      expect(relevanceToLevel(0.3, {})).toBe("summary")
    })

    test("returns title for score 0.1-0.3", () => {
      expect(relevanceToLevel(0.2, {})).toBe("title")
      expect(relevanceToLevel(0.1, {})).toBe("title")
    })

    test("returns hidden for score < 0.1", () => {
      expect(relevanceToLevel(0.05, {})).toBe("hidden")
      expect(relevanceToLevel(0, {})).toBe("hidden")
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// SmartCompressor Tests
// ══════════════════════════════════════════════════════════════════

describe("context-compressor.SmartCompressor", () => {
  describe("compress", () => {
    const createTopic = (overrides?: Partial<Topic>): Topic => ({
      id: "test",
      title: "Test Topic",
      keywords: [],
      summary: "",
      requirement: "",
      final_result_preview: "",
      lessons: "",
      turns: [],
      status: "hot",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    })

    test("returns empty string for hidden level", () => {
      const topic = createTopic()
      expect(SmartCompressor.compress(topic, "hidden")).toBe("")
    })

    test("returns title only for title level", () => {
      const topic = createTopic({ title: "My Topic" })
      const result = SmartCompressor.compress(topic, "title")
      expect(result).toBe("[Topic: My Topic]")
    })

    test("returns summary format for summary level", () => {
      const topic = createTopic({
        title: "排序函数",
        requirement: "帮我写一个降序排序函数",
        final_result_preview: "def sort_desc(arr): ...",
        lessons: "用户纠正为降序",
      })
      const result = SmartCompressor.compress(topic, "summary")
      expect(result).toContain("[Topic: 排序函数]")
      expect(result).toContain("Requirement:")
      expect(result).toContain("Result:")
      expect(result).toContain("Lessons:")
    })

    test("compresses full level with intermediate truncation", () => {
      const turns: MessageV2.WithParts[] = [
        createTurn("user", "帮我写排序", "requirement"),
        createTurn("assistant", "x".repeat(200), "intermediate"),
      ]
      const topic = createTopic({ turns })
      const result = SmartCompressor.compress(topic, "full")
      expect(result).toContain("User:")
      expect(result).toContain("Assistant:")
      // Intermediate should be truncated
      expect(result.length).toBeLessThan(300)
    })

    test("formats error_attempt with [Error] prefix", () => {
      const turns: MessageV2.WithParts[] = [
        createTurn("assistant", "Traceback: module X not found", "error_attempt"),
      ]
      const topic = createTopic({ turns })
      const result = SmartCompressor.compress(topic, "full")
      expect(result).toContain("[Error]")
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// ContextAssembler Tests
// ══════════════════════════════════════════════════════════════════

describe("context-compressor.ContextAssembler", () => {
  describe("assemble", () => {
    test("assembles basic context", () => {
      const turns = [
        createTurn("user", "帮我写排序"),
        createTurn("assistant", "```python\ndef sort(): ...\n```", "final_result"),
      ]
      const result = ContextAssembler.assemble({
        turns,
        currentQuery: "修改排序函数",
        archivedTopics: [],
      })
      expect(result).toContain("排序")
    })

    test("includes global summary", () => {
      const turns = [createTurn("user", "hello")]
      const result = ContextAssembler.assemble({
        turns,
        currentQuery: "hi",
        archivedTopics: [],
        globalSummary: "Earlier we discussed sorting",
      })
      expect(result).toContain("Earlier we discussed sorting")
    })

    test("merges archived topics", () => {
      const turns = [createTurn("user", "new topic")]
      const archived: ArchivedTopicData[] = [
        {
          id: "archived1",
          title: "Old Topic",
          keywords: ["old"],
          summary: "Previous discussion",
          requirement: "Old requirement",
          final_result_preview: "Old result",
          lessons: "",
          turns_count: 4,
          status: "cold",
          created_at: Date.now() - 7200000,
          updated_at: Date.now() - 3600000,
        },
      ]
      const result = ContextAssembler.assemble({
        turns,
        currentQuery: "old topic",
        archivedTopics: archived,
      })
      // Archived topic with matching query should be included
      expect(result).toContain("Old Topic")
    })

    test("respects most recent hot topic with full treatment", () => {
      const turns = [
        createTurn("user", "first"),
        createTurn("assistant", "first response", "final_result"),
        createTurn("user", "second"),
        createTurn("assistant", "second response", "final_result"),
      ]
      const result = ContextAssembler.assemble({
        turns,
        currentQuery: "test",
        archivedTopics: [],
      })
      // Most recent should be included fully
      expect(result).toContain("second")
    })

    test("handles empty turns with summary fallback", () => {
      const result = ContextAssembler.assemble({
        turns: [],
        currentQuery: "test",
        archivedTopics: [],
        globalSummary: "Summary only",
      })
      expect(result).toContain("Summary only")
    })

    test("returns empty string for no content", () => {
      const result = ContextAssembler.assemble({
        turns: [],
        currentQuery: "test",
        archivedTopics: [],
      })
      expect(result).toBe("")
    })
  })

  describe("autoArchive", () => {
    test("returns original turns when below threshold", () => {
      const turns = [createTurn("user", "test")]
      const { remaining, archived } = ContextAssembler.autoArchive(turns, 30)
      expect(remaining).toEqual(turns)
      expect(archived).toEqual([])
    })

    test("archives old topics when above threshold", () => {
      const turns: MessageV2.WithParts[] = []
      // Create 35 turns across multiple topics
      for (let i = 0; i < 35; i++) {
        if (i % 10 === 0) {
          turns.push(createTurn("user", `New topic ${i}`))
        } else {
          turns.push(createTurn("assistant", `response ${i}`, "intermediate"))
        }
      }
      const { remaining, archived } = ContextAssembler.autoArchive(turns, 30)
      expect(remaining.length).toBeLessThan(turns.length)
      expect(archived.length).toBeGreaterThan(0)
    })

    test("sets archived topics status to cold", () => {
      const turns: MessageV2.WithParts[] = []
      for (let i = 0; i < 35; i++) {
        turns.push(
          createTurn(
            i % 2 === 0 ? "user" : "assistant",
            `msg ${i}`,
            i % 2 === 0 ? "requirement" : "intermediate",
          ),
        )
      }
      const { archived } = ContextAssembler.autoArchive(turns, 30)
      expect(archived.every((t) => t.status === "cold")).toBe(true)
    })
  })

  describe("recallTopic", () => {
    test("marks matching topics as recalled", () => {
      const archived: ArchivedTopicData[] = [
        {
          id: "t1",
          title: "排序算法",
          keywords: ["排序", "算法", "quicksort"],
          summary: "",
          requirement: "帮我写排序",
          final_result_preview: "def sort(): ...",
          lessons: "",
          turns_count: 4,
          status: "cold",
          created_at: Date.now() - 7200000,
          updated_at: Date.now() - 3600000,
        },
      ]
      const result = ContextAssembler.recallTopic(archived, "之前的排序代码")
      const recalled = result.filter((t) => t.status === "recalled")
      expect(recalled.length).toBe(1)
    })

    test("does not mark non-matching topics", () => {
      const archived: ArchivedTopicData[] = [
        {
          id: "t1",
          title: "排序算法",
          keywords: ["排序", "算法"],
          summary: "",
          requirement: "帮我写排序",
          final_result_preview: "",
          lessons: "",
          turns_count: 4,
          status: "cold",
          created_at: Date.now() - 7200000,
          updated_at: Date.now() - 3600000,
        },
      ]
      const result = ContextAssembler.recallTopic(archived, "今天的天气")
      const recalled = result.filter((t) => t.status === "recalled")
      expect(recalled.length).toBe(0)
    })
  })

  describe("listTopics", () => {
    test("lists hot and archived topics", () => {
      const turns = [
        createTurn("user", "帮我写排序"),
        createTurn("assistant", "done", "final_result"),
      ]
      const archived: ArchivedTopicData[] = [
        {
          id: "old1",
          title: "Old topic",
          keywords: [],
          summary: "",
          requirement: "old",
          final_result_preview: "",
          lessons: "",
          turns_count: 4,
          status: "cold",
          created_at: Date.now() - 7200000,
          updated_at: Date.now() - 3600000,
        },
      ]
      const topics = ContextAssembler.listTopics(turns, archived)
      expect(topics.length).toBe(2)
      const statuses = new Set(topics.map((t) => t.status))
      expect(statuses.has("hot")).toBe(true)
      expect(statuses.has("cold")).toBe(true)
    })
  })
})

// ══════════════════════════════════════════════════════════════════
// Integration Tests
// ══════════════════════════════════════════════════════════════════

describe("context-compressor.integration", () => {
  test("full compression workflow", () => {
    // Create a conversation with multiple topics
    const turns: MessageV2.WithParts[] = [
      // Topic 1: Sorting
      createTurn("user", "帮我写一个快速排序函数"),
      createTurn("assistant", "```python\ndef quicksort(arr):\n    ...\n```", "final_result"),
      createTurn("user", "不对，需要降序"),
      createTurn("assistant", "```python\ndef quicksort_desc(arr):\n    ...\n```", "final_result"),

      // Topic 2: Search
      createTurn("user", "现在帮我写一个二分搜索"),
      createTurn("assistant", "```python\ndef binary_search(arr, target):\n    ...\n```", "final_result"),
      createTurn("user", "加上类型提示"),
      createTurn("assistant", "```python\ndef binary_search(arr: List[int], target: int) -> Optional[int]:\n    ...\n```", "final_result"),

      // Topic 3: Current (testing)
      createTurn("user", "帮我写单元测试"),
      createTurn("assistant", "```python\ndef test_sort():\n    ...\n```", "final_result"),
    ]

    // Archive old topics
    const { remaining, archived } = ContextAssembler.autoArchive(turns, 6)

    // Assemble context for a query about sorting
    const result = ContextAssembler.assemble({
      turns: remaining,
      currentQuery: "修改一下排序函数",
      archivedTopics: archived,
    })

    // Verify sorting topic is included (keyword match)
    expect(result).toContain("quicksort")

    // Verify most recent topic is fully included
    expect(result).toContain("单元测试")
  })

  test("topic boundary detection with multiple topics", () => {
    const turns: MessageV2.WithParts[] = [
      createTurn("user", "帮我写排序"),
      createTurn("assistant", "sorted", "final_result"),
      createTurn("user", "另外，帮我写搜索"), // Explicit boundary
      createTurn("assistant", "search", "final_result"),
      createTurn("user", "接下来，写测试"), // Another boundary
      createTurn("assistant", "test", "final_result"),
    ]

    const topics = TopicGrouper.group(turns)
    expect(topics.length).toBe(3)
  })

  test("semantic classification affects compression", () => {
    const turns: MessageV2.WithParts[] = [
      createTurn("user", "帮我写排序", "requirement"),
      createTurn("assistant", "first attempt", "intermediate"),
      createTurn("user", "不对，要降序", "correction"),
      createTurn("assistant", "```python\ndef sort_desc(): ...\n```", "final_result"),
    ]

    const topics = TopicGrouper.group(turns)
    expect(topics).toHaveLength(1)

    const result = SmartCompressor.compress(topics[0], "full")

    // Correction should be preserved
    expect(result).toContain("降序")
  })
})
