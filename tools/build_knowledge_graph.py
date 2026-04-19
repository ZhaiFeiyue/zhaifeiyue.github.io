#!/usr/bin/env python3
"""Build a self-contained interactive knowledge-graph HTML page.

Reads ~/.cursor/paper-db/papers.json and emits
/apps/feiyue/upstream/zhaifeiyue.github.io/knowledge-graph.html

Uses D3 v7 force-directed layout, with category-coloured nodes sized by degree.
Inlines all paper metadata as JSON in a <script> tag — no external data fetch.
"""
import json
import os
from datetime import date
from pathlib import Path

DB = Path("~/.cursor/paper-db/papers.json").expanduser()
OUT = Path("/apps/feiyue/upstream/zhaifeiyue.github.io/knowledge-graph.html")

CAT_COLORS = {
    "algorithm": "#16a34a", "kernel": "#ea580c", "framework": "#2563eb",
    "llm":       "#9333ea", "agent":  "#dc2626", "cluster":   "#0891b2",
    "hardware":  "#b45309", "code":   "#64748b",
}
CAT_LABELS = {
    "algorithm": "Algorithm", "kernel": "Kernel", "framework": "Framework",
    "llm":       "LLM",       "agent":  "Agent",  "cluster":   "Cluster",
    "hardware":  "Hardware",  "code":   "Code",
}


def build():
    with DB.open() as f:
        db = json.load(f)
    papers = db["papers"]

    by_id = {p["id"]: p for p in papers}

    # Build nodes
    nodes = []
    for p in papers:
        nodes.append({
            "id": p["id"],
            "title": p["title"],
            "category": p.get("category", "code"),
            "tags": p.get("secondary_tags", [])[:6],
            "date": p.get("date", ""),
            "date_read": p.get("date_read", ""),
            "url": f"papers/{p['id']}.html",
            "core": (p.get("core_contribution") or "")[:240],
        })

    # Build deduped, undirected edges
    seen = set()
    edges = []
    for p in papers:
        a = p["id"]
        for b in (p.get("related_paper_ids") or []):
            if b not in by_id:
                continue
            key = tuple(sorted((a, b)))
            if key in seen:
                continue
            seen.add(key)
            edges.append({"source": key[0], "target": key[1]})

    # Compute degrees for sizing
    deg = {p["id"]: 0 for p in papers}
    for e in edges:
        deg[e["source"]] += 1
        deg[e["target"]] += 1

    # Stats: top connectors per category
    by_cat = {}
    for p in papers:
        by_cat.setdefault(p.get("category", "code"), []).append(p["id"])

    stats = {
        "total_papers": len(papers),
        "total_edges": len(edges),
        "isolated": sum(1 for d in deg.values() if d == 0),
        "by_cat": {k: len(v) for k, v in by_cat.items()},
        "top_connectors": sorted(deg.items(), key=lambda kv: -kv[1])[:10],
    }

    payload = {
        "nodes": nodes,
        "links": edges,
        "deg": deg,
        "stats": stats,
        "cat_colors": CAT_COLORS,
        "cat_labels": CAT_LABELS,
        "generated_at": date.today().isoformat(),
    }

    html = HTML_TEMPLATE.replace(
        "__DATA_JSON__",
        json.dumps(payload, ensure_ascii=False),
    )
    OUT.write_text(html, encoding="utf-8")
    print(f"Wrote {OUT}  ({len(nodes)} nodes, {len(edges)} edges, {OUT.stat().st_size:,} bytes)")


HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Knowledge Graph · Feiyue Zhai</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root {
  --bg: #fbfbfd;
  --fg: #111827;
  --muted: #6b7280;
  --bd: #e5e7eb;
  --accent: #2563eb;
  --nav: #1b2a4a;
  --panel: #ffffff;
  --shadow: 0 4px 14px rgba(0,0,0,0.06);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans SC", sans-serif;
  background: var(--bg); color: var(--fg); height: 100vh; overflow: hidden;
  display: flex; flex-direction: column;
}
nav {
  background: var(--nav); color: #fff; padding: 0 24px;
  display: flex; align-items: center; gap: 22px;
  height: 48px; flex-shrink: 0;
}
nav .logo { font-weight: 700; font-size: 1.05rem; }
nav a { color: #cbd5e1; font-size: 0.88rem; font-weight: 500; text-decoration: none; }
nav a:hover { color: #fff; }
main {
  flex: 1; display: grid;
  grid-template-columns: 280px 1fr 320px;
  gap: 0; min-height: 0;
}
aside.left, aside.right {
  background: var(--panel); padding: 16px; overflow-y: auto;
  border-right: 1px solid var(--bd);
}
aside.right { border-right: none; border-left: 1px solid var(--bd); }
aside h2 {
  font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em;
  color: var(--muted); margin: 0 0 10px; font-weight: 600;
}
aside h3 { font-size: 0.95rem; margin: 18px 0 8px; }
.legend-row {
  display: flex; align-items: center; gap: 8px; padding: 4px 6px;
  border-radius: 4px; cursor: pointer; user-select: none;
  font-size: 0.85rem;
}
.legend-row:hover { background: #f3f4f6; }
.legend-row.off { opacity: 0.35; }
.legend-row .dot {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
}
.legend-row .count { margin-left: auto; color: var(--muted); font-size: 0.78rem; }
.search-box {
  width: 100%; padding: 7px 10px; border: 1px solid var(--bd);
  border-radius: 6px; font-size: 0.88rem; margin-bottom: 12px;
}
.toggle-row {
  display: flex; align-items: center; gap: 8px; padding: 6px 0;
  font-size: 0.85rem; cursor: pointer;
}
.toggle-row input { cursor: pointer; }
.stats-grid {
  display: grid; grid-template-columns: 1fr 1fr; gap: 6px;
  font-size: 0.82rem;
}
.stat-card {
  background: #f9fafb; border-radius: 6px; padding: 8px;
}
.stat-card .v { font-size: 1.2rem; font-weight: 700; color: var(--accent); }
.stat-card .l { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; }
.top-list { font-size: 0.82rem; }
.top-list a {
  display: flex; justify-content: space-between; padding: 3px 6px;
  text-decoration: none; color: var(--fg); border-radius: 4px;
}
.top-list a:hover { background: #f3f4f6; }
.top-list .cnt { color: var(--muted); }

#viz { width: 100%; height: 100%; cursor: grab; background: #fbfbfd; }
#viz:active { cursor: grabbing; }
.node circle {
  stroke: #fff; stroke-width: 1.5px;
  cursor: pointer;
  transition: stroke-width 0.15s, stroke 0.15s;
}
.node.new circle {
  stroke: #f59e0b; stroke-width: 2.5px;
}
.node.dim circle, .link.dim {
  opacity: 0.08;
}
.node.hl circle {
  stroke: #111827; stroke-width: 3px;
}
.link {
  stroke: #cbd5e1; stroke-opacity: 0.55; stroke-width: 1px;
  transition: stroke 0.15s, stroke-opacity 0.15s, stroke-width 0.15s;
}
.link.hl {
  stroke: #1f2937; stroke-opacity: 0.85; stroke-width: 2px;
}
.node text {
  font-size: 9px; fill: #374151; pointer-events: none;
  text-anchor: middle; dy: 0.35em;
}
.detail-panel {
  font-size: 0.85rem; line-height: 1.5;
}
.detail-panel .empty { color: var(--muted); font-style: italic; }
.detail-panel .pid {
  font-family: ui-monospace, "SF Mono", monospace; font-size: 0.78rem;
  color: var(--muted);
}
.detail-panel .cat-pill {
  display: inline-block; padding: 2px 8px; border-radius: 10px;
  color: #fff; font-size: 0.72rem; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.04em;
}
.detail-panel h3 { margin: 8px 0 4px; font-size: 1rem; line-height: 1.3; }
.detail-panel .core { color: #374151; margin: 8px 0; }
.detail-panel .tags { margin: 8px 0; }
.detail-panel .tag {
  display: inline-block; padding: 1px 7px; margin: 2px 3px 2px 0;
  background: #f3f4f6; border-radius: 10px; font-size: 0.72rem;
  color: #4b5563;
}
.detail-panel .related { margin-top: 10px; }
.detail-panel .related a {
  display: block; padding: 3px 6px; font-size: 0.8rem;
  color: var(--fg); text-decoration: none; border-radius: 4px;
}
.detail-panel .related a:hover { background: #f3f4f6; }
.detail-panel .open-btn {
  display: inline-block; margin-top: 12px; padding: 6px 14px;
  background: var(--accent); color: #fff; border-radius: 6px;
  text-decoration: none; font-size: 0.85rem; font-weight: 500;
}
.detail-panel .open-btn:hover { background: #1d4ed8; }
.subtle {
  color: var(--muted); font-size: 0.78rem; margin-top: 4px;
}

@media (max-width: 1100px) {
  main { grid-template-columns: 1fr; grid-template-rows: auto 1fr auto; }
  aside.left, aside.right {
    max-height: 200px; border-left: none; border-right: none;
    border-bottom: 1px solid var(--bd);
  }
  aside.right { border-bottom: none; border-top: 1px solid var(--bd); }
}
</style>
</head>
<body>

<nav>
  <a class="logo" href="/">Feiyue Zhai</a>
  <a href="/">Papers</a>
  <a href="/knowledge-graph.html">Graph</a>
  <a href="/float.html">Tools</a>
  <a href="https://github.com/ZhaiFeiyue" target="_blank">GitHub</a>
</nav>

<main>
  <aside class="left">
    <h2>Filters</h2>
    <input type="text" class="search-box" id="search" placeholder="Search title / id / tag…">
    <h3>Category</h3>
    <div id="legend"></div>
    <h3>Highlight</h3>
    <label class="toggle-row">
      <input type="checkbox" id="highlight-new" checked>
      <span>Recent reads (last 30 days)</span>
    </label>
    <label class="toggle-row">
      <input type="checkbox" id="hide-isolated">
      <span>Hide isolated nodes</span>
    </label>
    <label class="toggle-row">
      <input type="checkbox" id="show-labels">
      <span>Show node labels</span>
    </label>

    <h3>Stats</h3>
    <div class="stats-grid" id="stats"></div>

    <h3>Top Connectors</h3>
    <div class="top-list" id="top-list"></div>
  </aside>

  <div style="position: relative; min-width: 0; min-height: 0;">
    <svg id="viz"></svg>
    <div style="position: absolute; bottom: 8px; left: 12px; font-size: 0.75rem; color: var(--muted);" id="generated"></div>
  </div>

  <aside class="right">
    <h2>Detail</h2>
    <div class="detail-panel" id="detail">
      <p class="empty">Hover or click a node to see details.</p>
      <p class="subtle">
        Drag nodes · scroll to zoom · click background to reset.<br>
        Orange ring = read in the last 30 days.
      </p>
    </div>
  </aside>
</main>

<script src="https://d3js.org/d3.v7.min.js"></script>
<script>
const DATA = __DATA_JSON__;

const today = new Date();
const RECENT_MS = 30 * 24 * 3600 * 1000;
function isRecent(p) {
  if (!p.date_read) return false;
  const d = new Date(p.date_read);
  return (today - d) < RECENT_MS;
}

DATA.nodes.forEach(n => {
  n.deg = DATA.deg[n.id] || 0;
  n.isNew = isRecent(n);
});

const byId = new Map(DATA.nodes.map(n => [n.id, n]));
const adj = new Map(DATA.nodes.map(n => [n.id, new Set()]));
DATA.links.forEach(l => {
  adj.get(l.source).add(l.target);
  adj.get(l.target).add(l.source);
});

// --- Build legend ---
const enabledCats = new Set(Object.keys(DATA.cat_labels));
const legendEl = document.getElementById("legend");
Object.entries(DATA.cat_labels).forEach(([k, label]) => {
  const cnt = DATA.stats.by_cat[k] || 0;
  const row = document.createElement("div");
  row.className = "legend-row";
  row.dataset.cat = k;
  row.innerHTML = `<span class="dot" style="background:${DATA.cat_colors[k]}"></span>` +
                  `<span>${label}</span><span class="count">${cnt}</span>`;
  row.onclick = () => {
    if (enabledCats.has(k)) { enabledCats.delete(k); row.classList.add("off"); }
    else { enabledCats.add(k); row.classList.remove("off"); }
    applyFilters();
  };
  legendEl.appendChild(row);
});

// --- Build stats ---
const statsEl = document.getElementById("stats");
function statCard(v, l) {
  const d = document.createElement("div");
  d.className = "stat-card";
  d.innerHTML = `<div class="v">${v}</div><div class="l">${l}</div>`;
  return d;
}
statsEl.appendChild(statCard(DATA.stats.total_papers, "papers"));
statsEl.appendChild(statCard(DATA.stats.total_edges, "edges"));
statsEl.appendChild(statCard(DATA.stats.isolated, "isolated"));
const recentCount = DATA.nodes.filter(n => n.isNew).length;
statsEl.appendChild(statCard(recentCount, "recent"));

// --- Top connectors ---
const topListEl = document.getElementById("top-list");
DATA.stats.top_connectors.forEach(([pid, deg]) => {
  const p = byId.get(pid);
  if (!p) return;
  const a = document.createElement("a");
  a.href = "#";
  a.onclick = (e) => { e.preventDefault(); focusNode(pid); };
  a.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px;">${pid}</span><span class="cnt">${deg}</span>`;
  topListEl.appendChild(a);
});

document.getElementById("generated").textContent = `Generated ${DATA.generated_at} · D3 v7 force-directed`;

// --- Force simulation ---
const svg = d3.select("#viz");
const g = svg.append("g");

const sim = d3.forceSimulation(DATA.nodes)
  .force("link", d3.forceLink(DATA.links).id(d => d.id).distance(60).strength(0.8))
  .force("charge", d3.forceManyBody().strength(-110))
  .force("center", d3.forceCenter(0, 0))
  .force("collide", d3.forceCollide().radius(d => 4 + Math.sqrt(d.deg) * 2));

const link = g.append("g").attr("class", "links")
  .selectAll("line").data(DATA.links).join("line").attr("class", "link");

const node = g.append("g").attr("class", "nodes")
  .selectAll("g").data(DATA.nodes).join("g")
  .attr("class", d => "node" + (d.isNew ? " new" : ""))
  .call(d3.drag()
    .on("start", (event, d) => {
      if (!event.active) sim.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on("end", (event, d) => {
      if (!event.active) sim.alphaTarget(0);
      d.fx = null; d.fy = null;
    }));

node.append("circle")
  .attr("r", d => 4 + Math.sqrt(d.deg) * 2)
  .attr("fill", d => DATA.cat_colors[d.category] || "#888")
  .on("mouseenter", (e, d) => showDetail(d, true))
  .on("click", (e, d) => focusNode(d.id))
  .on("dblclick", (e, d) => window.location.href = d.url);

const labels = node.append("text")
  .text(d => d.id)
  .style("display", "none");

sim.on("tick", () => {
  link.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
  node.attr("transform", d => `translate(${d.x},${d.y})`);
});

// --- Zoom/pan ---
const zoom = d3.zoom().scaleExtent([0.2, 4])
  .on("zoom", (event) => g.attr("transform", event.transform));
svg.call(zoom);

function fit() {
  const w = svg.node().clientWidth;
  const h = svg.node().clientHeight;
  svg.attr("viewBox", [-w/2, -h/2, w, h]);
  sim.force("center", d3.forceCenter(0, 0));
  sim.alpha(0.5).restart();
}
window.addEventListener("resize", fit);
fit();

// --- Filters ---
function applyFilters() {
  const hideIso = document.getElementById("hide-isolated").checked;
  const showLbl = document.getElementById("show-labels").checked;
  const q = document.getElementById("search").value.trim().toLowerCase();
  const showNew = document.getElementById("highlight-new").checked;

  node.style("display", d => {
    if (!enabledCats.has(d.category)) return "none";
    if (hideIso && d.deg === 0) return "none";
    if (q) {
      const blob = (d.id + " " + d.title + " " + (d.tags||[]).join(" ")).toLowerCase();
      if (!blob.includes(q)) return "none";
    }
    return null;
  });
  link.style("display", l => {
    const a = byId.get(typeof l.source === "string" ? l.source : l.source.id);
    const b = byId.get(typeof l.target === "string" ? l.target : l.target.id);
    if (!a || !b) return "none";
    if (!enabledCats.has(a.category) || !enabledCats.has(b.category)) return "none";
    return null;
  });
  labels.style("display", showLbl ? null : "none");
  node.classed("new", d => showNew && d.isNew);
}
document.getElementById("hide-isolated").onchange = applyFilters;
document.getElementById("show-labels").onchange = applyFilters;
document.getElementById("highlight-new").onchange = applyFilters;
document.getElementById("search").oninput = applyFilters;

// --- Detail panel + focus ---
const detailEl = document.getElementById("detail");
function showDetail(d, hover) {
  const cat = d.category;
  const color = DATA.cat_colors[cat];
  const tags = (d.tags || []).map(t => `<span class="tag">${t}</span>`).join("");
  const neighbors = [...(adj.get(d.id) || [])].map(nid => byId.get(nid)).filter(Boolean);
  const neighborHtml = neighbors.length === 0 ? '<p class="subtle">No connections.</p>' :
    neighbors.map(n => `<a href="#" onclick="focusNode('${n.id}');return false;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${DATA.cat_colors[n.category]};margin-right:6px;"></span>${n.id} · ${n.title.slice(0, 50)}</a>`).join("");

  detailEl.innerHTML = `
    <div class="pid">${d.id} · ${d.date || "?"}</div>
    <h3>${d.title}</h3>
    <span class="cat-pill" style="background:${color}">${DATA.cat_labels[cat]}</span>
    ${d.isNew ? '<span class="cat-pill" style="background:#f59e0b;margin-left:6px;">RECENT</span>' : ''}
    <div class="core">${d.core || ''}</div>
    <div class="tags">${tags}</div>
    <div class="related"><strong style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;">Connections (${neighbors.length})</strong>${neighborHtml}</div>
    <a class="open-btn" href="${d.url}">Open paper →</a>
  `;
}

function focusNode(pid) {
  const target = byId.get(pid);
  if (!target) return;
  showDetail(target, false);
  const neigh = adj.get(pid) || new Set();
  node.classed("hl", n => n.id === pid);
  node.classed("dim", n => n.id !== pid && !neigh.has(n.id));
  link.classed("hl", l => {
    const sId = typeof l.source === "string" ? l.source : l.source.id;
    const tId = typeof l.target === "string" ? l.target : l.target.id;
    return sId === pid || tId === pid;
  });
  link.classed("dim", l => {
    const sId = typeof l.source === "string" ? l.source : l.source.id;
    const tId = typeof l.target === "string" ? l.target : l.target.id;
    return sId !== pid && tId !== pid;
  });
}

svg.on("click", (e) => {
  if (e.target === svg.node() || e.target.tagName === "g") {
    node.classed("hl", false).classed("dim", false);
    link.classed("hl", false).classed("dim", false);
  }
});

applyFilters();
</script>
</body>
</html>
"""


if __name__ == "__main__":
    build()
