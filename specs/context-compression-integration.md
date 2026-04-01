# OpenCode Context Compression Integration

This spec defines the initial migration path for topic-aware context compression into OpenCode without forking the host runtime architecture.

## Goal

Keep context compression as a durable core capability while avoiding deep OpenCode core edits in phase 1.

The implementation is split into two packages:

- `packages/context-core`
  - host-agnostic compression primitives
  - semantic turn classification
  - topic grouping
  - relevance scoring
  - topic-level compression
  - working memory primitives
  - tool-result compression
- `packages/context-plugin`
  - thin OpenCode adapter
  - maps OpenCode messages and tool outputs into `context-core`
  - integrates through existing plugin hooks

## Why this shape

OpenCode already has:

- context overflow detection
- session compaction flow
- plugin hooks for message transformation and compaction prompt customization

That means phase 1 should reuse the host extension surface instead of rewriting session internals. The core module becomes the long-lived asset; the plugin is the first adapter.

## Current hook mapping

### `tool.execute.after`

Used to compress raw tool output before it is persisted. This is the safest and highest-yield first integration point because it reduces context growth at the source.

### `experimental.chat.messages.transform`

Used to compact older messages before they are converted into model messages. The current implementation is intentionally conservative:

- latest topic remains untouched
- older assistant text is truncated by topic relevance level
- older tool outputs are compressed by topic relevance level
- user turns are only lightly reduced in low-relevance cases

This avoids destructive restructuring while still reducing token pressure.

### `experimental.session.compacting`

Used to replace the default continuation-summary prompt with a structure aligned to the extracted compression model:

- goal
- constraints
- active topic
- archived topics
- discoveries
- progress
- files

## What is intentionally not done yet

The following remain phase-2 work:

- persistent archive storage for topic snapshots
- explicit topic recall / expand / collapse commands
- host-native prompt budget allocator across all prompt segments
- replacement of OpenCode's built-in compaction flow with a fully topic-aware assembler
- session-side storage of compressed summaries as first-class records

## Phase 2 target integration points

Once the plugin behavior is validated, the next internalization path in OpenCode should be:

1. `packages/opencode/src/session/processor.ts`
   - compress tool outputs before writing completed tool parts
2. `packages/opencode/src/session/prompt.ts`
   - inject working-memory and topic-aware compressed history into prompt assembly
3. `packages/opencode/src/session/compaction.ts`
   - replace prompt-only compaction with structured topic archiving
4. `packages/opencode/src/session/message-v2.ts`
   - support host-native archived-topic parts if needed

At that point the plugin can become optional, because the validated behavior will have been moved into the host.

## Platform note

The first phase is platform-neutral. The compression logic is pure TypeScript and does not depend on Windows-specific or Linux-specific runtime features. Platform differences remain in host tool execution, not in the compression core.
