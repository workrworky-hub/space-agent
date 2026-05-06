/**
 * scripts/widget.js
 *
 * Standalone reference implementation of the ontology widget logic.
 * The live widget at `mod/grafiti/ontology/ontology.js` imports from here
 * so the two share one implementation. External Space Agent modules can
 * also import this directly.
 *
 * Core flow:
 *   1. cypherHttp(...)            — POST a Cypher query against /db/<db>/tx/commit
 *   2. fetchSourceTags(...)        — query (1)
 *   3. fetchOntologyPaths(tags)    — pairwise hub-aware shortestPath (query 5)
 *   4. mergePathsToGraph(paths)    — dedupe by uuid into {nodes, edges}
 *   5. detectHubs(paths, anchors)  — stage-2 hub detection
 *
 * Transport: prefers direct browser fetch via space.fetchExternal so that
 * CORS failure is auto-retried via /api/proxy by the Space Agent runtime.
 */

import {
  Q_DISTINCT_SOURCE_IDS,
  Q_HUB_AWARE_SHORTEST_PATHS,
} from "./neo4j-queries.js";

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

function buildAuthHeader(username, password) {
  if (!username) return {};
  const token = btoa(`${username}:${password ?? ""}`);
  return { Authorization: `Basic ${token}` };
}

function pickFetcher() {
  // Use space.fetchExternal when available so the runtime handles
  // CORS-fallback-via-proxy automatically. Otherwise fall back to fetch.
  if (typeof globalThis.space?.fetchExternal === "function") {
    return globalThis.space.fetchExternal.bind(globalThis.space);
  }
  return globalThis.fetch.bind(globalThis);
}

/**
 * Run a Cypher statement against the Neo4j HTTP transactional endpoint.
 *
 * @param {object} cfg            { httpUrl, username, password, database }
 * @param {string} statement      Cypher query (already template-resolved)
 * @param {object} parameters     Cypher parameters
 * @returns {Promise<object>}     parsed JSON response
 */
export async function cypherHttp(cfg, statement, parameters = {}) {
  if (!cfg?.httpUrl) throw new Error("Neo4j httpUrl is required");
  const db = cfg.database || "neo4j";
  const url = `${cfg.httpUrl.replace(/\/+$/, "")}/db/${encodeURIComponent(db)}/tx/commit`;
  const fetchFn = pickFetcher();
  const res = await fetchFn(url, {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    credentials: "omit",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...buildAuthHeader(cfg.username, cfg.password),
    },
    body: JSON.stringify({
      statements: [{ statement, parameters, resultDataContents: ["row", "graph"] }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Neo4j ${res.status}: ${text || res.statusText}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Neo4j error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  return json;
}

/* ------------------------------------------------------------------ *
 * Query helpers
 * ------------------------------------------------------------------ */

/** Fetch distinct source_id tags + their node counts. */
export async function fetchSourceTags(cfg) {
  const json = await cypherHttp(cfg, Q_DISTINCT_SOURCE_IDS);
  const result = json.results?.[0];
  if (!result) return [];
  return result.data.map((d) => ({
    source_id: d.row[0],
    node_count: Number(d.row[1] || 0),
  }));
}

/**
 * Fetch all hub-aware shortest paths between every pair of selected source
 * tags. Returns an array of paths, each `{ nodes:[], edges:[], hubScore }`.
 */
export async function fetchOntologyPaths(cfg, tags, opts = {}) {
  const maxHops = Number(opts.maxHops || 6);
  const limitPerPair = Number(opts.limitPerPair || 3);
  const statement = Q_HUB_AWARE_SHORTEST_PATHS(maxHops);
  const tagList = Array.from(new Set(tags || [])).filter(Boolean);
  if (tagList.length < 2) return [];

  const pairs = [];
  for (let i = 0; i < tagList.length; i += 1) {
    for (let j = i + 1; j < tagList.length; j += 1) {
      pairs.push([tagList[i], tagList[j]]);
    }
  }

  const all = await Promise.all(
    pairs.map(async ([tag1, tag2]) => {
      try {
        const json = await cypherHttp(cfg, statement, { tag1, tag2, limit: limitPerPair });
        const result = json.results?.[0];
        if (!result) return [];
        return result.data
          .map((d) => parseGraphRow(d))
          .filter(Boolean)
          .map((p) => ({ ...p, anchorPair: [tag1, tag2] }));
      } catch (err) {
        return [{ error: err.message, anchorPair: [tag1, tag2] }];
      }
    })
  );
  return all.flat();
}

/**
 * Parse one row of the Neo4j HTTP `graph` response into `{nodes, edges}`.
 * The HTTP API returns `data[i].graph = { nodes: [...], relationships: [...] }`.
 */
function parseGraphRow(row) {
  const g = row?.graph;
  if (!g) return null;
  const nodes = (g.nodes || []).map((n) => ({
    id: String(n.id),
    uuid: n.properties?.uuid || `n:${n.id}`,
    name: n.properties?.name || n.properties?.uuid || `node-${n.id}`,
    labels: Array.isArray(n.labels) ? n.labels : [],
    sourceId: n.properties?.source_id || null,
    summary: n.properties?.summary || "",
    properties: n.properties || {},
  }));
  const edges = (g.relationships || []).map((r) => ({
    id: String(r.id),
    uuid: r.properties?.uuid || `e:${r.id}`,
    type: r.type,
    from: String(r.startNode),
    to: String(r.endNode),
    sourceId: r.properties?.source_id || null,
  }));
  return { nodes, edges, hubScore: Number(row?.row?.[2] ?? 0) };
}

/* ------------------------------------------------------------------ *
 * Merging + hub detection
 * ------------------------------------------------------------------ */

/** Dedupe nodes/edges across all paths into a single graph. */
export function mergePathsToGraph(paths) {
  const nodeMap = new Map();
  const edgeMap = new Map();
  for (const p of paths) {
    if (!p?.nodes) continue;
    for (const n of p.nodes) {
      const key = n.uuid || n.id;
      if (!nodeMap.has(key)) nodeMap.set(key, { ...n });
    }
    for (const e of p.edges || []) {
      const key = e.uuid || `${e.from}->${e.to}:${e.type}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { ...e });
    }
  }
  return { nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
}

/**
 * Stage-2 hub detection. A non-anchor node is flagged a hub if it appears in
 * more than `threshold` (default 0.5) of all collected paths.
 */
export function detectHubs(paths, anchorSourceIds, threshold = 0.5) {
  const totalPaths = paths.length || 1;
  const appearances = new Map();
  const anchorTags = new Set(anchorSourceIds || []);
  for (const p of paths) {
    if (!p?.nodes) continue;
    const seen = new Set();
    for (const n of p.nodes) {
      if (anchorTags.has(n.sourceId)) continue;
      const key = n.uuid || n.id;
      if (seen.has(key)) continue;
      seen.add(key);
      appearances.set(key, (appearances.get(key) || 0) + 1);
    }
  }
  const hubs = new Set();
  for (const [id, count] of appearances) {
    if (count / totalPaths > threshold) hubs.add(id);
  }
  return hubs;
}

/* ------------------------------------------------------------------ *
 * Rendering helpers (vis-network)
 * ------------------------------------------------------------------ */

/**
 * Convert a merged graph + hub set into vis-network-ready { nodes, edges }.
 * `tagPalette` is `{ source_id: "#hex" }`. Hubs are rendered faded grey.
 */
export function toVisDataset(graph, opts = {}) {
  const hubs = opts.hubs || new Set();
  const palette = opts.tagPalette || {};
  const hideHubs = !!opts.hideHubs;

  const nodes = graph.nodes
    .filter((n) => !(hideHubs && hubs.has(n.uuid || n.id)))
    .map((n) => {
      const isHub = hubs.has(n.uuid || n.id);
      const isAnchor = !!n.sourceId;
      const color = isHub
        ? "#3a3f4d"
        : isAnchor
        ? palette[n.sourceId] || "#7ddcff"
        : "#8e9bb2";
      return {
        id: n.uuid || n.id,
        label: n.name,
        title: buildTitle(n, { isHub, isAnchor }),
        color: { background: color, border: isHub ? "#555" : color, highlight: { background: color, border: "#fff" } },
        font: { color: isHub ? "#9aa3b6" : "#f3f7ff", size: isAnchor ? 16 : 12 },
        size: isAnchor ? 28 : isHub ? 12 : 16,
        shape: isAnchor ? "dot" : "ellipse",
        sourceId: n.sourceId || null,
        isHub,
        isAnchor,
      };
    });

  const visibleIds = new Set(nodes.map((n) => n.id));
  const edges = graph.edges
    .filter((e) => visibleIds.has(e.uuid || e.id ? e.from : null) || true) // keep all; vis filters orphans
    .map((e) => ({
      id: e.uuid || `${e.from}->${e.to}`,
      from: e.from,
      to: e.to,
      label: e.type || "",
      arrows: "to",
      color: { color: "#5a6b88", highlight: "#7ddcff" },
      width: 1.4,
      smooth: { type: "dynamic" },
    }))
    .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to));

  return { nodes, edges };
}

function buildTitle(node, flags) {
  const lines = [
    `<b>${escapeHtml(node.name)}</b>`,
    flags.isAnchor ? `Anchor: <code>${escapeHtml(node.sourceId)}</code>` : "",
    flags.isHub ? `<span style="color:#ffa066">Hub (degree-flagged)</span>` : "",
    node.labels?.length ? `Labels: ${node.labels.map(escapeHtml).join(", ")}` : "",
    node.summary ? `<i>${escapeHtml(node.summary)}</i>` : "",
  ].filter(Boolean);
  return lines.join("<br>");
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

/**
 * Stable, distinct color assignment per source_id. Returns a frozen map.
 */
export function buildPalette(sourceIds) {
  const colors = ["#7ddcff", "#79edd8", "#ffd166", "#ff8d98", "#c39bff", "#94bcff", "#7ce4b0", "#ff9f6b"];
  const map = {};
  Array.from(new Set(sourceIds || [])).forEach((id, i) => {
    map[id] = colors[i % colors.length];
  });
  return Object.freeze(map);
}
