import type { Hooks, Plugin } from "@opencode-ai/plugin"
import type { Part } from "@opencode-ai/sdk"
import {
  classifyTurns,
  compressToolResult,
  computeRelevance,
  createContinuationSummaryPrompt,
  groupTopics,
  relevanceToLevel,
  type CompressionLevel,
  type Turn,
} from "@ssshake/context-core"

type ContextCompressionOptions = {
  enabled?: boolean
  minMessages?: number
  toolResultMaxTokens?: number
  levelToolTokens?: Partial<Record<CompressionLevel, number>>
  levelAssistantChars?: Partial<Record<CompressionLevel, number>>
  replaceCompactionPrompt?: boolean
}

const DEFAULT_OPTIONS: Required<Omit<ContextCompressionOptions, "levelToolTokens" | "levelAssistantChars">> & {
  levelToolTokens: Record<CompressionLevel, number>
  levelAssistantChars: Record<CompressionLevel, number>
} = {
  enabled: true,
  minMessages: 12,
  toolResultMaxTokens: 1500,
  replaceCompactionPrompt: true,
  levelToolTokens: {
    full: 1200,
    summary: 400,
    title: 120,
    hidden: 60,
  },
  levelAssistantChars: {
    full: 1200,
    summary: 320,
    title: 100,
    hidden: 72,
  },
}

type OpencodeMessage = {
  info: {
    id: string
    role: string
  }
  parts: Part[]
}

function normalizeOptions(options?: ContextCompressionOptions) {
  return {
    ...DEFAULT_OPTIONS,
    ...options,
    levelToolTokens: {
      ...DEFAULT_OPTIONS.levelToolTokens,
      ...(options?.levelToolTokens ?? {}),
    },
    levelAssistantChars: {
      ...DEFAULT_OPTIONS.levelAssistantChars,
      ...(options?.levelAssistantChars ?? {}),
    },
  }
}

function textContent(parts: Part[], includeIgnored = false) {
  return parts
    .flatMap((part) => {
      if (part.type === "text") {
        if (!includeIgnored && part.ignored) return []
        return [part.text]
      }
      if (part.type === "tool" && part.state.status === "completed") {
        return [`[tool:${part.tool}] ${part.state.title}\n${part.state.output}`]
      }
      return []
    })
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

function turnsFromMessages(messages: OpencodeMessage[]) {
  const turns: Turn[] = []

  for (const message of messages) {
    if (message.info.role !== "user" && message.info.role !== "assistant") continue
    const content = textContent(message.parts)
    if (!content) continue
    turns.push({
      id: message.info.id,
      role: message.info.role,
      content,
    })
  }

  return { turns: classifyTurns(turns) }
}

function lastUserQuery(messages: OpencodeMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    const text = textContent(message.parts)
    if (text) return text
  }
  return ""
}

function compactText(text: string, limit: number, fallback: string) {
  if (text.length <= limit) return text
  const head = text.slice(0, limit).trimEnd()
  return head ? `${head}...` : fallback
}

function levelForMessages(messages: OpencodeMessage[]) {
  const { turns } = turnsFromMessages(messages)
  if (!turns.length) return new Map<string, CompressionLevel>()

  const topics = groupTopics(turns)
  const latestQuery = lastUserQuery(messages)
  const latestTopicId = topics.at(-1)?.id
  const turnToLevel = new Map<string, CompressionLevel>()

  for (const topic of topics) {
    const score = topic.id === latestTopicId ? 1 : computeRelevance(topic, latestQuery)
    const level = relevanceToLevel(score)
    for (const turn of topic.turns) {
      turnToLevel.set(turn.id, level)
    }
  }

  return turnToLevel
}

function compactMessageParts(message: OpencodeMessage, level: CompressionLevel, options: ReturnType<typeof normalizeOptions>) {
  for (const part of message.parts) {
    if (part.type === "tool" && part.state.status === "completed") {
      const before = part.state.output
      const after =
        level === "hidden"
          ? `[Earlier ${part.tool} result compacted]`
          : compressToolResult(before, part.tool, {
              maxTokens: options.levelToolTokens[level],
            })
      part.state.output = after
      part.state.metadata = {
        ...(part.state.metadata ?? {}),
        contextCompression: {
          level,
          originalChars: before.length,
          compressedChars: after.length,
          plugin: "opencode-context-compression",
        },
      }
      continue
    }

    if (part.type === "text" && !part.synthetic && !part.ignored) {
      if (message.info.role === "assistant") {
        part.text = compactText(part.text, options.levelAssistantChars[level], "[Earlier assistant output compacted]")
      } else if (level === "hidden") {
        part.text = compactText(part.text, 120, "[Earlier user request compacted]")
      } else if (level === "title") {
        part.text = compactText(part.text, 160, part.text)
      }
    }
  }
}

const plugin: Plugin = async (_input, rawOptions) => {
  const options = normalizeOptions(rawOptions as ContextCompressionOptions | undefined)

  const hooks: Hooks = {
    "tool.execute.after": async (input, output) => {
      if (!options.enabled) return
      output.output = compressToolResult(output.output, input.tool, {
        maxTokens: options.toolResultMaxTokens,
      })
      output.metadata = {
        ...(output.metadata ?? {}),
        contextCompression: {
          plugin: "opencode-context-compression",
          tool: input.tool,
        },
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      if (!options.enabled) return
      if (output.messages.length < options.minMessages) return
      const levels = levelForMessages(output.messages as OpencodeMessage[])
      for (const message of output.messages as OpencodeMessage[]) {
        const level = levels.get(message.info.id)
        if (!level || level === "full") continue
        compactMessageParts(message, level, options)
      }
    },
    "experimental.session.compacting": async (_input, output) => {
      if (!options.enabled) return
      const template = createContinuationSummaryPrompt()
      if (options.replaceCompactionPrompt) {
        output.prompt = template
      } else {
        output.context.push(template)
      }
      output.context.push(
        "Preserve persistent instructions, current hot topic, completed work, remaining work, and the minimal file set required to resume execution accurately.",
      )
    },
  }

  return hooks
}

export default plugin
