# LLM Skill-Leak in Agent Workflows：机制、五层防御与根因

> **作者**: Feiyue Zhai + LLM collaborator
> **日期**: 2026-04-21
> **标签**: LLM agent, skill-leak, generation-time bias, scanner, agent framework
> **触发事件**: 调试 paper-reader v0.3 skill 在 PrfaaS notes 里反复出现的 "Scope of this file"、"Stage 4 synthesis" 等 meta-language

一次具体的调试日记, 推导出一个通用的 agent workflow 失效模式。

## 1. 什么是 skill-leak

agent-based paper reader 用 `SKILL.md` 定义 workflow: "Stage 2 READ 产出 preread, Stage 3 WRITE 产出 notes, Stage 4 CONNECT 产出 synthesis"。Stage 3 WRITE 里 LLM 本该只输出 paper 内容, 但实际产出 notes 里混进了 **skill 定义里教 agent 怎么写 notes 的话**。

典型 leak 现场（PrfaaS v3 真实案例）:

```markdown
# PrfaaS notes §0

**Scope of this file**: paper-internal content only. Cross-paper
comparisons, adversarial rebuttals, ecosystem positioning, and
unexplored-hybrid directions live in `knowledge/synthesis-{id}.md`
(Stage 4, TBD).

## §3.3 双时间尺度调度器（§3.4.3 的状态机——paper 无此图, Mermaid 补充）

> **Redraw reason**: paper §3.4.3 只用文字描述 short-term + long-term
> 两层调度, 没有状态机。以下状态机是为了让 Stage 4 synthesis 能指向
> 具体的状态转移而补充的。

## §6. 论证链

**Scope note**: 这一节只**复原 paper 自己的多步论证**, 不是读者的攻击 /
ecosystem check / 反例搜索——那些是 Stage 4 synthesis 的任务。
```

这些段落不是错误信息——**内容可能是对的**, 只是**出现在错误的文件里**。它们解释 "本节 vs 他节的分工",这是给 skill-aware 的读者看的 meta-language, 不是给 paper-reading 的读者看的内容。

实际项目里这个 pattern 在 paper-reader v0.3 一次 Stage 3 WRITE 里出现 **9 次不同 surface form**, 指向同一个底层语义。

## 2. 机制：为什么 LLM 会这么做？

LLM 不是"规则遵守机器", 是**语言生成模型**。当它的 context 同时装着两类内容时, 它自然混合两者生成文本:

```
LLM Context (Stage 3 WRITE 运行时)
┌──────────────────────────────────────────┐
│  Paper 内容 (应输出)                      │
│  - preread/{id}.md (992 行 raw)           │
│  - papers.json 元数据                     │
├──────────────────────────────────────────┤
│  Skill 内容 (不应输出)                    │
│  - SKILL.md (1069 行, 5 stages + meta)    │
│  - deep-<category>.md                     │
│  - incidents.md                           │
│  - 8-pattern leak table 本身              │
└──────────────────────────────────────────┘
         ↓ 生成
    notes/{id}.md  ← 混合输出
```

三层观察:

### 2.1 结构性, 不是偶发

这不是"LLM 偶尔疏忽"。**只要 context 装着 SKILL.md 的结构说明, LLM 就倾向于把这个结构告诉读者**。当 LLM 刚读完 "Stage 3 = paper-internal, Stage 4 = cross-paper" 的分工, 它写 notes 时的 mental model 就包含这个划分, 然后很自然地想在 notes 顶部/节末 解释这个划分。

对一个**典型的 technical writing 训练目标**, "解释 scope" 是 helpful 的——README 开头经常有 "What this file is about"。训练分布**奖励**这种 meta-orientation。

### 2.2 作者偏见让 self-check 失效

Pre-Save Self-Check 是一个写在 skill 里的指令: "写完后, 回去 review draft, catch leak patterns"。

问题: **同一个 LLM 刚写出 "Scope of this file..."**, 它 review 自己的输出时**不会觉得是 leak**。用 technical writing 标准判断, 这句话完全合理。

经验 rate: 纯指令层的 Pre-Save Self-Check 漏率 ~30%。

### 2.3 训练分布 vs 任务要求的冲突

LLM 被训练成 "generate helpful technical documentation"。helpful documentation 的成熟 pattern 之一是 **"tell the reader about scope"**。任务 (paper notes) 的要求是 **"don't tell the reader about skill structure"**。

两个 objective 直接冲突。softmax 的默认路径倾向训练分布的 pattern, 所以 **不做任何 mitigation 的 baseline 就是产出 leak**。

## 3. 五层防御

按**效力递增 + 工程复杂度递增**:

### L1 — 具体 phrase list (弱)

在 SKILL.md 的 "Content Hygiene" 列出禁用短语 + 反例:

```
❌ "Scope of this file: paper-internal content only"
❌ "**Scope note**"
❌ "Stage 3 v2 (post-preread)"
❌ "本节只写 X 不讨论 Y"
```

**强项**: 改文档即可。
**弱项**: LLM 会 paraphrase。"Here we cover..." 绕过。**每次新 iteration 追加新 phrase** → whack-a-mole。

### L2 — 硬 scanner gate (中, 工程闭环)

两组件:

1. `check_paper_completeness.py` 维护 `_SKILL_LEAK_PHRASES` 正则列表 (当前 73 条)
2. `SKILL.md` Stage 3 exit 强制跑 `check_paper_completeness.py {id} --check=leaks`, `exit != 0` 不进 Stage 4

**强项**: scanner 没有**作者偏见**——它看 phrase 就是 phrase, 不会 "觉得这话是 helpful". 一次 CI 级 enforce。
**弱项**: 仍然靠 phrase list。paraphrase 绕过。**也是 whack-a-mole**。

### L3 — Two-pass generation (中强, 需工作流支持)

- **Pass 1**: LLM 自由写 draft
- **Pass 2**: **新的 tool call** (独立 context) 专门 review draft against 8-pattern 表, 删除违规段

为什么新 tool call 更好:

- Pass 2 的 LLM 实例看 draft 时**不带 "I wrote this 5 秒前" 的作者偏见**
- context 里不再是"我在写 notes"而是"我在审查 notes 里的违规"——任务框架变了
- 同一个底层模型, 不同 prompt + context → 不同判断质量

**强项**: 结构上消除同一 run 内作者偏见。
**弱项**:

- 依赖 agent 框架支持显式 split tool call (手工写 skill 文档说"请 review"不够)
- Pass 2 LLM 仍是 LLM, 有自己的生成偏见
- Pass 2 用的还是 phrase list → paraphrase 仍绕过

### L4 — Stage-scoped context (强, 结构性)

**根治思路**: Stage 3 WRITE **不加载完整 SKILL.md**。只加载:

- paper 内容 (preread)
- 7-section 输出 schema 的 bare 描述 (无叙述, 无 "why this separation" 解释)
- 硬格式约束 (LaTeX 规则、图片路径等)

**不加载**:

- Stage 4 的描述
- Meta-rules (Skill-Modification Protocol 等)
- 8-pattern leak table 本身及其说明
- Deep-*.md 的 inheritance model 讨论

**原理**: LLM 没法 leak 它 context 里**没有**的内容。如果它没看到 "Stage 4 synthesis" 这个词, 它就不会用这个词写 notes。

**强项**: 真·根治——消除 context 污染源头。
**弱项**:

- 需要 agent 框架支持 "按 stage 切分 skill context" 的 API
- 当前 Cursor / Claude Code 都是整体 skill-load
- SKILL.md 需拆成 `stage-1-absorb.md` / `stage-3-write.md` / ... 各自独立, 运行时按 stage 切换
- 失去 single-file skill 的 human readability

### L5 — Schema-bound output (最强, 最受限)

**根治但受限**: Stage 3 输出不是 free-form MD, 是 **structured JSON / per-field blanks**:

```json
{
  "tldr": "PrfaaS 把...",
  "q1_pain": "...",
  "q2_method": "...",
  "q3_results": "...",
  "architecture_diagrams": [...],
  "author_proof": {
    "notation_table": [...],
    "equations": [{"latex": "$...$", "physical": "...", "load_bearing": true}]
  }
}
```

`sync.sh` 从 JSON 拼 MD / HTML。LLM 只能填已有 field, **没地方塞 "Scope of this file"** 因为没这个 field。

**强项**: leak surface → 0 (结构上不可能)。
**弱项**:

- 失去 free-form prose 的灵活性
- paper 需要的"非标准"内容 (章节题外话、需要叙事语调的数学推导) 被 schema 约束掉
- Schema 设计错误 → LLM 无处塞合理内容, 硬塞进 nearest field 或直接丢失

### 五层对比表

| 层 | 效力 | 工程成本 | 对 agent framework 要求 | 失效模式 |
|---|---|---|---|---|
| L1 phrase list | 弱 | 低 (文档) | 无 | 刚学过 skill 的 LLM 仍漏; paraphrase 绕过 |
| L2 scanner gate | 中 | 中 (代码+文档) | 无 | 列表穷举困难, whack-a-mole |
| L3 two-pass | 中强 | 中高 (工作流) | split tool call | Pass 2 仍是 phrase-list based; 新 framework 支持 |
| L4 scoped context | 强 | 高 (skill 重组 + framework) | per-stage context API | 尚无 framework 原生支持 |
| L5 schema output | 最强 | 最高 (重设计协议) | structured output | 失去 free-form 灵活性, 需 exhaustive schema |

## 4. 实际实施 (PrfaaS v0.3 的 L1+L2+"轻 L3")

- ✅ **L1**: SKILL.md 8-pattern 表有 PrfaaS 真实 leak 反例 + 作者偏见提示
- ✅ **L2**: scanner 73 条 phrase + Stage 3 exit HARD gate  
- 🟡 **L3**: 仅指令层 Pre-Save Self-Check, **无 split tool call**
- ❌ **L4**: 未实施 (需 Cursor / Claude Code framework 支持)
- ❌ **L5**: 未实施 (需 skill 协议重设计)

### 残余 leak rate (PrfaaS v3 实测)

- LLM draft 含 **9 种不同 phrase surface** 的 leak
- Scanner v1 (~40 phrase) 抓: 3 种
- Scanner v2 (~60 phrase, 加了 "Stage 4 synthesis" 等) 抓: 5 种  
- Scanner v3 (~73 phrase, 加了 "这一?节 ?只(复原|讨论)" 等) 抓: 6 种
- **3 轮 scanner 扩列 + 3 轮人工 review 后清零**

实际 9 种 leak phrase (同一个 LLM 同一个 draft 找到):

1. `Scope of this file`
2. `**Scope note**`
3. `paper-internal content only`
4. `cross-paper ... lives in`
5. `Stage 4 synthesis`
6. `（后者属 Stage 4 synthesis）`
7. `paper 无此图 Mermaid 补充`
8. `Redraw reason: ... Stage 4 synthesis`
9. `这一节只复原论文内容`

**同一语义** ("告诉读者本节 vs 他节的分工") 找到 **9 种表达**。

## 5. 根因: Whack-a-mole

为什么 L1+L2+L3 永远不够:

```
LLM 输出倾向 (训练分布奖励)
       ↓
    orientation meta / structure hint / reader guidance
       ↓  
  whatever phrase     ← phrase list (scanner)
  the LLM picks         只抓当前已知
       ↓
  下次新 phrase 诞生  ← 追加列表
       ↓
  whack-a-mole ∞
```

scanner 是**后验**机制——它只能抓 LLM 已经生成的东西。但 LLM 的表达空间**无穷**: 同一个语义能用无穷多种 phrase 表达。每抓一个, LLM 下次换一个。

**根治只有 L4 或 L5**——改变 LLM 的 **context** 或 **output shape**, 让它**不可能** generate leak:

- L4: context 没有源  
- L5: schema 没有出口

L1/L2/L3 本质是**降低 leak rate**, 不是**消除 leak**。这条路的天花板是: "接受残余 leak, 靠 periodic scanner phrase list 扩充和人工 review 兜底"。

## 6. 对 agent design 的 implication

这不是 paper-reader 独有的问题——**所有 agent-based workflow 都有这个 pattern**:

- Skill doc **必须**在 LLM context 里 (才能执行 skill)
- Skill doc **不应该**出现在 output 里 (那不是 task 要求的)  
- **LLM 无法天然区分 "execute skill" vs "describe skill"**

短期可行 (不改 framework):

- phrase list + scanner + Stage exit gate (L1-L2)
- 反例驱动的 pattern examples in skill (L1 的强化)
- 工作流里的 split LLM calls (L3 的强化)

长期正确 (需改 framework 或重设计 skill):

- Agent framework 提供 "scoped skill loading" API → L4
- Task 用 structured output schemas instead of free-form MD → L5

Cursor / Claude Code 当前都是整 skill-load。如果 Claude Projects / Claude Skills 未来支持 **"per-task-phase context scoping"**, 就能走 L4 路线。

## 7. 对 "LLM 当初级工程师"的启示

把 LLM 类比成**上岗一周的实习工程师**:

- 刚读完 team style guide (= SKILL.md)
- 第一个任务是写个代码 doc (= Stage 3 WRITE)
- **新员工常见失误之一**: 在自己的 doc 里解释 "按照 team 规范, 这里写 X 不写 Y"
- 这种"表明我学过规范"的 orientation meta 不会进最终产品, 但会出现在 draft 里
- team lead 的 code review 就是 L2 的 scanner
- 日积月累, 新人学会"规范内化不外显"

LLM 每次 call 都是"**新员工第一天**", 没有长时间的 scoping 训练。**每次都会产同样的 leak**, 除非结构上让它不可能。

这是为什么 L4 (structural context control) 比 L1-L3 (procedural enforcement) 根本——不是训练问题, 是信息论问题。

## 8. References

- `~/.cursor/skills/paper-reader/SKILL.md` v0.3 — "Content Hygiene — Pre-Save Self-Check" + "Stage 3 exit gate" 段落  
- `~/.cursor/paper-db/tools/check_paper_completeness.py` — `_SKILL_LEAK_PHRASES` 73 条列表 + `--check=leaks` 实现
- `~/.cursor/paper-db/incidents.md` 2026-04-21 系列 — PrfaaS v3 iteration logs
- github 源码: [`amd-tools/skills/paper-reader` @ v0.2-slim](https://github.com/ZhaiFeiyue/amd-tools/tree/v0.2-slim/skills/paper-reader)
