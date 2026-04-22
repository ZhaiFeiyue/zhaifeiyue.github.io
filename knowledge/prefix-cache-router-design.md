# Prefix-Cache-Aware Router 设计：从现有方案到 Tier-Aware Cost Model

> **作者**: Feiyue Zhai
> **日期**: 2026-04-21
> **标签**: LLM serving, router, prefix cache, KV cache, scheduler, cost model, agent serving

---

## 0. TL;DR

调研了三大开源 router 的实现（NVIDIA Dynamo `kv-router` / SGLang `sgl-model-gateway` / llm-d GAIE-EPP），把 prefix-cache-aware 路由的设计空间拆成 **索引 / 信号 / 决策（cost model）/ 工程形态** 四层。

**结论**：

1. 三家在**索引层**（radix tree / positional indexer / KV-events）已经卷得很充分，工程基本可复用。
2. 在**决策层（cost model）**——尤其是「prefix 命中收益 × in-flight load 代价 × tier 感知 × workflow 感知」的统一建模——**全部不完整**。Dynamo 最系统但只用线性项；SGLang 只看 char 长度比；llm-d 是加权 scorer 拼接，无法表达非线性耦合。
3. 学术界已经给了所有需要的元素：Justitia 的 $c = pd + d^2/2$ 给了正确的 KV-time cost；ThunderAgent 的 recompute $\propto c^2$ + Cauchy 函数式方程证明指数衰减是唯一 admissible decay；Pancake/Concur/KVFlow 给了 tier 之间应该如何切换的实证；PrfaaS 把 cost model 推到了跨 DC。
4. 把这些拼起来，我提出一个 6 项 cost model：
   $$
   \text{Logit}(w, r) = \underbrace{\alpha_p \cdot p_{\text{eff}}(w,r)}_{\text{prefill}} \;+\; \underbrace{\alpha_d \cdot d(r) + \alpha_{d^2} \cdot \tfrac{d(r)^2}{2}}_{\text{decode + KV time}} \;+\; \underbrace{\sum_{t \in \text{tiers}} \alpha_t \cdot \text{LoadFromTier}(w, r, t)}_{\text{tier-aware}} \;+\; \underbrace{\alpha_{ho}\cdot HO(w)}_{\text{head-of-line}} \;-\; \underbrace{\alpha_{wf}\cdot \text{Affinity}_{wf}(w, r)}_{\text{workflow}}
   $$
   每一项都是可在线 fit 的标量，参数会随 engine 类型（vLLM/SGLang/TRT-LLM）和硬件（HBM/PCIe/NVLink/RDMA 带宽）自适应。
5. 实现路径：在 Dynamo `kv-router` 的 `DefaultWorkerSelector` 上替换 logit 函数，是工程量最小、收益最高的切入点。

---

## 1. 三家现有方案的核心架构（cost-model 视角）

### 1.1 SGLang `sgl-model-gateway`（approximate 派）

**索引**：每 model 一棵 char-level radix tree，存请求 raw text；DashMap per-model；后台 LRU eviction（`max_tree_size=10000` 节点，`eviction_interval=30s`）；多 router 实例通过 mesh `TreeOperation::{Insert, Remove}` 事件同步。

**信号**：纯**观察**——router 看到什么 text 就插入哪棵 tree，**不和 engine 通讯**。

**决策函数**（`policies/cache_aware.rs::select_worker`）：
```
is_imbalanced = (max_load - min_load) > abs_thr  AND  max_load > min_load * rel_thr
if is_imbalanced:
    selected = argmin_w  worker.load()                    # shortest queue
else:
    match_rate = matched_chars / input_chars
    if match_rate > cache_threshold (=0.5):
        selected = the worker holding the longest matching tenant
    else:
        selected = argmin_w  tree.size(w)                  # 最空闲 cache
```

**cost-model 角度的特点**：
- **没有真正的 cost function**——只是两条规则的开关。
- 用 `worker.load()`（pending 计数）代表 "load"，**完全不区分 prefill 还是 decode、不感知 token / block**。
- "match_rate" 是 **char 级**比例，和真实 KV block hit 之间有显著漂移。
- 没有 queueing 模型，没有 head-of-line 惩罚。

### 1.2 NVIDIA Dynamo `lib/kv-router`（precise 派 + 完整 cost）

**索引**（`indexer/`）：四元组 `(LocalBlockHash, ExternalSequenceBlockHash, WorkerId, Position)`；四种实现可选——`RadixTree` / `ConcurrentRadixTree`（read 并发 + sticky 写线程）/ `PositionalIndexer`（DashMap + jump 优化 O(D/J)）/ `ThreadPoolIndexer`（写 sticky 读 inline）；声称 >10M events+requests/s、p99 <10µs。

**信号**：engine 通过 KV events `RouterEvent::{Stored, Removed}` 推送，block hash 由 engine 给定（含 LoRA id、multimodal hash）。Router 维护 "which worker has which block"。`PruneManager` 做 TTL + 2^20 size + 0.8 ratio 三重 pruning。

**决策函数**（`scheduling/selector.rs::DefaultWorkerSelector`）：

$$
\text{logit}(w) = \alpha \cdot \frac{p_{\text{new}}(w)}{B} + d(w)
$$

其中：
- $\alpha = $ `overlap_score_weight`（默认 1.0），可按请求 override；
- $p_{\text{new}}(w) = \max(0, \text{ISL} - \text{overlap}(w) \cdot B)$，**新需要 prefill 的 token 数**；
- $B = $ block size（如 64 token/block）；
- $d(w) = $ `decode_blocks(w)`——**`ActiveSequences` 跟踪在飞请求 KV 占用**（这是 Dynamo 和 SGLang 最大差别），由 `sequences/multi_worker.rs` 维护，per dp_rank。

**Selector 行为**：
- `temperature == 0`：$w^* = \arg\min_w \text{logit}(w)$；
- `temperature > 0`：softmax 抽样，`P(w) \propto \exp(-\text{logit}(w) / (\tau \cdot \text{range}))`，**显式抗羊群**；
- Tie-break: `tree_size` 最小者；
- 支持 per dp_rank 粒度。

**Queue policy**（`scheduling/policy.rs`，与 selector 解耦）：
- `FcfsPolicy`: $\text{key} = \text{priority\_jump} - \text{arrival\_offset}$（优化 tail TTFT）；
- `WsptPolicy`（Smith 1956）: $\text{key} = \dfrac{1 + \text{priority\_jump}}{\max(1, \text{ISL} - \max_w \text{overlap}(w) \cdot B)}$ —— **隐含 cache-aware**，命中越多有效 ISL 越短，越早调度。
- `router_queue_threshold`=2.0：所有 worker 超过 `max_num_batched_tokens · threshold_frac` 才排队，否则 ready 直发。

**cost-model 角度的特点**：
- **全开源里最系统**：把 prefill cost 和 in-flight decode cost 加在一起，并用 ActiveSequences 追踪。
- **但只到一阶**——decode 项是 `decode_blocks` 的**线性**函数。Justitia 论文已经证明，对 vLLM-类引擎正确的形式应该是 $c = pd + d^2/2$，二次项主导。
- **没有 tier**——所有 cache 默认在 HBM，没办法表达 "在 CPU RAM"、"在 NVMe"、"已迁出"。
- **没有 workflow** —— agent 多轮 / tool return 之后路由不能利用 STE 类信号。

### 1.3 llm-d / GAIE-EPP（K8s 插件派）

**形态**：Istio / agentgateway → EPP (Endpoint Picker Plugin)→ vLLM pod。EPP 实现可选 upstream 标准镜像或 `llm-d-inference-scheduler`（扩展 GAIE）。

**索引（两条路径）**：

| 路径 | scorer | 数据来源 |
|---|---|---|
| Inference-scheduling（默认） | `approximate-prefix-cache-scorer` | 观察流量 |
| Precise-prefix-cache-aware | `precise-prefix-cache-scorer` | vLLM **ZMQ KV events** + **UDS tokenizer sidecar** + **speculative indexing**（engine confirm 前 optimistic 插入） |

**决策函数**（典型 precise profile，见 `gaie-kv-events/values.yaml`）：
$$
\text{score}(w) = 3.0 \cdot s_{\text{prefix}}(w) + 2.0 \cdot s_{\text{kv-util}}(w) + 2.0 \cdot s_{\text{queue}}(w)
$$
$\rightarrow$ `max-score-picker` argmax。

其中：
- $s_{\text{prefix}} \in [0, 1]$：精确前缀命中比例；
- $s_{\text{kv-util}}$：vLLM 自报 KV cache 利用率（间接 in-flight load）；
- $s_{\text{queue}}$：vLLM 自报 pending 队列长度。

**其它 profile handlers**：`pd-profile-handler`（PD-disagg 路由 + selective PD 阈值）、`predicted-latency-based-scheduling`、`tiered-prefix-cache`（HBM→CPU→盘→共享存储 via NIXL/CephFS/Lustre）。

**cost-model 角度的特点**：
- 加权和便于调参，但**无法表达非线性耦合**（如二次项、tier 切换的非凸性）。
- `kv-cache-utilization-scorer` 的粒度是**百分比**，比 Dynamo 的 `decode_blocks` 计数粗。
- 有 `tiered-prefix-cache` 在存储侧，**但 router 的决策函数里完全没有 tier 项**——只是 vLLM engine 内部决定从哪一层拉，对外 router 看起来还是 "命中 / 未命中"。
- speculative indexing 的 reconcile 协议未公开（请求被拒/失败时索引会 stale）。

### 1.4 三家横向对比（聚焦 cost model）

| 维度 | SGLang | Dynamo | llm-d |
|---|---|---|---|
| Cost form | 规则切换 | 单 logit 线性 | 加权和 |
| Prefill term | 无 | $\alpha\cdot p_{\text{new}}/B$ | $w_p \cdot s_{\text{prefix}}$ |
| Decode in-flight | `worker.load()` 计数 | `decode_blocks(w)` 精确 | KV util 百分比 |
| Quadratic decode? | ❌ | ❌（应有）  | ❌ |
| Queue penalty | 无 | $w_q\cdot s_{\text{queue}}$ |
| Tier 感知 | ❌ | ❌ | tiered storage 但 router 不感知 |
| Workflow / agent | ❌ | `priority_jump` 字段 | ❌ |
| 抗羊群 | imbalance fallback | softmax temperature | ❌ |
| LoRA | ❌ | engine block hash 含 LoRA id | engine 决定 |

---

## 2. Cost Model 的现有学术结论（精确公式）

下面整理我们 paper-db 里**直接给出 cost model 数学形式**的工作，按建模维度分类。

### 2.1 KV token-time cost（Justitia, arXiv 2510.17015）

Justitia 严格论证了 **vLLM-类引擎（paged attention）的真实瓶颈是 KV memory，不是 compute**。它给出的请求级 cost：

$$
c = p \cdot d + \frac{d^2}{2}
$$

- $p$: prompt（prefill）token 数；
- $d$: decode token 数（output length）。

**推导直觉**：把 KV "占着 memory 但还在生成" 的时间积分。每个 decode step $i$ 释放给 batch 用的 KV slots 是已经生成的 $p + i$，整个 decode 阶段 KV 占用对时间的积分是 $\int_0^d (p + i) \, di = pd + d^2/2$。

**ablation**：把它换回 VTC 的 $p + 2d$ 线性 cost，**JCT 退化 42.3%**。

**对 router 的意义**：Dynamo 当前的 `logit = α·p_new/B + decode_blocks` 的 decode 项**应该是二次的**。一个简单替换是：

$$
\text{logit}_{\text{Justitia-aware}}(w, r) = \alpha \cdot p_{\text{new}}(w, r) + \sum_{r' \in \text{active}(w)} \big[ p(r') \cdot \hat{d}_{\text{rem}}(r') + \tfrac{1}{2}\hat{d}_{\text{rem}}(r')^2 \big]
$$

其中 $\hat{d}_{\text{rem}}(r')$ 是 active 请求 $r'$ **剩余** decode token 的预估（用 JITServe 的 QRF 或 agent hints）。

### 2.2 Recompute cost（ThunderAgent, arXiv 2602.13692）

ThunderAgent 把 STP（serving-time-product）拆成 productive vs wasted：

$$
\text{STP} = \underbrace{T_{\text{decode}} + T_{\text{prefill}}}_{\text{productive}} + \underbrace{T_{\text{recompute}} + T_{\text{unused}} + T_{\text{caching}}}_{\text{wasted}}
$$

关键论断：当 KV 被 evict 后再 prefill，**recompute cost 与上下文长度 $c$ 平方成正比**：

$$
\text{Cost}_{\text{recompute}}(c) \propto c^2
$$

证明 shortest-first eviction 是 strictly optimal —— 因为 cost function 是 convex super-additive，按短 program 先清正好最小化总和。

进一步，证明在 memoryless tool latency 假设下，"discount KV 占用" 的最优函数形式**只能是指数衰减**（用 Cauchy 函数式方程 $f(t+\delta) = f(t) f(\delta)$）：

$$
f(t) = e^{-\lambda t}
$$

**对 router 的意义**：当 router 知道**这台 worker 的 KV 已经被 evict，但还在 CPU RAM 里**，重路由它的 cost 不是 0（线性 fetch），也不是 $p_{\text{new}}$（完全重算），而是**取决于上次访问到现在的时间衰减后的剩余概率**。

### 2.3 KVFlow STE: workflow-aware priority

KVFlow 把 **Steps-To-Execution** 概念引入 KV 优先级。每个 agent 节点 $v$ 在 step graph 上有一个 STE 值（用 max+1 / min+1 聚合，统一 DAG / cycle / branch），然后**下推到 KV 节点**：

$$
\text{STE}_{\text{kv-node}} = \min_{v \in \text{users}(\text{node})} \text{STE}(v)
$$

对 prefix tree 节点，**取所有 share 它的 agent 中最小 STE**。

**对 router 的意义**：传统 LRU 在 cyclic / sequential agent 中**结构性错误**——刚被使用的 agent 正是下一个要被调用的，按 LRU 把它的 KV 踢掉等于自残。Router 在选 worker 时也该用同样信号——**优先把请求送到当前 STE 较小的 prefix 持有者**。

### 2.4 Tier latency model（Pancake / Concur / ThunderAgent / PrfaaS）

**Pancake** 给出了 GPU vs CPU 的一个具体实测 cross-over：每 cluster **256–512 vectors** 是 CPU↔GPU 的盈亏点，Pancake 用 $B_{\text{insert}}=128$ 来让 CPU buffer 完全 hide 在 GPU compute 后。这是 ANN memory 的数字，但**逻辑可以平移**——存在一个 **block 数阈值**，在阈值以下 CPU→GPU 拉回比重算便宜，以上反过来。

**Concur** 给了一个反直觉但很硬的实证：**在 agentic batch inference 高并发下**，HiCache 类 CPU offload **比 baseline 慢 3×**（可降到 0.34× speed），原因是 PCIe 在大并发下根本饱和不住。这意味着 tier cost **不是常数**，而是**带宽争用的函数**：

$$
T_{\text{load-from-CPU}}(\text{size}) = \frac{\text{size}}{\text{BW}_{\text{PCIe}}^{\text{eff}}(\text{concurrency})}
$$

且 $\text{BW}^{\text{eff}}$ **随 concurrency 显著退化**。

**ThunderAgent** 进一步给出一个**否定结论**：对 agent 工作负载，**KV offload 到 CPU/SSD 拯救不了** —— "PCIe bandwidth is insufficient for high-frequency context switches"。同时 PD-disagg 在 agent 上反而 trigger thrashing（prefill-only / decode-only 池都只有部分 HBM）。

**PrfaaS** 把 tier 推到跨 DC：hybrid attention 把 KV throughput 缩到 3-8 Gbps 后，commodity Ethernet 跨 DC 也能做 PD。它给的 throughput 模型是：

$$
\Lambda_{\max} = \min\Big(\frac{\Theta_{\text{prfaas}}}{p}, \frac{\Theta_{\text{pdp}}}{1 - p}, \Theta_{\text{pdd}}\Big)
$$

$p$ 是被路由到 PrfaaS 集群的请求比例。**最优 $p$ 满足路径平衡**（Eq.7），最优 $N_p / N_d$ 满足产消平衡（Eq.8）。

**对 router 的意义**：tier-aware cost 不是简单的加项，而是要建模带宽**争用**：

$$
\text{LoadCost}(t, w, \text{size}) = \frac{\text{size}}{\text{BW}_t \cdot \rho_t(w)}
$$

其中 $\rho_t(w) = $ 当前 tier $t$ 在 worker $w$ 的链路上的有效带宽利用率（≤1，越高越拥塞）。

### 2.5 Halo: 工作流编译态 cost（arXiv 2603.16104）

Halo 把 batch agentic 看成数据库查询计划，cost decompose 成 $T_{\text{prep}} + T_{\text{model}} + T_{\text{infer}}$，用 epoch DP solver 全局优化（**plan pruning 单项贡献 -23.35%**，比所有 cache 机制都大）。它的 Templated Radix Tree 同时编码 prompt prefix 和 operator dependency，可以做 **dual-prefix reuse**（system prompt 外层 + per-query context 内层）。

**对 router 的意义**：在线 router 难以做 Halo 那样的全局 DP，但**可以引入"短窗口 coalescing"**——把相同 prefix 的请求在 50ms 窗口内 batch prefill 一次（缺口 cost = $T_{\text{prefill}}(N \cdot \text{ISL})$ 而不是 $N \cdot T_{\text{prefill}}(\text{ISL})$，前者远小）。

---

## 3. 缺什么：现有 cost model 的六个 gap

| Gap | 现状 | 应有 | 对应论文 |
|---|---|---|---|
| G1. 二次 decode 项 | 三家都线性 | $pd + d^2/2$ | Justitia |
| G2. Tier-aware  | 全没有 | 按 tier 的带宽争用 cost | Pancake / Concur / ThunderAgent / PrfaaS |
| G3. Workflow / STE | 全没有 | 按 STE 折扣 KV 占用 | KVFlow |
| G4. Recompute 平方惩罚 | 全没有 | $\propto c^2$ | ThunderAgent |
| G5. 长度不确定性 | 全假设 ISL 已知，OSL 不估 | QRF 上分位预测 | JITServe |
| G6. 跨请求 coalescing | 全没有 | 短窗口聚合 | Halo / Scepsy |

---

## 4. 提出：一个 Tier-Aware + Agent-Aware 统一 Cost Model

### 4.1 总形式

对每个候选 worker $w$ 和到达请求 $r$，cost（越小越优）：

$$
\boxed{
\text{Cost}(w, r) = C_{\text{prefill}} + C_{\text{decode}} + C_{\text{tier}} + C_{\text{HOL}} - B_{\text{workflow}}
}
$$

其中各项的具体形式如下，所有 $\alpha_*$ 是可在线 fit 的标量。

### 4.2 Prefill 项

$$
C_{\text{prefill}}(w, r) = \alpha_p \cdot p_{\text{eff}}(w, r), \quad
p_{\text{eff}}(w, r) = \text{ISL}(r) - \text{HitTokens}(w, r)
$$

其中 `HitTokens` 是 router 索引（radix / positional）查出的 worker $w$ 上**HBM 命中**的 token 数。注意：**不算 CPU/SSD 的 cache 命中**，因为那部分要走 tier-loading 路径。$\alpha_p \approx \frac{1}{\text{prefill\_tput}_w}$（每 token 的实测 prefill 时延）。

### 4.3 Decode 项（Justitia 二次形式）

$$
C_{\text{decode}}(w) = \alpha_d \sum_{r' \in \text{active}(w)} \hat{d}_{\text{rem}}(r')
\;+\; \alpha_{d^2} \sum_{r' \in \text{active}(w)} \frac{\hat{d}_{\text{rem}}(r')^2}{2}
$$

- $\hat{d}_{\text{rem}}(r')$ 来自三种来源（按可用性回退）：
  1. agent hints（`expected_output_tokens` 字段）
  2. JITServe QRF 上分位预测（7ms inference）
  3. 默认 `max_new_tokens` / 2 的保守上界
- $\alpha_d \approx \frac{1}{\text{decode\_tput}_w}$；$\alpha_{d^2} \approx \frac{1}{2 \cdot \text{KV\_capacity}_w}$（KV 占用对吞吐的二阶反馈）。

### 4.4 Tier 项（核心新增）

每个 worker 维护一个**tier 状态**：

$$
\text{Tier}(w, r) \in \{\text{HBM}, \text{CPU}, \text{NVMe}, \text{Remote}, \text{Miss}\}
$$

Router 索引除了 HBM hit，还要订阅 CPU/盘 tier 的事件（vLLM hicache、SGLang HiCache、LMCache 都开始有这类事件）。Tier loading cost：

$$
C_{\text{tier}}(w, r) = \sum_{t \neq \text{HBM}} \alpha_t \cdot \frac{\text{HitTokens}_t(w, r) \cdot \text{KV\_bytes\_per\_token}}{\text{BW}_t(w) \cdot \rho_t(w)}
$$

其中：
- $\text{BW}_t(w)$：tier $t$ 到 worker $w$ HBM 的标称带宽（PCIe Gen5 ≈ 64 GB/s, NVLink ≈ 900 GB/s, RDMA ≈ 50 GB/s, etc.）；
- $\rho_t(w) \in (0, 1]$：当前 tier 链路有效利用率，**这是 Concur 教给我们的关键变量**——offload 在大并发下吞吐塌陷；
- 对 Miss（即 cache 完全无）—— 不进入 $C_{\text{tier}}$，自然落到 $C_{\text{prefill}}$ 全量 prefill 路径。

**关键决策**：tier-aware cost model 让 router 在三个选项间正确选择：
1. 选 worker A：HBM 全命中，但 in-flight load 高 → $C_{\text{prefill}} = 0$，$C_{\text{decode}}$ 大；
2. 选 worker B：CPU RAM 命中，PCIe 空闲 → $C_{\text{prefill}} = 0$，$C_{\text{tier}}$ 中等；
3. 选 worker C：完全未命中，但 in-flight load 最低 → $C_{\text{prefill}}$ 大，$C_{\text{decode}}$ 小。

线性加权和（llm-d 形态）**做不到这一点**——三个选项的得分差异主要靠 `kv-cache-utilization-scorer`，但它感知不了 PCIe 拥塞。

#### 4.4.1 $\rho_t$ 怎么估

每个 worker 上报：
- `tier_bw_used[t]`：最近 $\Delta t$ 窗口内 tier $t$ 实际传输字节数
- `tier_concurrency[t]`：当前 tier $t$ 上的并发 load 操作数

Router 维护 EWMA：
$$
\rho_t(w) \leftarrow \beta \cdot \rho_t(w) + (1 - \beta) \cdot \frac{\text{tier\_bw\_used}}{\text{BW}_t \cdot \Delta t}
$$

进一步，可用 Concur 启发的 **AIMD 阈值**：当 $\rho_t > \rho_{\text{thr}}$（如 0.85）时，**禁用** tier $t$ 的 cache hit 信号，强制 router 落到其它 worker。

### 4.5 Head-of-line / Queue 项

$$
C_{\text{HOL}}(w) = \alpha_{ho} \cdot \max\big(0, Q(w) - Q_{\text{slack}}\big)^2
$$

二次 penalty 抑制极端拥塞 worker。$Q(w)$ 是 worker pending 请求数，$Q_{\text{slack}}$ 是允许的"缓冲队列"长度（如 4）。这个项是**球化**了 Dynamo 的 `router_queue_threshold`——硬切换换成 soft penalty。

### 4.6 Workflow / Agent 收益项

引入 `AgentContext`：

```
AgentContext {
    workflow_id:        u64,
    step_id:            u32,
    expected_next_tools: Vec<ToolName>,
    ste:                u32,        # 来自 KVFlow Step Graph
    last_worker_hint:   Option<WorkerId>,
    paused_kv_age:      Option<Duration>,
}
```

定义 affinity bonus：

$$
B_{\text{workflow}}(w, r) = \alpha_{wf} \cdot \mathbb{1}[\text{last\_worker}(r) = w] \cdot e^{-\lambda \cdot t_{\text{since\_last}}(r)}
$$

这就是**ThunderAgent 的指数衰减直接搬到 router 层**——同一 workflow 在同一 worker 的复用收益随 idle 时间指数衰减（因为 KV 可能已被 evict）。$\lambda$ 由 worker engine 的 cache pressure 决定。

进一步：当 `expected_next_tools` 非空且某 worker 已有这些 tool 对应的 hot prefix（如 system prompt + tool catalog），加二阶 bonus：

$$
B_{\text{wf}}^{(2)}(w, r) = \alpha_{wf}^{(2)} \cdot \frac{|\text{ExpectedHits}(w, r)|}{|\text{expected\_next\_tools}|}
$$

### 4.7 总公式（再写一次，全展开）

$$
\begin{aligned}
\text{Cost}(w, r) =\;& \alpha_p \cdot p_{\text{eff}}(w, r) \\
&+ \alpha_d \sum_{r' \in \text{active}(w)} \hat{d}_{\text{rem}}(r') + \frac{\alpha_{d^2}}{2} \sum_{r' \in \text{active}(w)} \hat{d}_{\text{rem}}(r')^2 \\
&+ \sum_{t \neq \text{HBM}} \alpha_t \cdot \frac{\text{HitBytes}_t(w, r)}{\text{BW}_t(w) \cdot \rho_t(w)} \\
&+ \alpha_{ho} \cdot \max(0, Q(w) - Q_{\text{slack}})^2 \\
&- \alpha_{wf} \cdot \mathbb{1}[\text{last\_worker}(r) = w] \cdot e^{-\lambda t_{\text{since\_last}}} \\
&- \alpha_{wf}^{(2)} \cdot \frac{|\text{ExpectedHits}(w, r)|}{|\text{expected\_tools}|}
\end{aligned}
$$

Selector：$w^* = \arg\min_w \text{Cost}(w, r)$，可加 softmax temperature 抗羊群（Dynamo 已有机制直接复用）。

---

## 5. 参数估计与在线学习

| 参数 | 物理含义 | 估计方式 |
|---|---|---|
| $\alpha_p$ | per-token prefill 时延 | EWMA over engine 上报的 prefill rate; engine-specific |
| $\alpha_d$ | per-token decode 时延 | 同上，decode rate |
| $\alpha_{d^2}$ | KV 占用的二阶 penalty | 拟合 active KV pressure → throughput 退化曲线 |
| $\alpha_t$ (per tier) | 1.0 默认，主要让 BW 起作用 | 标称值即可，靠 $\rho_t$ 反映拥塞 |
| $\text{BW}_t$ | tier 标称带宽 | 配置常数（PCIe / NVLink / RDMA） |
| $\rho_t(w)$ | tier 链路 EWMA 利用率 | per-worker 在线 EWMA |
| $\alpha_{ho}, Q_{\text{slack}}$ | 队列 penalty | grid search 或 SLO-aware 调整 |
| $\alpha_{wf}, \lambda$ | workflow affinity | per-engine 拟合 cache hit rate vs idle time 曲线 |

**在线学习思路**（参考 JITServe 的做法）：
- 把 $(C_{\text{predicted}}(w, r), \text{TTFT}_{\text{actual}}(r), \text{TPOT}_{\text{actual}}(r))$ 入 sliding window；
- 每 $N$ 个完成的请求，做一次 ridge regression 更新 $(\alpha_p, \alpha_d, \alpha_{d^2})$；
- 用 conformal prediction 给 $\hat{d}_{\text{rem}}$ 上限，避免 underprediction（JITServe 已证明 BERT/Llama3 systematically underpredict）。

---

## 6. 与现有项目的实现对接

### 6.1 在 Dynamo `kv-router` 上落地（推荐路径）

最小侵入：**只替换 `selector.rs::DefaultWorkerSelector::select_worker` 的 logit 函数**。其它（indexer / queue / softmax / per-dp-rank）原封不动。

```rust
// 当前（lib/kv-router/src/scheduling/selector.rs）：
let logit = overlap_weight * potential_prefill_block + decode_block;

// 替换为：
let logit = alpha_p * prefill_tokens(w, r)
          + alpha_d  * sum_active_d(w)
          + alpha_d2 * 0.5 * sum_active_d2(w)
          + tier_cost(w, r, &tier_bw)
          + queue_penalty(w)
          - workflow_bonus(w, r, &agent_ctx);
```

需要新增的数据流：
1. **Tier events**：在 `protocols.rs` 增加 `RouterEvent::TieredStored { tier, ... }` / `Migrated { from_tier, to_tier, ... }`。Engine 侧 vLLM hicache 已经可以发，SGLang HiCache 同理。
2. **`AgentContext`**：作为 HTTP header（`x-agent-workflow-id` / `x-agent-step-id` / `x-agent-expected-tools`）从 frontend 传入；`SchedulingRequest` 已经有 `expected_output_tokens` 字段，扩展即可。
3. **Tier BW telemetry**：worker 通过 `WorkerConfigLike` trait 上报 `tier_bw_used[]` 和 `tier_concurrency[]`，router 维护 EWMA。

### 6.2 在 SGLang sgl-router 上落地

需要重构（当前是规则切换不是 cost）：
- 把 char tree 换成 token-level radix tree（参考 SGLang RadixAttention 的实现）；
- 加上 `WorkerLoadInfo`（pending、prefill rate、decode rate、tier_bw）的拉取（policies 已有 `update_loads` 钩子）；
- 把 `select_worker` 换成 cost-min 实现。

### 6.3 在 llm-d EPP 上落地

最自然——加一个新 scorer：`unified-cost-scorer`，**返回 logit 的相反数**（picker 用 `max-score-picker`）。和现有 weighted scorers 共存，权重设大即可"接管"。Tier 信号通过 EPP 订阅 vLLM 的 hicache events 取得（已有 ZMQ KV events 通路，扩展 topic 即可）。

---

## 7. 一个具体的数值例子

设有 3 个 worker，处理一个新请求 $r$（ISL=8000, expected OSL=500）：

| Worker | HBM hit | CPU hit | active 请求 | active $\sum d$ | active $\sum d^2$ | $Q$ | last_worker_for $r$? |
|---|---|---|---|---|---|---|---|
| W1 | 7500 tok | 0 | 4 | 800 | 200000 | 2 | yes (last 30s) |
| W2 | 0 | 7500 tok | 1 | 200 | 50000 | 0 | no |
| W3 | 0 | 0 | 0 | 0 | 0 | 0 | no |

参数：$\alpha_p = 1.0$ μs/tok，$\alpha_d = 50$ μs/tok，$\alpha_{d^2} = 0.001$，BW(PCIe) = 64 GB/s，KV bytes/tok = 0.5 KB（GQA），$\rho_{\text{PCIe}}(W2) = 0.3$ (空闲)，$\alpha_{wf} = 5000$ μs，$\lambda = 1/120s$，$\alpha_{ho} = 100$，$Q_{\text{slack}} = 4$。

**W1**:
- $C_p = 1.0 \cdot 500 = 500$ μs
- $C_d = 50 \cdot 800 + 0.001 \cdot 100000 = 40000 + 100 = 40100$ μs
- $C_t = 0$
- $C_{HOL} = 100 \cdot 0 = 0$
- $B_{wf} = 5000 \cdot e^{-30/120} = 5000 \cdot 0.78 = 3900$
- **Cost = 500 + 40100 - 3900 = 36700 μs**

**W2**:
- $C_p = 0$
- $C_d = 50 \cdot 200 + 0.001 \cdot 25000 = 10025$ μs
- $C_t = 1.0 \cdot \frac{7500 \cdot 512 \text{ B}}{64 \cdot 10^9 \cdot 0.3} = \frac{3.84 \times 10^6}{1.92\times 10^{10}} \approx 200$ μs
- $C_{HOL} = 0$
- $B_{wf} = 0$
- **Cost = 10225 μs**

**W3**:
- $C_p = 1.0 \cdot 8000 = 8000$ μs
- $C_d = 0$
- $C_t = 0$
- $C_{HOL} = 0$
- $B_{wf} = 0$
- **Cost = 8000 μs**

**Selector 选 W3**（重算最便宜）。

如果把 PCIe ρ 改成 0.95（W2 拥塞）：
- W2 的 $C_t = 200 / (0.3/0.95) \approx 633$ μs，cost = 10658 μs。
- W3 仍最低。

如果再把 W3 设为没有空 KV（要 evict 才能塞）—— `expected output 500` 撑不下，进入 W3 的 $\alpha_{d^2}$ 会反映出来；选择会回到 W2（CPU loading）。

如果换成 Dynamo 当前的线性 logit（block size B=64）：
- W1: $1.0 \cdot 500/64 + 800/64 = 7.8 + 12.5 = 20.3$
- W2: $0 + 200/64 = 3.1$
- W3: $1.0 \cdot 8000/64 + 0 = 125$

Dynamo 会选 W2，**没看到 PCIe 拥塞 → 错路由**。这就是 tier-awareness 的实际价值。

---

## 8. 调度层和 cost model 的耦合

cost model 只是 selector 的事。**Queue 排序**也应该用同一套 cost：

$$
\text{Priority}(r) = \frac{1}{\min_w \text{Cost}(w, r)}
$$

这是 Dynamo `WsptPolicy` 的自然推广——把 "$1 / p_{\text{new}}$" 换成 "$1 / \text{Cost}_{\min}$"，同时考虑 cache 命中、tier、in-flight load。

---

## 9. Per-Request Cache Control TTL（Anthropic-style 客户端控制）

> 这一节和 §1-8 的 router-side cost model 是**正交的两件事**——前面讲的是 **router 自己**怎么基于 cost 做路由决策；这里讲的是**客户端**通过 per-request hint 显式告诉 server "这段 prefix 给我留 5 分钟" 这种语义。

### 9.1 概念区分

容易混淆的两种 "TTL"：

| 类别 | 在哪里 | 默认值 | 作用 |
|---|---|---|---|
| **Router-side prediction TTL** | Dynamo `--router-ttl-secs` (默认 120s) / `PruneManager` | 120s | router 在 approximate 模式下，对自己**预测**的 cache state 做老化清理；和 server 的真实 cache 无关 |
| **Per-request cache pin TTL** | client header / body 里 `cache_control: {type: "ephemeral", ttl: "5m"}` | API 默认 5m | 通过 frontend 透传到 worker，告诉**真实的 KV cache** "这段前缀在 N 分钟内 LRU 不许动" |

Anthropic Claude API 是 per-request TTL 的**事实标准**：客户端在 message content block 上挂 `cache_control: {type: "ephemeral", ttl: "5m"}`（默认 5 分钟）或 `"1h"`（需要 beta header `prompt-caching-2024-07-31`）。Cache hit 的 token 按 0.1× 计费、cache write 按 1.25× 计费、TTL 内复用 hit 自动续期。

### 9.2 三家开源引擎现状（截至 2026-04）

#### NVIDIA Dynamo —— ✅ **2026-02-27 merged**（PR [#6213](https://github.com/ai-dynamo/dynamo/pull/6213)）

把 Anthropic-style `nvext.cache_control` 透传到 worker：

```
Client request:
  POST /v1/chat/completions
  {
    "messages": [...],
    "nvext": {
      "cache_control": {"type": "ephemeral", "ttl": "5m"}
    }
  }

→ NvExt.cache_control → CacheControl.ttl_seconds() → 300
→ RoutingHints.cache_control_ttl: Option<u64> = Some(300)
→ KvPushRouter::generate() 正常推理
→ stream 完成后 fire-and-forget: spawn_pin_prefix(token_ids, 300)
→ worker 的 cache_control 服务 mesh endpoint 收到 → pin_prefix(token_ids, 300)
```

关键点：

- 解析 `"5m"`/`"30m"`/`"1h"`/`"<N>s"` 的 `ttl_seconds()` parser
- 行为 = "**生成完 → 才 pin**"（不是发请求时就 pin），这样保证 prefix 是真实命中过的、有意义的
- 由 `--enable-agentic-cache-control` 开关控制（默认关）
- `CacheControlClient` 透传 ttl 到 worker；具体 pin 行为由 worker engine 实现（vLLM / SGLang）
- 对应 worker 侧 PR：SGLang [#18941](https://github.com/sgl-project/sglang/pull/18941) (HiRadixCache)

#### SGLang —— ✅ **2026-03-02 merged**（PR [#18941](https://github.com/sgl-project/sglang/pull/18941)）

`HiRadixCache` 加 TTL-based prefix pinning + refresh-on-hit：

```
新增 endpoint:
  POST /hicache/pin_prefix     {token_ids: [...], ttl_seconds: 300}
  POST /hicache/unpin_prefix   {token_ids: [...]}

实现细节:
- TreeNode 加 {pin_count, pin_expiry, pin_ttl} 三字段
- _split_node() 拆节点时正确传递 pin 状态
- evict() / evict_host() lazy 检查 expired pin（无后台 timer）
- 命中 pinned 节点时 pin_expiry 自动续期（refresh-on-hit）
- 部分 pin 反馈：predicate "pin budget exhausted"

Pin budget:
  环境变量 SGLANG_HICACHE_MAX_PINNED_RATIO ∈ [0, 1)
  默认 0.0 = 完全关闭 pinning（请求会被 reject + 错误信息）
  典型用法 0.6 = 允许 60% host cache 用于 pin

Pin 范围: 仅 host（CPU）tier 内 pin，HBM 仍走 LRU
```

实测数据（PR description）：

| Metric | Baseline | Pinned (TTL=5m) |
|---|---|---|
| Cache hit rate | (未给) | **89%** |
| TTFT | (未给) | **313 ms** |
| Workload | 5770 req flood after warmup | 同 |

Dynamo 的 cache_control 落到 SGLang worker 时就走这个 endpoint，闭环。

#### vLLM —— ⚠️ **未上游**

历史：

- RFC [#8333](https://github.com/vllm-project/vllm/issues/8333) (2024-09 提，标记 completed 但实际由作者关闭) + 草稿 PR [#8334](https://github.com/vllm-project/vllm/pull/8334) (2025-02 关闭未合)
- 作者 @llsj14 评论："I want to complete this PR, but I've lost direction on how to integrate it with the API and how to restrict the resources used by pinned caching"
- 2025-12 仍有用户在评论里催："is this RFC shelved forever?"

vLLM 现状：

- ✅ 有 Anthropic 兼容的 `/v1/messages` endpoint（PR [#22627](https://github.com/vllm-project/vllm/pull/22627), 2025-10 merged），但**只解析 cache_control 字段、没真做 pinning**
- ⚠️ usage 里 `cache_creation_input_tokens` / `cache_read_input_tokens` 字段一开始没填，PR [#34282](https://github.com/vllm-project/vllm/pull/34282) (2026-02, 仍 open) 才在补
- ✅ Cache salting（PR [#17045](https://github.com/vllm-project/vllm/pull/17045)）已合 → per-request `cache_salt` 字段，但作用是**隔离**而非 **pin**
- ⚠️ 真正的 per-request TTL prefix pinning **还没在 upstream**，只能靠 Dynamo 在外面包一层用

实际可用路径：**vLLM 当 Dynamo worker，TTL 由 Dynamo 解析后通过 `cache_control` mesh endpoint 调到 vLLM 的 pin 接口**——但 vLLM 的 `pin_prefix` API 也还没合，所以这条路目前要靠 fork 或 patch。

### 9.3 三家横向对比

| 维度 | Anthropic API（标准） | Dynamo (#6213) | SGLang (#18941) | vLLM |
|---|---|---|---|---|
| 字段名 | `cache_control: {type, ttl}` | `nvext.cache_control: {type, ttl}` | `PinPrefixReqInput.ttl_seconds` | （Anthropic endpoint 接收但不真 pin） |
| TTL 格式 | `"5m"` / `"1h"` | `"5m"` / `"30m"` / `"1h"` / `"<N>s"` | int `ttl_seconds` | — |
| 默认 TTL | 5 min | 由客户端传 | 由请求传 | — |
| Pin 触发时机 | 请求处理时 | **响应完成后** fire-and-forget | endpoint 调用时 | — |
| Pin 范围 | server 端不可见 | 透传到 worker | host (CPU tier) only | — |
| Refresh-on-hit | ✅ 会续期 | 由 worker 决定 | ✅ 命中续期 | — |
| 资源限制 | 不可控 | 由 worker | `SGLANG_HICACHE_MAX_PINNED_RATIO` (默认 0 = off) | — |
| 状态 | 生产 | 2026-02 上游 | 2026-03 上游 | 上游未支持 |
| 文档 | [docs.anthropic.com](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) | [docs.nvidia.com/dynamo/blog/agentic-inference](https://docs.nvidia.com/dynamo/blog/agentic-inference) | PR description | RFC #8333 |

### 9.4 为什么这件事对 agent serving 重要

回到 §4 的 cost model 视角，per-request cache_control TTL 是 client → router → engine 之间的**第三种信号**（前两种是被动观察的 KV events 和主动声明的 routing hints），它直接对应一个**新的 cost model 项**：

- 在 §4.4 的 tier-aware cost 上加 `\alpha_{\text{pinned}} \cdot \mathbb{1}[\text{request asks pin}]`
- 这个项让 router 知道："这个请求声明了 5 分钟内还要再来"，可以更激进地选择**留住 prefix 不被驱逐**的 worker
- KVFlow STE（§2.3）拟合的 STE 也可以被 client 通过 cache_control TTL 显式 override—— agent harness 比 router 更知道 workflow 结构

具体场景：
- **Code Agent**：subagent fork 之前父 agent 把当前 conversation prefix 标 `ttl=10m`，确保 4 个 subagent 并发跑完后父 agent 回来还能命中
- **Multi-turn chat**：每个 user 第一 turn 自动加 `ttl=5m`，闲置超时就让位（refresh-on-hit 保证活跃用户不掉）
- **System+tool prompt**：tool definitions 那段 ~12K token 一次性加 `ttl=1h`，几乎永驻 cache

### 9.5 对 Dynamo `kv-router` 落地的影响（§6.1 补充）

§6.1 的 `select_worker` 替换公式上要加一项：

```rust
// Per-request pin awareness
let pin_bonus = if request.cache_control_ttl.is_some() {
    // 选择"未来 ttl 内最不会驱逐这条 prefix"的 worker
    alpha_pin * (1.0 - eviction_prob_within(w, ttl, prefix_blocks))
} else {
    0.0
};
```

`eviction_prob_within` 的简单实现：基于 worker 当前 working set / pin budget 残量做线性估计。这能把 SGLang `SGLANG_HICACHE_MAX_PINNED_RATIO` 残量从 worker telemetry 里拉过来。

### 9.6 实现/复现速查

```bash
# Dynamo: 启用 per-request cache_control
dynamo serve --enable-agentic-cache-control ...

# Client (Python OpenAI SDK):
client.chat.completions.create(
    model="...",
    messages=[...],
    extra_body={
        "nvext": {
            "cache_control": {"type": "ephemeral", "ttl": "5m"}
        }
    }
)

# SGLang: 启用 HiRadixCache pin
SGLANG_HICACHE_MAX_PINNED_RATIO=0.6 python -m sglang.launch_server ...
# 直接调 pin endpoint:
curl -X POST localhost:30000/hicache/pin_prefix \
    -d '{"token_ids": [1,2,3,...], "ttl_seconds": 300}'
```

### 9.7 还没解决的小问题

- **跨 worker pin 不传递**：SGLang/vLLM 的 pin 是 worker-local。如果路由到不同 worker，pin 不会迁移。NVIDIA Dynamo blog 提到要把 retention 元数据带进 HiCache/KVBM 共享 storage，但还没实现
- **vLLM 上游什么时候有**：目前 RFC stale，依赖社区 driver
- **TTL 与 cache size 的耦合**：pin 太多会让 LRU 部分饿死，需要 admission control（SGLang 用 `MAX_PINNED_RATIO` 上界，但还不够智能）
- **Pin budget 的 cost 应该计入 router**：如果 worker A 已经 pin 满，新请求即使 prefix 命中 A 也应该考虑路由到 B

---

## 10. Agent Orchestrator-Engine Co-design：Sutradhara 案例与 API 谱系对比

> §9 讲了**客户端**通过 `cache_control.ttl` 给 server 一个粗粒度 hint。本节往更深一层走：**orchestrator** 把它对 prompt 结构和 workflow 的认知**内嵌到 engine 的调度** 里——不是 hint，而是 thin API 双向 co-design。这是 Sutradhara (Microsoft Research, arXiv 2601.12967) 的核心论点。

### 10.1 问题定位：层级隔离的"三个不可能"

| 层 | 知道什么 | 不知道什么 |
|---|---|---|
| **Orchestrator**（LangChain / AutoGen / Claude Code） | iteration 边界、prompt 怎么拼、哪段依赖 tool 输出、workflow STE | engine 内部排程、KV cache 状态 |
| **LLM Engine**（vLLM / SGLang） | batching、KV cache、调度 | prompt 的语义结构、下一 turn 的形态 |

两边互不通信导致：

1. **无法重叠**：engine 不知道 prompt 哪段可提前 prefill（实测 50-80% 是 tool-independent）
2. **无法提前分发 tool**：decode 输出全完才到 orchestrator
3. **无法智能驱逐**：engine 不知道哪些 KV 即将被同 agent 下 turn 复用 → LRU 在并发 agent 下级联 thrashing，e2e 延迟最高放大 7.14×（GLM-4.6 / OpenHands 实测）

### 10.2 Sutradhara 的 5 个 thin API

不重写 engine、不改 model，只在 orchestrator ↔ engine 之间开 5 个 API：

| API | 作用 | 对应优化 |
|---|---|---|
| `submit_partial_prefill(tokens)` | 提交 tool-independent 前缀（system + history + 不依赖本轮 tool 的部分） | **Prefill-tool 并行**：tool 在外执行时，engine 同时 prefill 这段 |
| `extend_prefill(tool_output_tokens)` | tool 完成后追加输出到已 pin 的 partial prefill 上下文 | **避免重复 prefill**：tool 结果到达只需算 tool output 段，不重算前缀 |
| `register_streaming_callback(cb)` | 注册 token-level 回调，decode 进行中就拿到增量 token | **Streaming tool dispatch**：流式 JSON parser 第一个完整 tool call object 闭合（`}`）就立即分发，不等整段 decode 结束 |
| `tag_kv_blocks(block_ids, tag)` | 给 KV block 打 5 种语义标签：`SYSTEM_PROMPT` / `USER_QUERY` / `TOOL_OUTPUT` / `RESPONSE` / `PARTIAL_PREFILL` | **Workload-aware 驱逐**：基于 tag 的优先级驱逐替代 LRU |
| `set_reuse_priority(block_ids, prio)` | 显式标记某些 block 即将被复用 | **防 thrashing**：partial prefill 的 KV 在 tool 执行的几百ms~几秒里被 pin 住 |

驱逐优先级链（先踢 → 后踢）：

```
RESPONSE → TOOL_OUTPUT → USER_QUERY → SYSTEM_PROMPT → PARTIAL_PREFILL
```

`PARTIAL_PREFILL` 是最高优先级，**确保 tool 执行那几秒里不会被新进来的并发请求挤掉**——这是消除级联 thrashing 的关键。

### 10.3 端到端数据流

```
[Iter i decode] ──────────────────────────► [tool call JSON 流式吐出]
        │                                          │
        │ register_streaming_callback              │ 流式 JSON parser
        │ (decode 中实时回调)                       │ 第一个 } 闭合即分发
        ▼                                          ▼
   [orchestrator]                             [Tool T1 执行 (数百ms~数秒)]
        │                                          │
        │ submit_partial_prefill(P_{i+1}^a)        │ ← 关键并行点
        │ (tool-independent 那段)                   │
        ▼                                          │
   [engine: prefill P_{i+1}^a] ◄─────────────────┘
        │ tag_kv_blocks(..., PARTIAL_PREFILL)
        │ set_reuse_priority(..., HIGH)            (这段在 tool 执行期被 pin)
        ▼
   [tool 完成]
        │
        │ extend_prefill(tool_output)
        ▼
   [engine: 续算 P_{i+1}^b（仅 tool 输出段）]
        ▼
   [Iter i+1 decode]
```

### 10.4 实测效果（A100-80G + Qwen3-14B / Gemma-12B）

| 指标 | Baseline (vLLM v0.11.0) | Sutradhara | 改进 |
|---|---|---|---|
| Median FTR | 51.5s | 43.3s | **-15.83%** |
| P99 FTR | — | — | **-12.3%** |
| Median E2E | 84.2s | 73.8s | **-10%** |
| Throughput | — | 不变 | 0% |

Ablation：
- KV semantic eviction 单独：基础
- + Prompt Splitting：FTR -7.57%（最大单项贡献）
- + Streaming Dispatch：再 -4.2%

实现：3500 行 Python，**不改 CUDA kernel、不改模型架构**。

### 10.5 三层 Agent-Aware Signaling 谱系（本节最重要的对比）

把 §9 的 `cache_control.ttl` 和本节的 Sutradhara 5 API 放在一起，加上更轻量的 trace replay 思路，可以画出一个**三层信号粒度谱系**：

| 层级 | 谁发信号 | 给谁 | 粒度 | 信息内容 | 代表实现 | 状态 |
|---|---|---|---|---|---|---|
| **L0 Replay-only** | 测试工具 | 黑盒 server | Request-level | 只发原 prompt，不带任何元信息 | `kv-cache-tester` / `trace_replay_tester.py` | 任何 server 即用 |
| **L1 Hint (Anthropic-style)** | client | router/engine | Per-request flag | `cache_control: {type, ttl}` —— "这段 prefix 留 5 分钟" | Dynamo PR #6213 / SGLang PR #18941 | 2026-Q1 上游 |
| **L2 Workflow context** | client | router | HTTP header / `nvext` | `agent_workflow_id` / `step_id` / `expected_tools` / `osl` —— "我属于 workflow X 的第 N 步" | NVIDIA Dynamo `nvext.agent_hints`（部分） | 2026-Q1 上游 |
| **L3 Prompt structure co-design** | orchestrator | engine | 5 thin APIs（双向） | partial prefill 边界 + 语义 tag + token-level callback —— "这段 12K token 是 system prompt，下一段是 tool output" | **Sutradhara** | 论文，未上游 |

**抽象层数顺序：L0 → L1 → L2 → L3，信号越来越重，性能空间越来越大，但绑定也越深**。

| 维度 | L0 Replay | L1 Hint | L2 Context | L3 Co-design |
|---|---|---|---|---|
| 接口侵入 | 无 | API +1 字段 | API +N header | 需要 orchestrator 重写 |
| Engine 侧改动 | 无 | 中等 (pin) | 中等 (route) | 大 (scheduler state machine) |
| Engine 锁定 | 无 | 中等 | 中等 | 强 (Sutradhara 绑死 vLLM) |
| Format 锁定 | 无 | 弱 | 弱 | 强 (绑 JSON tool call + prompt template) |
| 收益数量级 | baseline | 5-15%（cache hit ↑） | 10-30%（路由更准 + cost model） | 10-15% FTR + 防 thrashing 7×（极端） |
| 落地难度 | 低 | 低（已上游） | 中（已上游） | 高（需要 orchestrator + engine 双侧 fork） |

### 10.6 与 §4 cost model 的整合

L1 / L2 / L3 都给 cost model 加新项。把 §4 公式补全：

$$
\text{Logit}(w, r) = \alpha_p p_{\text{eff}} + \alpha_d d + \alpha_{d^2} \tfrac{d^2}{2} + \sum_t \alpha_t L_t + \alpha_{ho} H - \alpha_{wf} A_{wf} 
\;\underbrace{- \alpha_{\text{pin}} \cdot \mathbb{1}[\text{cache\_control}]}_{\text{L1: pin}}
\;\underbrace{- \alpha_{\text{step}} \cdot \text{StepAffinity}(w, r)}_{\text{L2: workflow context}}
\;\underbrace{- \alpha_{\text{co}} \cdot \text{CoDesignPrefillSavings}(w, r)}_{\text{L3: partial prefill 已有}}
$$

其中：
- `CoDesignPrefillSavings(w, r)` = 如果该 worker 上 partial prefill 已经为这个 workflow 跑过，重发同样 prefix 的算力可省 → 此 worker cost 减少。
- L3 的 `tag_kv_blocks` 还能进一步给 §4.4 的 tier 选择加 priority 维度（高优先级 tag 倾向于留在 HBM）。

### 10.7 Sutradhara 的硬约束（笔记里的 critique）

接 L3 之前必须知道这些：

1. **强绑定 vLLM v1 scheduler**：5 API 嵌入 state machine 很深，"可移植到 TRT-LLM/SGLang"是空话
2. **强绑定 JSON tool call 格式**：streaming dispatch 假设 LLM 输出标准 JSON array of objects
3. **强绑定 prompt template**：partial prefill 需要 orchestrator 精确知道 split point；prompt 改了得同步改 split 逻辑
4. **PD colocation 假设**：在 disaggregated PD（DistServe / Splitwise）下 partial prefill 的 KV 跨 GPU 传输延迟特征完全不同，论文未评估
5. **Tool 时延 proportional scaling 模拟**，不是真 tool 执行
6. **单 GPU、60 请求子集**评估，统计显著性有限
7. **高 QPS 下边际效益递减**：被 engine 排队主导

### 10.8 实践建议

按"接入难度 vs 收益"递进：

- **新项目**：直接走 L1（`cache_control.ttl`），Dynamo + SGLang 都开箱可用，收益 5-15% 接近免费
- **有自己 router 的**：加 L2，让 router 看到 `agent_workflow_id` / `expected_osl`，§4 cost model 的 workflow 项就能跑起来
- **有完整 agent stack（自家 orchestrator + 自家 engine）**：L3 值得做，但要预算重写 scheduler 的工作量。SGLang 端的 HiRadixCache pin（PR #18941）已经给了 L1 的 pin 原语，部分 L3 优化（partial prefill）可以站在它上面叠
- **标准化路径**：现在 industry 在 L1 上有了事实标准（`cache_control.ttl`），L2 还很零散（每家命名不一样），L3 还在论文阶段。**短期最佳投入是把 L2 的 `agent_workflow_id` 也搞成 cross-vendor 标准**——OpenAPI 这类组织可以推一个 `nvext.agent_context` schema

### 10.9 知识库内的相关条目

- §1-8：本文件前面，router cost model 主体（L0/L2 视角）
- §9：L1 `cache_control.ttl`（Anthropic-style）
- §10：本节，L3 Sutradhara
- 笔记 `~/.cursor/paper-db/notes/2601.12967.md`：Sutradhara 全文精读
- 笔记 `~/.cursor/paper-db/notes/2602.13692.md`：ThunderAgent，与 Sutradhara 互补的另一篇 agent program-aware co-design
- 笔记 `~/.cursor/paper-db/notes/2507.07400.md`：KVFlow，STE-aware eviction（L2 端的语义信号源）

---

## 11. 还没解决的问题（Open Questions）

下面列的是即使 §4 的 cost model 全部实现，仍需要进一步研究的：

1. **Cold-start agent**：第一次见到的 workflow，没有 STE，没有 expected_next_tools。是否能从 prompt 文本特征零样本预测？
2. **Speculative indexing 的一致性**：llm-d 已经 ship 了 `speculativeIndexing: true`，但 reconcile 协议没公开。如果 engine 拒了请求，我们错插的索引何时清？
3. **Router 替换 / migrate 的 cost**：当前所有方案都假设 "一次路由定终身"。Tool return 时如果有更好的 worker，要不要把 sequence 迁过去（LMCache 类 KV transfer）？这件事的 cost 模型是 PrfaaS Eq.7 的简化版。
4. **Multi-tenant fairness × locality**：Justitia 给了 WFQ 公平 cost，但和 cache-affinity 完全冲突。能否用 priority 注入到 $\alpha_*$ 的乘子？
5. **MoE 模型的 cost**：MoE 的 prefill / decode 时延和 expert 分布相关，单 worker 内部还有 expert imbalance，会进一步影响 $\alpha_p, \alpha_d$ 的拟合稳定性。
6. **跨 DC（PrfaaS）扩展**：WAN bandwidth 计费按 95th percentile，cost 还要加上"出口带宽 percentile 感知"项。
7. **强化学习直接优化 cost**：参数太多，能否用 PPO + simulator（如 Mooncake trace）端到端学 $\boldsymbol{\alpha}$？

---

## 12. 参考资料

**代码库**:
- NVIDIA Dynamo `kv-router`: `/apps/feiyue/upstream/dynamo/lib/kv-router/`，重点看 `scheduling/selector.rs`、`scheduling/policy.rs`、`indexer/README.md`
- SGLang `sgl-model-gateway`: `/apps/feiyue/upstream/sglang/sgl-model-gateway/src/policies/cache_aware.rs`
- llm-d: `/apps/feiyue/upstream/llm-d/guides/precise-prefix-cache-aware/`, `/apps/feiyue/upstream/llm-d/guides/tiered-prefix-cache/`
- 真正的 EPP scheduler 实现: github.com/llm-d/llm-d-inference-scheduler、github.com/kubernetes-sigs/gateway-api-inference-extension

**Paper**（来自 ~/.cursor/paper-db/papers.json，已读）:
- **Justitia** (2510.17015): KV token-time cost $c = pd + d^2/2$，WFQ 公平
- **ThunderAgent** (2602.13692): Agentic Program tuple，recompute $\propto c^2$，指数衰减必然性
- **KVFlow** (2507.07400): Agent Step Graph + STE-aware eviction
- **Pancake** (2602.21477): 多层 ANN memory，CPU-GPU cross-over 256-512 vectors
- **Concur**: middle-phase thrashing，HiCache 在并发下退化 3×
- **Halo / Helium** (2603.16104): batch agentic 的 query optimizer，dual-prefix reuse
- **PrfaaS** (2604.15039): cross-DC PD-disagg + dual-timescale scheduling
- **JITServe**: QRF 长度上分位预测，GMAX 调度
- **HEXGEN-FLOW**: 两层 workflow scheduler + SLO budget propagation
- **DualPath**: PD-disagg 中 dual-path KV loading
- **DynaServe**: micro-request abstraction
- **PASTE** (2603.18897): pattern-aware speculative tool execution

---

## 13. 修订历史

- **2026-04-21** v1：初版，覆盖三家 router 调查、cost model 现状、tier-aware + agent-aware 统一公式与 Dynamo 落地路径。
- **2026-04-21** v1.1：新增 §9 *Per-Request Cache Control TTL（Anthropic-style 客户端控制）*——梳理 vLLM / Dynamo / SGLang 三家对 Anthropic-style `cache_control: {type: "ephemeral", ttl: "5m"}` 的支持现状（Dynamo PR #6213 / SGLang PR #18941 已合，vLLM #8334 未合），区分 router-side prediction TTL 与 per-request pin TTL，并在 cost model 中加入 pin awareness 项。
- **2026-04-22** v1.2：新增 §10 *Agent Orchestrator-Engine Co-design：Sutradhara 案例与 API 谱系对比*——分析 Microsoft Sutradhara (arXiv 2601.12967) 的 5 thin API（`submit_partial_prefill` / `extend_prefill` / `register_streaming_callback` / `tag_kv_blocks` / `set_reuse_priority`）、prefill-tool 并行 + streaming dispatch + 语义 KV 驱逐三大优化（FTR -15.83%）；提出 **L0 Replay → L1 Hint → L2 Workflow context → L3 Co-design** 四层 agent-aware signaling 谱系，把本文件 §1-9 内容定位到统一抽象层；§4 cost model 补充 pin / workflow / co-design 三个新项；给出按"接入难度 vs 收益"递进的实践建议。
