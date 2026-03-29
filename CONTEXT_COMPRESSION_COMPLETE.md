# 上下文压缩系统实现完成报告

## 概述

成功实现了基于 mulagent 项目的三维智能上下文压缩系统，并完整集成到 opencode 项目中。

## 已完成的功能

### 1. 核心压缩引擎 (`src/session/context-compressor.ts`)

#### 维度一：语义角色分类 (TurnClassifier)
- 7 种语义类型识别：
  - `requirement` - 用户需求
  - `correction` - 纠正/重定向
  - `directive` - 持久性规则
  - `final_result` - 确认的最终结果
  - `question` - 询问性问题
  - `error_attempt` - 失败尝试或错误
  - `intermediate` - 中间过程

- 中英文关键词模式匹配
- 基于规则和上下文的分类逻辑

#### 维度二：话题分组与归档 (TopicGrouper)
- 话题边界检测算法
- Topic 数据结构（ID、标题、关键词、摘要、需求、结果预览、教训）
- 关键词提取（词频统计、停用词过滤）
- 支持话题自动分组

#### 维度三：相关性驱动压缩 (SmartCompressor)
- 三信号相关性评分：
  - 关键词重叠 (0.5) - Jaccard 相似度
  - 召回意图 (0.3) - 查询意图检测
  - 时间衰减 (0.2) - 指数衰减（24 小时半衰期）
- 四级压缩级别：
  - `Full` (≥0.7) - 完整保留
  - `Summary` (0.3-0.7) - 摘要压缩
  - `Title` (0.1-0.3) - 仅保留标题
  - `Hidden` (<0.1) - 隐藏

#### 上下文组装器 (ContextAssembler)
- `assemble()` - 组装压缩上下文
- `autoArchive()` - 自动归档旧话题
- `recallTopic()` - 召回相关归档话题
- `listTopics()` - 列出所有话题

---

### 2. 配置扩展 (`src/config/config.ts`)

新增 12 个压缩配置参数：

```typescript
compaction: {
  // 上下文预算
  context_max_chars: number (default: 0)

  // 压缩阈值
  level_full: number (default: 0.7)
  level_summary: number (default: 0.3)
  level_title: number (default: 0.1)

  // 相关性权重
  weight_keyword: number (default: 0.5)
  weight_recall: number (default: 0.3)
  weight_decay: number (default: 0.2)

  // 话题归档
  archive_threshold: number (default: 30)
  archive_manual_threshold: number (default: 6)
  decay_half_life_hours: number (default: 24)
  max_gap_turns: number (default: 6)
  max_kw: number (default: 8)
  hard_cap_turns: number (default: 50)
}
```

---

### 3. 数据库迁移 (`src/session/session.sql.ts`)

在 `SessionTable` 中添加字段：
- `archive_topics` - JSON 数组，存储归档话题数据
- `global_summary` - 文本，存储全局摘要

---

### 4. Session API 集成 (`src/session/index.ts`)

新增方法：
- `setArchiveTopics()` - 设置归档话题列表
- `setGlobalSummary()` - 设置全局摘要
- `getContextForPrompt()` - 获取压缩后的上下文用于 LLM prompt

更新 `Info` 类型：
- 添加 `archive_topics` 字段（类型：`ArchivedTopicData[]`）
- 添加 `global_summary` 字段（类型：`string`）

---

### 5. TUI CLI 命令 (`src/cli/cmd/tui/component/prompt/index.tsx`)

添加 5 个 slash 命令：

#### `/compress`
手动触发上下文压缩
- 组装当前压缩上下文
- 显示压缩结果（字符数）
- 保存压缩状态

#### `/topics`
列出所有话题
- 显示归档话题（标记为 [Archived]）
- 显示活跃话题（标记为 [Hot]）
- 显示话题标题

#### `/recall <query>`
召回与查询相关的归档话题
- 基于相关性评分搜索归档话题
- 自动标记匹配话题为 "recalled" 状态
- 更新会话数据

#### `/expand <topic_id>`
扩展已折叠的话题
- 将话题标记为 expanded 状态
- 在压缩上下文中显示完整内容

#### `/collapse <topic_id>`
折叠已扩展的话题
- 将话题标记为 collapsed 状态
- 在压缩上下文中仅显示摘要

---

### 6. Prompt 流程集成 (`src/session/prompt.ts`)

在 system prompt 中注入压缩上下文：
- 每轮对话前调用 `Session.getContextForPrompt()`
- 将压缩上下文包装在 `<compressed-context>` 标签中
- 注入到 system prompt 数组，供 LLM 参考

---

## 测试覆盖 (`test/session/context-compressor.test.ts`)

共 51 个测试用例：

### TurnClassifier 测试 (14 个)
- 用户消息分类（中英文需求、纠正、指令、提问）
- 助手消息分类（最终结果、错误、中间过程）

### TopicGrouper 测试 (10 个)
- 话题分组逻辑
- 边界检测
- 关键词提取

### Relevance 测试 (8 个)
- 相关性计算
- 时间衰减
- 压缩级别映射

### SmartCompressor 测试 (6 个)
- 四级压缩输出
- 截断逻辑

### ContextAssembler 测试 (10 个)
- 上下文组装
- 自动归档
- 话题召回

### 集成测试 (3 个)
- 完整工作流
- 多话题处理

---

## 使用示例

### 配置示例 (opencode.json)

```json
{
  "compaction": {
    "auto": true,
    "prune": true,
    "context_max_chars": 8000,
    "level_full": 0.7,
    "level_summary": 0.3,
    "level_title": 0.1,
    "weight_keyword": 0.5,
    "weight_recall": 0.3,
    "weight_decay": 0.2,
    "archive_threshold": 30,
    "archive_manual_threshold": 6,
    "decay_half_life_hours": 24
  }
}
```

### API 使用

```typescript
import {
  TurnClassifier,
  TopicGrouper,
  SmartCompressor,
  ContextAssembler,
  computeRelevance,
  relevanceToLevel,
} from "@/session/context-compressor"

// 1. 语义分类
const semType = TurnClassifier.classify("user", "帮我写排序", "user", undefined)
// → "requirement"

// 2. 话题分组
const topics = TopicGrouper.group(turns)

// 3. 相关性评分
const score = computeRelevance(topic, "排序函数", config)
const level = relevanceToLevel(score, config)

// 4. 压缩输出
const compressed = SmartCompressor.compress(topic, level)

// 5. 完整组装
const context = ContextAssembler.assemble({
  turns,
  currentQuery: "修改排序",
  archivedTopics: [],
})
```

### TUI 命令

```bash
# 手动压缩
/compress

# 列出话题
/topics

# 召回相关话题
/recall 排序函数
```

---

## 压缩效果对比

### 改动前
```
[消息 1][消息 2][消息 3]...[消息 28][消息 29][消息 30]
                      │
                   截断丢失
```

### 改动后
```
[Topic1: 降序排序]┐
[Topic2: 二分搜索]├──> 归档 (cold) 按需召回
[Topic3: 单元测试]┘
─────────────────────────────────
[Topic4: 性能优化] ──> 活跃 (hot) 完整保留
```

---

## 文件清单

| 文件 | 状态 | 说明 |
|------|------|------|
| `src/session/context-compressor.ts` | ✅ | 核心压缩引擎（包含自动压缩触发） |
| `src/config/config.ts` | ✅ | 配置扩展 |
| `test/session/context-compressor.test.ts` | ✅ | 测试用例 |
| `src/session/session.sql.ts` | ✅ | 数据库迁移 |
| `src/session/index.ts` | ✅ | Session 集成 |
| `src/cli/cmd/tui/component/prompt/index.tsx` | ✅ | TUI CLI 命令（/compress, /topics, /recall, /expand, /collapse） |
| `src/session/prompt.ts` | ✅ | Prompt 流程集成（包含自动压缩） |

---

## 核心优势

| 维度 | 原方案 | 新方案 |
|------|--------|--------|
| 信息保留 | 摘要替换，细节丢失 | 话题归档，可按需展开 |
| 上下文边界 | 简单截断 | 语义话题边界 |
| 相关性判断 | 时间顺序 | 三信号评分 |
| 压缩粒度 | 整体摘要 | 四级压缩 |
| 用户控制 | 自动触发 | 自动 + 手动 |
| 话题召回 | ❌ | ✅ |
| 语义理解 | ❌ | ✅ |

---

## 后续优化建议

1. **压缩可视化**: 在 TUI 中显示话题列表和压缩状态（例如在侧边栏显示话题树）
2. **配置调优**: 根据实际使用情况调整压缩阈值和权重参数
3. **话题标题自动生成**: 使用 LLM 为话题生成更精确的标题
4. **渐进式压缩**: 支持多级压缩，根据上下文预算动态调整

---

## 运行测试

```bash
# 在项目根目录
cd packages/opencode
bun test test/session/context-compressor.test.ts
```

---

## 参考资料

- MulAgent 源码：`src/graph/context_compressor.py`
- MulAgent 文档：`docs/context-compression.md`
- 迁移方案：`opencode_context_migration.md`
