# 上下文压缩方案实现总结

## 已完成的工作

### 1. 核心模块实现

**文件**: `packages/opencode/src/session/context-compressor.ts`

实现了三维智能上下文压缩系统：

#### 维度一：语义角色分类 (TurnClassifier)
- 7 种语义类型：requirement, correction, directive, final_result, question, error_attempt, intermediate
- 中英文关键词模式匹配
- 基于规则和上下文的分类逻辑

#### 维度二：话题分组与归档 (TopicGrouper)
- 话题边界检测（显式信号、需求 - 结果切换、长度阈值）
- Topic 数据结构（ID、标题、关键词、摘要、需求、结果预览、教训）
- 关键词提取（词频统计、停用词过滤）

#### 维度三：相关性驱动压缩 (SmartCompressor)
- 三信号相关性评分：关键词重叠 (0.5) + 召回意图 (0.3) + 时间衰减 (0.2)
- 四级压缩：Full (≥0.7) | Summary (0.3-0.7) | Title (0.1-0.3) | Hidden (<0.1)
- 预算内组装与降级策略

#### 上下文组装器 (ContextAssembler)
- assemble() - 组装压缩上下文
- autoArchive() - 自动归档旧话题
- recallTopic() - 召回相关归档话题
- listTopics() - 列出所有话题

---

### 2. 配置扩展

**文件**: `packages/opencode/src/config/config.ts`

新增压缩配置参数：

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

### 3. 测试用例

**文件**: `packages/opencode/test/session/context-compressor.test.ts`

覆盖了所有核心功能：

- **TurnClassifier 测试**: 14 个测试用例
  - 用户消息分类（中英文需求、纠正、指令、提问）
  - 助手消息分类（最终结果、错误、中间过程）

- **TopicGrouper 测试**: 10 个测试用例
  - 话题分组逻辑
  - 边界检测
  - 关键词提取

- **Relevance 测试**: 8 个测试用例
  - 相关性计算
  - 时间衰减
  - 压缩级别映射

- **SmartCompressor 测试**: 6 个测试用例
  - 四级压缩输出
  - 截断逻辑

- **ContextAssembler 测试**: 10 个测试用例
  - 上下文组装
  - 自动归档
  - 话题召回

- **集成测试**: 3 个测试用例
  - 完整工作流
  - 多话题处理

---

## 待完成的工作

所有核心功能已完成！✅

### 已完成的优化

1. **自动压缩触发** ✅
   - 添加了 `shouldTriggerCompression()` 函数
   - 添加了 `autoArchiveIfNeeded()` 函数
   - 在 `prompt.ts` 中集成了自动归档逻辑
   - 当对话超过阈值时自动触发压缩

2. **话题扩展/折叠** ✅
   - 添加了 `/expand <topic_id>` 命令
   - 添加了 `/collapse <topic_id>` 命令
   - 在 `ArchivedTopicData` 中添加了 `expanded` 字段

3. **压缩可视化** - 建议后续在 TUI 中显示话题列表和压缩状态

4. **配置调优** - 建议根据实际使用情况调整压缩阈值和权重参数

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
| `src/session/context-compressor.ts` | ✅ 完成 | 核心压缩引擎 |
| `src/config/config.ts` | ✅ 完成 | 配置扩展 |
| `test/session/context-compressor.test.ts` | ✅ 完成 | 测试用例 |
| `src/session/session.sql.ts` | ✅ 完成 | 数据库迁移 |
| `src/session/index.ts` | ✅ 完成 | Session 集成 |
| `src/cli/cmd/tui/component/prompt/index.tsx` | ✅ 完成 | TUI CLI 命令 |
| `src/session/prompt.ts` | ✅ 完成 | Prompt 流程集成 |

---

## 运行测试

```bash
# 在项目根目录
cd packages/opencode
bun test test/session/context-compressor.test.ts
```

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

## 参考资料

- MulAgent 源码：`src/graph/context_compressor.py`
- MulAgent 文档：`docs/context-compression.md`
- 迁移方案：`opencode_context_migration.md`
