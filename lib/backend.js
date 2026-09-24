// lib/backend.js — shared clustering / ordering backend.
//
// Operates on generic statement records, so every language frontend
// (JS, TS, HTML-inline-JS, Python) shares one grouping implementation.
// Record shape: { idx, start, end, isHoisted, declaredNames: [],
//                 freeNames: Set, immediateNames: Set }

function analyzeRecords(records, opts) {
  opts = opts || {};
  // declaredNames map: name -> first declaring statement index.
  // NOTE: on duplicates, refs resolve to the FIRST declaration for naming —
  // but ORDER + CLUSTER edges link to ALL same-name declarations (see below).
  const declaredAt = new Map();
  const declaredAll = new Map(); // name -> every declaring stmt idx
  const duplicateDeclarations = [];
  for (const s of records) for (const name of s.declaredNames) {
    if (!declaredAt.has(name)) declaredAt.set(name, s.idx);
    else duplicateDeclarations.push({ name, firstStmt: declaredAt.get(name), againStmt: s.idx });
    if (!declaredAll.has(name)) declaredAll.set(name, []);
    declaredAll.get(name).push(s.idx);
  }
  if (duplicateDeclarations.length && !opts.quiet) {
    console.log(`⚠ ${duplicateDeclarations.length} duplicate top-level declaration(s) — refs resolve to the first:`,
      duplicateDeclarations.map(d => `${d.name} (stmts ${d.firstStmt}, ${d.againStmt})`).join('; '));
  }

  const usageCount = new Map();
  for (const s of records) {
    for (const name of s.freeNames) {
      if (!declaredAt.has(name)) continue; // external/global
      usageCount.set(name, (usageCount.get(name) || 0) + 1);
    }
  }
  const hubThreshold = Math.max(6, Math.ceil(records.length * opts.hubRatio));
  // --no-hubs disables suppression entirely (S2-2: hubRatio 0 can NOT do
  // this — the max(6, …) floor makes 0 the most aggressive setting).
  const hubNames = opts.noHubs ? new Set() : new Set(
    [...usageCount.entries()].filter(([, c]) => c > hubThreshold).map(([n]) => n)
  );

  // clusterEdges: undirected, hub-suppressed (uses ALL refs).
  // orderEdges: directed dependent -> dependency (immediate refs only,
  // and never OUT of a hoisted declaration — its body runs later).
  // Correctness vs duplicates (S1-3/drop-in contract): JS last-wins, so a
  // caller linked ONLY to the first same-name declaration can be ordered
  // before the definition that actually runs at runtime. Both edge sets
  // therefore link to EVERY same-name declaration — conservative (files get
  // more coupled, never misordered).
  const clusterEdges = [];
  const orderEdges = [];
  for (const s of records) {
    for (const name of s.freeNames) {
      const owners = declaredAll.get(name);
      if (!owners) continue; // external/global
      if (!hubNames.has(name)) for (const owner of owners) {
        if (owner !== s.idx) clusterEdges.push([s.idx, owner]);
      }
    }
    if (!s.isHoisted) {
      for (const name of s.immediateNames) {
        const owners = declaredAll.get(name);
        if (!owners) continue;
        for (const owner of owners) {
          if (owner !== s.idx) orderEdges.push({ from: s.idx, to: owner });
        }
      }
    }
  }
  return { declaredAt, declaredAll, duplicateDeclarations, usageCount, hubNames, hubThreshold, clusterEdges, orderEdges };
}

// ---------- Union-Find clustering ----------
function clusterRecords(records, clusterEdges, opts) {
  const parent = records.map((_, i) => i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[a] = b; }
  for (const [a, b] of clusterEdges) union(a, b);

  const clusterMap = new Map();
  for (const s of records) {
    const r = find(s.idx);
    if (!clusterMap.has(r)) clusterMap.set(r, []);
    clusterMap.get(r).push(s.idx);
  }
  let clusters = [...clusterMap.values()].map(members => members.sort((a, b) => a - b));
  clusters.sort((a, b) => a[0] - b[0]);

  // Louvain refinement for oversized clusters (see original rationale in git).
  // Skipped entirely with --no-louvain (deterministic connected-components).
  const refined = [];
  let splitCount = 0;
  for (const cl of clusters) {
    if (!opts.noLouvain && cl.length > Math.max(30, Math.ceil(records.length * 0.10))) {
      const edges = buildWeightedEdges(cl, clusterEdges, records.length);
      const communities = louvain(cl, edges).filter(g => g.length > 0);
      if (communities.length > 1) {
        splitCount++;
        for (const g of communities) refined.push(g.sort((a, b) => a - b));
        continue;
      }
    }
    refined.push(cl);
  }
  clusters = refined.sort((a, b) => a[0] - b[0]);
  if (splitCount && !opts.quiet) {
    console.log(`Louvain refinement split ${splitCount} oversized cluster(s) into ${clusters.length} total clusters.`);
  }

  // Merge tiny clusters into the previous one (readability). Sizes are
  // precomputed once — the old code re-summed every cluster per decision.
  const stmtSize = records.map(r => r.end - r.start);
  const clusterSize = (cluster) => cluster.reduce((n, i) => n + stmtSize[i], 0);
  const merged = [];
  for (const cl of clusters) {
    const size = clusterSize(cl);
    if (merged.length && size < opts.minChars) {
      merged[merged.length - 1] = merged[merged.length - 1].concat(cl).sort((a, b) => a - b);
    } else {
      merged.push(cl.slice());
    }
  }
  return merged;
}

function buildWeightedEdges(nodeIds, clusterEdges, idSpace) {
  // Integer-key weights (no `${a},${b}` string split/parse churn): ids are
  // statement indices < idSpace, so small*idSpace+big is collision-free.
  const N = Math.max(1, idSpace || 0);
  const nodeSet = new Set(nodeIds);
  const weights = new Map();
  for (const [a, b] of clusterEdges) {
    if (!nodeSet.has(a) || !nodeSet.has(b)) continue;
    const key = a < b ? a * N + b : b * N + a;
    weights.set(key, (weights.get(key) || 0) + 1);
  }
  return [...weights.entries()].map(([k, w]) => {
    const a = Math.floor(k / N), b = k % N;
    return [a, b, w];
  });
}

// Standard Louvain (Blondel et al. 2008).
function louvain(nodeIds, edges) {
  const idx = new Map(nodeIds.map((id, i) => [id, i]));
  let graphEdges = edges.map(([a, b, w]) => [idx.get(a), idx.get(b), w]);
  let nodeMembers = nodeIds.map(id => [id]);

  for (let level = 0; level < 20; level++) {
    const nn = nodeMembers.length;
    const adj = Array.from({ length: nn }, () => new Map());
    const selfLoop = new Array(nn).fill(0);
    for (const [a, b, w] of graphEdges) {
      if (a === b) { selfLoop[a] += w; continue; }
      adj[a].set(b, (adj[a].get(b) || 0) + w);
      adj[b].set(a, (adj[b].get(a) || 0) + w);
    }
    const degree = new Array(nn).fill(0);
    let m = 0;
    for (let i = 0; i < nn; i++) {
      let d = selfLoop[i] * 2;
      for (const w of adj[i].values()) d += w;
      degree[i] = d;
      m += selfLoop[i];
      for (const [j, w] of adj[i]) if (j > i) m += w;
    }
    if (m === 0) break;

    const community = nodeMembers.map((_, i) => i);
    const commTot = degree.slice();

    let improved = true;
    let anyMoveEver = false;
    let guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < nn; i++) {
        const ci = community[i];
        commTot[ci] -= degree[i];
        const neighborComms = new Map();
        for (const [j, w] of adj[i]) {
          const cj = community[j];
          neighborComms.set(cj, (neighborComms.get(cj) || 0) + w);
        }
        let bestComm = ci, bestGain = 0;
        const kiInOld = neighborComms.get(ci) || 0;
        const removeGain = kiInOld / m - (commTot[ci] * degree[i]) / (2 * m * m);
        for (const [cj, kiIn] of neighborComms) {
          if (cj === ci) continue;
          const gain = (kiIn / m - (commTot[cj] * degree[i]) / (2 * m * m)) - removeGain;
          if (gain > bestGain) { bestGain = gain; bestComm = cj; }
        }
        commTot[bestComm] += degree[i];
        if (bestComm !== ci) { community[i] = bestComm; improved = true; anyMoveEver = true; }
      }
    }
    if (!anyMoveEver) break;

    const commIds = [...new Set(community)];
    const remap = new Map(commIds.map((c, i) => [c, i]));
    const newMembers = commIds.map(() => []);
    for (let i = 0; i < nn; i++) newMembers[remap.get(community[i])].push(...nodeMembers[i]);

    const newEdgeWeights = new Map();
    const NC = community.length ? Math.max(...community) + 1 : 1;
    for (const [a, b, w] of graphEdges) {
      const ca = remap.get(community[a]), cb = remap.get(community[b]);
      // Integer key again (ca/cb < NC): no string split/parse churn.
      const key = ca <= cb ? ca * NC + cb : cb * NC + ca;
      newEdgeWeights.set(key, (newEdgeWeights.get(key) || 0) + w);
    }
    graphEdges = [...newEdgeWeights.entries()].map(([k, w]) => {
      const a = Math.floor(k / NC), b = k % NC;
      return [a, b, w];
    });
    nodeMembers = newMembers;

    if (nodeMembers.length === nn) break;
  }

  return nodeMembers;
}

// ---------- Topological order (Kahn, original-index tie-break) ----------
// Correctness first: the cluster graph may contain CYCLES (grouping ignores
// edge direction, so stmts ordered A<B<C can land in files demanding an
// impossible order). We condense strongly-connected components (Tarjan) into
// single files first — the condensation DAG is always orderable, so Kahn can
// never fall back to a potentially broken order.
function orderClusters(clusters, orderEdges, opts) {
  opts = opts || {};
  function buildGraph(cls) {
    const stmtCluster = new Map();
    cls.forEach((cl, ci) => cl.forEach(i => stmtCluster.set(i, ci)));
    const n = cls.length;
    const adj = Array.from({ length: n }, () => new Set()); // to -> from
    for (const e of orderEdges) {
      const cf = stmtCluster.get(e.from), ct = stmtCluster.get(e.to);
      if (cf === undefined || ct === undefined || cf === ct) continue;
      adj[ct].add(cf);
    }
    return adj;
  }

  // Iterative Tarjan SCC (no recursion: cluster counts can be large).
  // Adjacency is snapshotted to arrays ONCE — the old code spread-copied
  // [...adj[v]] on every visit step.
  function tarjan(adj) {
    const n = adj.length;
    const adjList = adj.map(s => [...s]);
    const index = new Array(n).fill(-1), low = new Array(n).fill(0);
    const onStack = new Array(n).fill(false);
    const stack = [];
    const comp = new Array(n).fill(-1);
    let nextIndex = 0, nComp = 0;
    for (let s = 0; s < n; s++) {
      if (index[s] !== -1) continue;
      const work = [[s, 0]];
      while (work.length) {
        const top = work[work.length - 1];
        const v = top[0];
        if (top[1] === 0) {
          index[v] = low[v] = nextIndex++;
          stack.push(v);
          onStack[v] = true;
        }
        const neighbors = adjList[v];
        if (top[1] < neighbors.length) {
          top[1]++;
          const w = neighbors[top[1] - 1];
          if (index[w] === -1) {
            work.push([w, 0]);
          } else if (onStack[w]) {
            low[v] = Math.min(low[v], index[w]);
          }
        } else {
          work.pop();
          if (work.length) {
            const u = work[work.length - 1][0];
            low[u] = Math.min(low[u], low[v]);
          }
          if (low[v] === index[v]) {
            let w;
            do {
              w = stack.pop();
              onStack[w] = false;
              comp[w] = nComp;
            } while (w !== v);
            nComp++;
          }
        }
      }
    }
    return comp;
  }

  let finalClusters = clusters;
  let sccMerged = 0;
  {
    const comp = tarjan(buildGraph(finalClusters));
    const members = new Map();
    comp.forEach((c, i) => {
      if (!members.has(c)) members.set(c, []);
      members.get(c).push(i);
    });
    const cyclic = [...members.values()].filter(g => g.length > 1);
    if (cyclic.length) {
      sccMerged = cyclic.length;
      const merged = [];
      for (const g of members.values()) {
        if (g.length === 1) merged.push(finalClusters[g[0]].slice());
        else merged.push(g.flatMap(ci => finalClusters[ci]).sort((a, b) => a - b));
      }
      merged.sort((a, b) => a[0] - b[0]);
      finalClusters = merged;
      if (!opts.quiet) console.log(`⚠ Merged ${cyclic.length} cluster group(s) with circular load dependencies into single files — order is now guaranteed, files are bigger.`);
    }
  }

  const adj = buildGraph(finalClusters);
  const nClusters = finalClusters.length;
  const indeg = new Array(nClusters).fill(0);
  const seenEdge = new Set();
  for (let ct = 0; ct < nClusters; ct++) {
    for (const cf of adj[ct]) {
      const key = ct + '->' + cf;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      indeg[cf]++;
    }
  }

  // Kahn with a binary heap keyed by original position (minIdx). The old
  // code re-sorted `available` on EVERY emitted cluster — O(k² log k),
  // measured 536ms for 3 000 clusters. Heap push/pop is O(log k).
  const minIdx = finalClusters.map(cl => cl[0]);
  const order = [];
  const heap = [];
  const heapLess = (a, b) => minIdx[a] < minIdx[b];
  const heapPush = (x) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  for (let c = 0; c < nClusters; c++) if (indeg[c] === 0) heapPush(c);
  const inOrder = new Array(nClusters).fill(false);
  let warnedCycle = false;
  while (order.length < nClusters) {
    const c = heap.length ? heapPop() : undefined;
    if (c === undefined) {
      // Unreachable on a condensed DAG — retained as a safety net.
      warnedCycle = true;
      const remaining = [];
      for (let i = 0; i < nClusters; i++) if (!inOrder[i]) remaining.push(i);
      remaining.sort((a, b) => minIdx[a] - minIdx[b]);
      for (const r of remaining) { order.push(r); inOrder[r] = true; }
      break;
    }
    inOrder[c] = true;
    order.push(c);
    for (const next of adj[c]) { indeg[next]--; if (indeg[next] === 0) heapPush(next); }
  }
  if (warnedCycle && !opts.quiet) console.log('⚠ Dependency cycle survived condensation — fell back to original order (verify output!).');
  return { order, warnedCycle, clusters: finalClusters, sccMerged };
}

// ---------- Naming ----------
function toKebab(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-+|-+$/g, '');
}

function nameClusters(clustersInOrder, records, usageCount, usedNames, ext) {
  const byIdx = new Map(records.map(r => [r.idx, r]));
  return clustersInOrder.map(cl => {
    let best = null, bestScore = -1;
    for (const i of cl) {
      for (const name of byIdx.get(i).declaredNames) {
        const score = usageCount.get(name) || 0;
        if (score > bestScore) { bestScore = score; best = name; }
      }
    }
    // Empty-base guard (S3): names like `___` kebab to '' → hidden `.js`.
    // Length cap: stay safely under NAME_MAX/Windows limits.
    let base = best ? toKebab(best) : '';
    if (!base) base = `section-${cl[0]}`;
    if (base.length > 80) base = base.slice(0, 80).replace(/-+$/g, '') || `section-${cl[0]}`;
    let file = base + ext;
    let n = 2;
    while (usedNames.has(file)) { file = `${base}-${n++}${ext}`; }
    usedNames.add(file);
    return file;
  });
}

module.exports = { analyzeRecords, clusterRecords, orderClusters, nameClusters, toKebab };
