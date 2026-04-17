# 从标准 Serving 到 Agent Serving 的 Pareto 曲线推演

> **作者**: Feiyue Zhai  
> **日期**: 2026-04-17  
> **标签**: LLM serving, agent, Pareto frontier, prefix cache, queuing theory  
> **交互工具**: [Agent Serving Pareto Explorer](/tools/agent-pareto.html)

---

## 1. 背景与动机

### 1.1 为什么需要 Pareto 曲线？

LLM serving 系统有两个核心指标：

- **Throughput**（吞吐量）：系统每秒能处理多少 tokens / requests
- **Latency**（延迟）：单个请求从发出到完成需要多长时间

这两个指标天然矛盾：通过增大 batch size 可以提高吞吐量，但每个请求的延迟也会增加。**Pareto 曲线**（帕累托前沿）描绘了在给定硬件上，throughput 和 latency 之间的**最优权衡边界**——即不可能在不牺牲一个指标的前提下改善另一个指标的点集。

### 1.2 AIConfigurator 的方法论

NVIDIA 的 [AIConfigurator](https://arxiv.org/abs/2601.06288) 论文提出了一套系统性的方法来生成 LLM serving 的 Pareto 曲线：

- **X 轴**: per-user generation speed (tokens/s/user) —— 每用户的生成速度
- **Y 轴**: system throughput (tokens/s/GPU) —— 系统吞吐量
- **每个数据点**: 一种 serving 配置（TP/PP/EP × batch size × aggregated/disaggregated）
- **方法**: 算子级性能数据库（PerfDatabase）+ 数学模型估算，无需实际 GPU profiling

AIConfigurator 的核心贡献是将配置搜索从数天的 GPU 实验缩减到 <1 秒的 CPU 计算（427,000× 加速），其 Pareto 分析直观展示了 disaggregated serving 可以比 aggregated 高 **53% throughput**（Qwen3-235B on 64×H200）。

### 1.3 Agent 场景的挑战

AIConfigurator 的 Pareto 分析基于**标准 serving 假设**：每个请求是独立的、单轮的、ISL/OSL 固定的。但现代 AI Agent 系统（如 Cursor、Claude Code、SWE-bench agents）的工作负载有本质不同：

| 维度 | 标准 Serving | Agent Serving |
|------|------------|---------------|
| 请求模式 | 单轮 request-response | 多轮对话，轮数不确定（8-64+ 轮） |
| KV-cache | 每次请求独立 | Prefix cache 跨轮复用，命中率影响巨大 |
| 计算特征 | prefill 一次 + decode 一次 | 每轮都有 incremental prefill + decode |
| Context 增长 | 固定 ISL/OSL | context 随轮次单调增长（累积工具结果） |
| 延迟定义 | TTFT + TPOT | 端到端 task completion time |
| 吞吐定义 | tokens/s | tasks completed/s 或 useful tokens/s |
| 初始 Prompt | 较短（百~千 tokens） | 很长（Cursor system prompt ~16K tokens） |
| 轮间行为 | 无 | 工具执行暂停（0.5s - 30s） |

**核心问题：标准 serving 的 Pareto 曲线如何映射到 Agent 场景？Prefix cache、多轮暂停、context 增长如何重塑 Pareto 前沿？**

---

## 2. 系统模型

### 2.1 系统设定

```
                 ┌──────────────────────────────────┐
                 │       LLM Serving System          │
  Session 1 ───→│  (GPU, KV-cache, scheduler)       │
  Session 2 ───→│                                    │
  ...           │  Standard metrics:                 │
  Session C ───→│    Throughput X, Latency R         │
                 └──────────────────────────────────┘
```

**C 个并发 Agent sessions**，每个 session 的生命周期：

```
Session i: [Turn 1] ──Z₁──→ [Turn 2] ──Z₂──→ ... ──→ [Turn Nᵢ] → done
```

- **Turn j**: 一次 LLM 推理（prefill + decode），耗时 R_j
- **Z_j**: 轮间暂停（tool execution、外部 API 调用），不同 session 不同 turn 的 Z_j 各不相同

### 2.2 Context 增长模型

每一轮 Agent 与工具交互都会累积新的 context：

```
Turn j 的 context 长度:
  L(j) = L₀ + Σₖ₌₁ʲ⁻¹ [OSL(k) + ΔL_tool(k)] + ΔL_tool(j)
         \_/   \________________________________/   \________/
       初始      前面所有轮的累积 output + 工具结果      本轮新增
       prompt
       (16K+)
```

典型值（代码 Agent，初始 prompt 16K）：

| Turn | 累积 context | 本轮新增 ΔL | 本轮输出 OSL |
|------|-------------|-------------|-------------|
| 1 | 16,000 | 16,000 | 128 |
| 5 | 24,512 | 2,128 | 128 |
| 10 | 35,152 | 2,128 | 128 |
| 15 | 45,792 | 2,128 | 128 |
| 20 | 56,432 | 2,128 | 128 |

每轮 agent 输出约 128 tokens（function call + 简短推理），工具返回约 2000 tokens（文件内容/搜索结果）。

### 2.3 Prefix Cache 的影响

```
Without prefix cache:  prefill 整个 L(j) ──→ O(L²) attention
With prefix cache:     prefill 仅 ΔL(j)  ──→ O(ΔL × L) cross-attention
                                               ↑ 小得多
```

Prefix cache 让每轮的 TTFT 从处理 **完整 context**（可能 50K+ tokens）降低到只处理**增量 tokens**（~2K tokens），这是 Agent serving 特有的关键优化。

---

## 3. 数学推演

### Step 1: 封闭排队模型（Closed-Loop Queuing）

Agent 系统天然是一个**封闭排队系统**（closed-loop / think-time model）。每个 session 不断循环：

```
      ┌─→ [等待排队] → [Prefill] → [Decode] → [返回结果] ─┐
      │         响应时间 R(j)                               │
      │                                                     ↓
      └──────────── [工具执行 / 暂停 Z(j)] ←────────────────┘
```

由 **Little's Law 的封闭系统形式**（Operational Analysis）：

```
X = C / (R + Z)
```

其中：
- X: 系统的 turn-level throughput（turns/s）
- C: 并发 session 数
- R: 平均 per-turn 响应时间（排队 + prefill + decode）
- Z: 平均轮间暂停时间

反解得到 **Pareto 关系的基本形式**：

```
R = C / X - Z
```

这就是 Agent Pareto 曲线的方程。R vs X 的关系被 C 和 Z 参数化。

### Step 2: 暂停时间 Z 如何移动 Pareto 曲线

固定 C = 32 个并发 session，不同的平均暂停时间：

```
Turn Throughput X (turns/s)  ↑
                              │
   Z=0 (无暂停,              │ ╱ 
    理论上界)                 │╱    ← 标准 serving 的 Pareto
                              │
   Z=0.5s (快工具,           │  ╱
    代码执行)                 │ ╱
                              │╱
   Z=2s (中等工具,           │  ╱
    文件读写)                 │ ╱
                              │╱
   Z=10s (慢工具,            │    ╱
    web browsing)             │   ╱
                              │  ╱
                              └──────────────────→ Per-Turn Latency R (ms)
```

**关键洞察**：暂停时间 Z **右移**了 Pareto 曲线，也**降低**了有效吞吐量上界。

固定 R 时：X = C / (R + Z)
- Z = 0: X_max = C / R_min
- Z = 2s, R_min = 1s: X_max = 32 / 3 = 10.7 turns/s
- Z = 10s, R_min = 1s: X_max = 32 / 11 = 2.9 turns/s

**暂停时间长 → 吞吐量天花板急剧下降，但 GPU 有空余容量可以塞更多 session。**

### Step 3: 动态并发 —— 暂停期间塞入更多 session

定义**活跃比** ρ：

```
ρ = R / (R + Z)
```

即一个 session 有多少比例时间在消耗 GPU 计算。

```
Session 1: [██████]────────[██████]────────[██████]────────
Session 2: ──[██████]────────[██████]────────[██████]──────
Session 3: ────[██████]────────[██████]────────[██████]────
Session 4: ──────[██████]────────[██████]────────[██████]──
           ↑                                              
           GPU sees continuous work if C > 1/ρ             
           (█ = GPU active, ─ = paused/tool exec)
```

**有效 GPU 并发** = C × ρ = C × R / (R + Z)

为了保持 GPU 满载（有效并发 = B_max）：

```
C_needed = B_max / ρ = B_max × (1 + Z / R)
```

| Z (暂停) | R (响应) | ρ (活跃比) | 需要的 C 来保持 GPU 满载 (B=32) |
|----------|---------|-----------|-------------------------------|
| 0s | 2s | 100% | 32 |
| 0.5s | 2s | 80% | 40 |
| 2s | 2s | 50% | 64 |
| 10s | 2s | 17% | 192 |

### Step 4: KV-Cache 内存墙 —— Agent 的真正瓶颈

每个活跃 session（无论在计算还是暂停中）都需要在 GPU 上保留 KV-cache。

**KV-cache per session**：

```
M_kv(j) = 2 × n_layers × n_kv_heads × d_head × L(j) × sizeof(dtype)
```

对 70B 模型（80 layers, 8 KV heads via GQA, d=128, FP16）：

```
KV per token = 2 × 8 × 128 × 80 × 2 bytes = 327,680 bytes ≈ 320 KB/token
```

| Turn | Context L(j) | KV-cache/session | 32 sessions 总占用 |
|------|-------------|------------------|-------------------|
| 1 | 16K | 5.1 GB | 163 GB |
| 10 | 35K | 11.2 GB | 358 GB |
| 15 | 46K | 14.7 GB | 470 GB |
| 20 | 56K | 17.9 GB | 573 GB |

8×H100 总显存 = 640 GB，模型权重占 ~140 GB (FP16)，可用 KV-cache 约 **500 GB**。

**这意味着**：
- Turn 1 时，可以支持 500 / 5.1 ≈ **98 个并发 session**
- Turn 10 时，可以支持 500 / 11.2 ≈ **44 个并发 session**
- Turn 20 时，可以支持 500 / 17.9 ≈ **27 个并发 session**

**关键洞察**：Agent 的 context 增长导致 KV-cache 挤占内存，可支持的并发 session 数在 task 生命周期内持续下降。这是 Agent serving 独有的动态约束。

### Step 5: Prefix Cache 对 Pareto 的双重影响

**影响 1：降低 per-turn latency（R 减小）**

```
Without prefix cache (turn 15, L=46K):
  TTFT = prefill(46,000 tokens) ≈ 800ms (at batch=1)
                                 ≈ 3,000ms (at batch=32)

With prefix cache (turn 15, ΔL=2,128):
  TTFT = incr_prefill(2,128 tokens) ≈ 38ms (at batch=1)
                                     ≈ 120ms (at batch=32)
```

TTFT 差异：800ms → 38ms（21× 提速）。

**影响 2：Cache 命中率取决于暂停时间 Z**

```
Cache hit rate h(Z):

 h  1.0 ┤████████████████████████████
        │                            ╲
    0.8 ┤                             ╲
        │                              ╲
    0.5 ┤                               ╲
        │                                ╲
    0.2 ┤                                 ╲
        │                                  ╲______
    0.0 ┤
        └──┴──┴──┴──┴──┴──┴──┴──┴──┴──→ Z (暂停时间)
          0  1  2  5  10  20  30  60 sec
              ↑           ↑
        cache 安全区   cache 开始被 evict
```

暂停时间短 → cache 命中率高 → prefill 快 → latency 低

暂停时间长 → cache 被 evict → 全量 re-prefill → latency 高

这形成一个**正反馈环**：

```
Z ↑ ⟹ h ↓ ⟹ R ↑ ⟹ ρ ↓ ⟹ C_needed ↑ ⟹ memory pressure ↑ ⟹ h ↓
```

### Step 6: Per-Turn Latency 分解

每一轮的 LLM 推理延迟可以分解为：

```
R(j) = TTFT(j) + TPOT(B_eff) × OSL
```

**TTFT（Time To First Token）**：

```
T_prefill(j) = h(Z) · T_incr(ΔL_j) + (1 - h(Z)) · T_full(L_j)
```

其中 T_incr 和 T_full 由算子级模型决定：

```
TTFT(L) = 2 × active_params × L / total_FLOPS / η_prefill
```

η_prefill ≈ 0.65（prefill 是 compute-bound，大 kernel 摊薄了 launch 开销，效率高于 decode）。

**TPOT（Time Per Output Token）**：

由 decode step time 决定，受 memory bandwidth 限制：

```
step_time_ideal = max(T_weight_load + T_kv_load, T_compute)

T_weight_load = active_params × dtype_bytes / total_bandwidth   [恒定]
T_kv_load     = B × L_avg × kv_bytes_per_token / BW            [随 batch 和 context 增长]
T_compute     = 2 × active_params × B / total_FLOPS             [随 batch 增长]

TPOT = step_time_ideal / η_decode
```

其中 η_decode ≈ 0.40 是 decode 效率因子，补偿 roofline 模型未覆盖的实际开销：

| 开销来源 | 典型值 (70B, TP=8) | 说明 |
|----------|-------------------|------|
| TP all-reduce 通信 | ~4-6ms | 每层 2 次 all-reduce × 80 层，每次 ~30μs latency |
| Kernel launch | ~2-3ms | 每层 10+ kernel × 80 层 = 800+ kernel launches |
| 非 matmul 算子 | ~1-2ms | LayerNorm, RoPE, activation, residual add |
| 内存管理 | ~0.5-1ms | Paged attention, cache lookup |

**验证**：70B FP16, 8×H100, B=1
- T_weight = 140GB / 26,800 GB/s = 5.22ms
- TPOT_ideal = 5.22ms
- TPOT_actual = 5.22 / 0.40 = **13.1ms**（实测 ~12-15ms ✓）

### Step 7: 完整的 Agent Pareto 方程组

**1) Turn-level throughput-latency（封闭排队）**：
```
X_turn = C_eff / (R_avg + Z_avg)
```

**2) Per-turn latency（随 turn 编号 j 变化）**：
```
R(j) = T_prefill(j) + TPOT(B_eff) × OSL + T_queue(X, C)
```

**3) Prefill 时间（取决于 cache 命中）**：
```
T_prefill(j) = h(Z) · T_incr(ΔL_j, B_eff) + (1 - h(Z)) · T_full(L_j, B_eff)
```

**4) KV-cache 内存约束**：
```
C_eff = min(C, ⌊M_avail / M̄_kv(j)⌋)
```

其中 M̄_kv(j) = kv_bytes_per_token × L̄(j)，L̄(j) 是所有活跃 session 的平均 context 长度。

**5) Task-level 映射**：
```
T_task = Σ_{j=1}^{N} [R(j) + Z(j)]
X_task = X_turn / N̄
```

### Step 8: 数值推演 —— 三种 Agent 场景对比

**硬件**: 70B 模型, 8×H100

| 参数 | Code Agent | Research Agent | Deep Reasoning |
|------|-----------|---------------|----------------|
| 并发 C | 32 | 16 | 8 |
| 平均轮数 N | 8 | 15 | 20 |
| 暂停 Z | 0.5s (代码执行) | 5.0s (web 搜索) | 1.0s (思考链) |
| 初始 prompt L₀ | 16K | 24K | 32K |
| ΔL per turn | 500 tok | 3000 tok | 4000 tok |
| OSL per turn | 128 tok | 64 tok | 4096 tok |
| 最终 context | ~21K | ~70K | ~113K |
| Cache 命中率 | ~95% | ~70% | ~85% |
| 活跃比 ρ | ~67% | ~12% | ~82% |

**推演结果**（含效率因子 η_decode=0.40, η_prefill=0.65）：

| 指标 | Code Agent | Research Agent | Deep Reasoning |
|------|-----------|---------------|----------------|
| TTFT (有 cache) | ~55ms | ~200ms | ~175ms |
| TTFT (无 cache) | ~580ms | ~3,800ms | ~6,200ms |
| TPOT | ~13ms | ~14ms | ~18ms |
| Per-turn latency R | ~1.7s | ~1.1s | ~74s |
| GPU 利用率 | ~77% | ~18% | ~99% |
| Max sessions (KV) | ~73 | ~21 | ~13 |
| Token throughput/GPU | ~155 tok/s | ~7.5 tok/s | ~36 tok/s |

**关键观察**：
- Code Agent: 快速工具 + 短暂停 → GPU 利用率尚可，但不满载
- Research Agent: 慢工具 → GPU 大量空闲（88%），需要更多 session 填满
- Deep Reasoning: 长输出 → 高 GPU 利用率，但 KV-cache 快速膨胀限制并发

### Step 9: 标准 Serving ↔ Agent Serving 的映射公式

从标准 serving 的 Pareto 数据可以直接推导 Agent 场景的性能：

```
X_agent = X_serving(effective_ISL, OSL, B_eff) / N × 1 / (1 + Z/R)
```

即：标准 serving 的吞吐量 → 除以平均轮数 N → 再乘以活跃比 ρ = R/(R+Z)。

如果有 AIConfigurator 对某个模型/硬件的标准 Pareto 数据，可以用这个公式将它映射到 Agent 场景下的 Pareto。

---

## 4. 关键结论

### 4.1 Z（暂停时间）决定 Pareto 曲线位置

Z 越大，曲线右移且下压。但这意味着 GPU 有大量空闲——可以通过增加并发 C 来填满，前提是 KV-cache 内存允许。

### 4.2 Prefix Cache 是 Agent Pareto 的"杠杆点"

- 有 cache 时：TTFT 几乎不随轮次增长，Pareto 曲线稳定
- 无 cache 时：后期轮次 TTFT 暴增，Pareto 曲线随 session 寿命恶化
- **Cache 命中率本身是暂停时间 Z 和并发 C 的函数**——这个耦合关系是 Agent 独有的

### 4.3 KV-Cache 内存是隐藏的"第三维度"

标准 Pareto 是 2D（throughput vs latency），但 Agent 场景需要加上第三个约束轴：**KV-cache memory / 最大并发 session 数**。一个看似很好的 throughput-latency 配置点可能因为 KV-cache 溢出而不可行。

### 4.4 初始 Prompt 的影响被低估

现代 agent 系统的 system prompt 非常长（Cursor ~16K tokens, Claude Code 类似），这意味着：
- 即使第一轮的 TTFT 也不低（16K tokens 的 prefill）
- KV-cache 的基线占用就很高（16K × 320KB = 5.1 GB/session for 70B）
- Prefix cache 对 system prompt 部分几乎总是命中的，这是 agent 的天然优势

### 4.5 MoE 模型改变 Pareto 形态

对于 MoE 模型（如 Kimi K2.5, 1T total / 32B active）：
- **计算**: 由 active params (32B) 决定 → TTFT/TPOT 类似小模型
- **带宽**: 每步只加载 active expert 权重 → 类似小模型
- **内存**: 所有 expert 驻留显存 → 类似大模型（1T × FP4 = 500GB）
- **KV-cache**: 由层数和 head 数决定，与 total params 关系不大

MoE 在 Agent 场景下的优势：计算快（active params 少）+ 内存大（但总显存要求高）→ 适合高并发 agent workload，前提是硬件显存足够。

---

## 5. 性能模型详解（交互工具实现）

[Agent Serving Pareto Explorer](/tools/agent-pareto.html) 基于以下性能模型实现：

### 5.1 TTFT 模型（Prefill, compute-bound）

```
TTFT(L) = 2 × active_params × L / total_FLOPS / η_prefill    (η_prefill ≈ 0.65)
```

- active_params: 对 dense 模型等于 model_size，对 MoE 等于 active_size
- total_FLOPS: 根据模型精度自动选择 FP16/FP8/FP4 TFLOPS
  - FP4 模型在 B200/MI355X 上使用 FP4 TFLOPS（原生支持）
  - FP4 模型在 H100/H200 上回退到 FP8 TFLOPS（解量化执行）

### 5.2 TPOT 模型（Decode, memory-bound）

```
step_time = max(T_weight + T_kv, T_compute)

T_weight  = active_params × dtype_bytes / total_bandwidth
T_kv      = B_eff × L_avg × kv_bytes_per_token / total_bandwidth
T_compute = 2 × active_params × B_eff / total_FLOPS

TPOT = step_time
```

### 5.3 闭环稳态求解

对于给定的并发 C，通过迭代求解稳态 B_eff：

```
repeat:
    tpot = computeStepTime(B_eff, L_avg, hw)
    R = TTFT + tpot × OSL
    ρ = R / (R + Z)
    B_eff_new = C × ρ
until converged
```

### 5.4 硬件参数

| GPU | HBM BW | FP16 TFLOPS | FP8 TFLOPS | FP4 TFLOPS | VRAM |
|-----|--------|-------------|------------|------------|------|
| H100 SXM | 3,350 GB/s | 989 | 1,979 | — | 80 GB |
| H200 SXM | 4,800 GB/s | 989 | 1,979 | — | 141 GB |
| B200 | 8,000 GB/s | 2,250 | 4,500 | 9,000 | 192 GB |
| MI355X | 8,000 GB/s | 2,500 | 5,000 | 10,000 | 288 GB |

---

## 6. 参考资料

### 论文

1. **AIConfigurator** (2601.06288): *Lightning-Fast Configuration Optimization for Multi-Framework LLM Serving*. NVIDIA, 2025.
   - 算子级性能建模方法论，Pareto 分析框架
   - [Paper Reading Notes](/papers/2601.06288.html)

2. **Sutradhara** (2601.12967): *An Intelligent Orchestrator-Engine Co-design for Tool-based Agentic Inference*. 2026.
   - Orchestrator-engine co-design for agent serving
   - prompt splitting, prefill-tool overlap
   - [Paper Reading Notes](/papers/2601.12967.html)

3. **DualPath** (2602.21548): *Breaking the Storage Bandwidth Bottleneck in Agentic LLM Inference*. 2026.
   - Dual-path KV-Cache loading for PD-disaggregated agent inference
   - [Paper Reading Notes](/papers/2602.21548.html)

4. **DynaServe** (2504.09285): *Unified and Elastic Execution for Dynamic Disaggregated LLM Serving*. 2025.
   - Micro-request abstraction, two-level scheduling
   - [Paper Reading Notes](/papers/2504.09285.html)

### 硬件白皮书

5. **NVIDIA Blackwell Architecture**: B200 spec, FP4 Tensor Core
   - [Paper Reading Notes](/papers/nv-blackwell-whitepaper.html)

6. **AMD CDNA 4 Architecture**: MI355X spec, MXFP4/FP8
   - [Paper Reading Notes](/papers/amd-cdna4-whitepaper.html)

### 排队论基础

7. **Lazowska et al.** *Quantitative System Performance* (1984). Closed-loop queuing models, MVA.

8. **Little's Law**: L = λW. 封闭系统形式: X = C / (R + Z).

### Agent 系统

9. **Cursor IDE**: System prompt ~16K tokens, multi-turn code agent
10. **Claude Code** (Anthropic): CLI-based coding agent, similar prompt structure
11. **OpenAI Agents SDK**: Multi-agent workflow framework
    - [Code Reading Notes](/papers/openai-openai-agents-python.html)

---

## 7. 修订历史

| 日期 | 变更 |
|------|------|
| 2026-04-17 | 初始版本：完整推演 + 交互工具 |
