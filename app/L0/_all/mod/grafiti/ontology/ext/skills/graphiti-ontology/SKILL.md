---
name: graphiti-ontology
description: >
  Build and visualize a domain ontology from a Graphiti knowledge graph stored
  in Neo4j. Use when the user wants to extract an ontology, visualize knowledge
  graph connections, query source-tagged nodes, run shortest path between domain
  concepts, or build an ontology widget in Space Agent. Triggers on: ontology,
  knowledge graph, Graphiti, Neo4j shortest path, source triplet, domain concepts.
metadata:
  when: true
---

# Graphiti Ontology

This skill teaches one capability: **emerge a clean domain ontology from a
Graphiti knowledge graph by running pairwise shortest-path between
source-tagged anchor nodes in Neo4j.**

The ontology is never manually defined. It emerges purely from graph topology.
The same source triplet that tags data at write time IS the query key at read
time — that bridge is the entire trick.

The companion live widget lives at `#/ontology` inside this Space Agent
workspace. See `view.html`, `ontology.js`, and `ontology.css` under
`mod/grafiti/ontology/`. The standalone reference renderer used by external
consumers is `scripts/widget.js` next to this file.

## Architecture (one paragraph)

Three components. **Graphiti** ingests raw data and writes nodes and edges
into **Neo4j**, automatically extracting entities and relationships, **with a
source triplet attached at episode level so it propagates to every derived
node and edge**. **Space Agent** never talks to Graphiti — it reads Neo4j
directly through the HTTP transactional Cypher endpoint (or the Bolt driver
when available) and renders an interactive ontology widget. The ontology is
the union of all pairwise shortest paths between source-tagged anchors,
hub-aware ranked at query time, hub-flagged at render time.

## The source triplet (the most important rule)

Every Graphiti episode must carry a `source_id` (a domain anchor label) plus
a short `(subject, predicate, object)` triplet describing the episode's
spine. The full tag is:

```
(subject, predicate, object, source_id)
```

`source_id` is the only field that drives the ontology. Examples:

| Domain               | source_id values                          |
|----------------------|-------------------------------------------|
| Property management  | `maintenance`, `staff`, `tenant`          |
| Legal                | `contract`, `party`, `clause`             |
| Medical              | `patient`, `drug`, `condition`            |
| Finance              | `account`, `instrument`, `counterparty`   |

Why it must be at episode level: Graphiti propagates episode metadata to
every entity it extracts and every edge it infers. Tagging at episode level
means **all downstream nodes inherit `source_id` automatically** — no
per-entity manual labelling.

### Tagging at ingestion time

```python
# Python — graphiti_core
await graphiti.add_episode(
    name="Q1 maintenance ticket #2317",
    episode_body=raw_text,
    source=EpisodeType.text,
    source_description="PM ticketing system export",
    reference_time=ticket.created_at,
    # The triplet — propagates to every extracted entity & edge.
    metadata={
        "source_id": "maintenance",
        "triplet_subject":   "tenant",
        "triplet_predicate": "filed",
        "triplet_object":    "ticket",
    },
)
```

```js
// JavaScript — see scripts/ingest.js for the helper
import { buildEpisodeTag } from "/mod/grafiti/ontology/ext/skills/graphiti-ontology/scripts/ingest.js";

await graphiti.addEpisode({
  name: "Q1 maintenance ticket #2317",
  body: rawText,
  metadata: buildEpisodeTag({
    sourceId:  "maintenance",
    subject:   "tenant",
    predicate: "filed",
    object:    "ticket",
  }),
});
```

After ingestion, every Neo4j node Graphiti created from this episode carries
`n.source_id = "maintenance"` and every relationship carries
`r.source_id = "maintenance"`.

### Hardening the propagation (server side)

If your Graphiti version does not stamp every node, run the backfill Cypher
once per ingest batch:

```cypher
MATCH (e:Episodic {uuid: $episode_uuid})-[:MENTIONS|HAS_FACT*1..2]->(n)
SET n.source_id        = coalesce(n.source_id,        $source_id),
    n.triplet_subject  = coalesce(n.triplet_subject,  $subject),
    n.triplet_predicate= coalesce(n.triplet_predicate,$predicate),
    n.triplet_object   = coalesce(n.triplet_object,   $object)
WITH e
MATCH (e)-[:MENTIONS|HAS_FACT*1..2]->()-[r]-()
SET r.source_id = coalesce(r.source_id, $source_id)
```

The exact constant lives in `scripts/ingest.js` as `BACKFILL_CYPHER`.

## The six canonical Cypher queries

All queries assume `source_id` exists on every node. Variable-length bounds
in Cypher cannot be parameterised, so a max-hops value must be interpolated
into the query string before execution. The constants live in
`scripts/neo4j-queries.js`.

### 1. Distinct source tags

```cypher
MATCH (n)
WHERE n.source_id IS NOT NULL
RETURN DISTINCT n.source_id AS source_id, count(n) AS node_count
ORDER BY node_count DESC
```

### 2. All nodes for a given source_id

```cypher
MATCH (n {source_id: $source_id})
RETURN n.uuid AS uuid, n.name AS name, labels(n) AS labels, n.summary AS summary
LIMIT $limit
```

### 3. shortestPath between two source anchors

```cypher
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = shortestPath((a)-[*..6]-(b))
RETURN nodes(path) AS ns, relationships(path) AS rs
LIMIT $limit
```

### 4. allShortestPaths between two source anchors

```cypher
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = allShortestPaths((a)-[*..6]-(b))
RETURN nodes(path) AS ns, relationships(path) AS rs
LIMIT $limit
```

### 5. Pairwise union — the ontology

For N source tags this is `N*(N-1)/2` invocations of (3) or the hub-aware
variant below, executed in parallel by the client and merged by `uuid`.

### 6. Full subgraph between source nodes up to depth K

```cypher
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = (a)-[*1..3]-(b)
RETURN nodes(path) AS ns, relationships(path) AS rs
LIMIT $limit
```

Use only when shortest path collapses too aggressively and the user wants
breadth, not just the spine.

## The hub-node problem (and the elegant solution)

When you compute shortestPath across all anchor pairs, certain "hub" nodes —
generic entities like `User`, `System`, `Date`, `Document` — appear on most
paths because they are connected to almost everything. They poison the
ontology because they are not domain structure; they are infrastructure.

**The fix is two-stage and parameter-free.**

### Stage 1 — degree-weighted path scoring (server side)

When fetching paths between an anchor pair, compute a degree-aware score for
each shortest path and prefer the one whose intermediates have the lowest
summed log-degree. Higher-degree intermediates are penalised:

```cypher
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = allShortestPaths((a)-[*..6]-(b))
WITH path,
     CASE
       WHEN size(nodes(path)) <= 2 THEN 0.0
       ELSE reduce(
         s = 0.0,
         n IN nodes(path)[1..-1]
           | s + log(1 + toFloat(size((n)--())))
       )
     END AS hub_score
RETURN nodes(path) AS ns, relationships(path) AS rs, hub_score
ORDER BY hub_score ASC
LIMIT 3
```

`size((n)--())` is the degree of `n`. The summed `log(1 + degree)` over
intermediate nodes (anchors excluded) rises sharply for paths through hubs.
Sorting ASC returns the most domain-specific path first.

### Stage 2 — path-frequency hub detection (client side)

Some hubs survive stage 1 because every path between certain anchor pairs
truly does go through them. After collecting all paths across all anchor
pairs, count how often each non-anchor node appears:

```js
function detectHubs(paths, anchorIds) {
  const totalPaths  = paths.length || 1;
  const appearances = new Map();
  for (const p of paths)
    for (const n of p.nodes)
      if (!anchorIds.has(n.id))
        appearances.set(n.id, (appearances.get(n.id) || 0) + 1);
  // A node is a hub if it appears in > 50% of all paths.
  const hubs = new Set();
  for (const [id, count] of appearances)
    if (count / totalPaths > 0.5) hubs.add(id);
  return hubs;
}
```

The widget renders hubs in a faded color and exposes a "Hide hubs" toggle.
**It never deletes them silently** — the user always sees the topology truth.

### Why this is the elegant solution

- **No magic numbers in Cypher.** `log(1 + degree)` smoothly downweights hubs
  without a hard threshold.
- **Two complementary signals.** Degree weighting acts at query time on each
  anchor pair; path-frequency acts globally across the full ontology. They
  catch different failure modes — the first prevents single hub-routed paths,
  the second catches hubs that dominate many independent paths.
- **The user stays in control.** Hubs are flagged, not erased. The toggle
  preserves epistemic honesty.

## Building the widget inside Space Agent

The live widget is mounted at `#/ontology`. The reference standalone
implementation that any consumer can drop into another Space Agent module is
`scripts/widget.js` next to this file. The two share the same query
constants from `scripts/neo4j-queries.js`.

### What the widget does

1. On first run, prompts for `{ httpUrl, username, password }` against the
   Neo4j HTTP endpoint (default `http://localhost:7474`).
2. Stores `httpUrl` and `username` in `localStorage`; password in
   `sessionStorage` (does not survive a hard tab close — security).
3. Loads distinct `source_id` tags via query (1).
4. User picks which tags to include (default: all).
5. Runs the hub-aware variant of (3) for every pair, in parallel.
6. Merges nodes and edges, dedupes by `uuid`.
7. Detects hubs client-side (stage 2).
8. Renders with `vis-network` (loaded from CDN as online-by-nature data viz).
9. Persists selected tags + layout + depth in `localStorage` keyed
   `grafiti.ontology.config`.

### Connectivity

The widget uses `space.fetchExternal(...)` so direct browser → Neo4j calls
are tried first, and on CORS failure the runtime auto-routes through
`/api/proxy`. Never embed Neo4j credentials in code; always read them from
the prompt UI.

### Controls

- **Source tag filter** — checkbox per `source_id`, default all on.
- **Path depth slider** — 1 to 6 hops, default 4.
- **Layout toggle** — force-directed (`vis.physics`) or hierarchical (`vis.layout.hierarchical`).
- **Hide hubs** — toggle that fades / hides hub-flagged nodes (stage 2).
- **Reset view** — refits the camera.
- **Re-run** — re-queries Neo4j with the current settings.

## Proof of work

The system is correct only when **intermediate domain-specific nodes appear
in the rendered ontology that are not defined anywhere in the code**.

Test recipe:

1. Pick a domain with three source tags. (Property management:
   `maintenance`, `staff`, `tenant`.)
2. Ingest 15–20 episodes per tag through Graphiti, each tagged at episode
   level with the correct `source_id` and a triplet.
3. Open `#/ontology`. Connect to Neo4j. Run.
4. Confirm intermediate nodes such as `unit`, `lease`, `work_order`,
   `payment` appear on the canvas — even though no code anywhere mentions
   those names.

If those intermediates appear, the ontology emerged from topology. The
system works. If they do not, source-tag propagation broke; check the
stage-1 backfill Cypher above.

## Architecture rules (non-negotiable)

- Space Agent reads Neo4j only — never Graphiti.
- Source tagging happens at Graphiti episode write time — never post-hoc.
- Shortest path is the only ontology extraction mechanism — no manual schema.
- Source triplet `(subject, predicate, object, source_id)` format is fixed.
- Graphiti owns all entity and relationship extraction.
- The pattern is domain-agnostic; property management is one example.

## File map

- `SKILL.md` — this file
- `scripts/ingest.js` — Graphiti episode-tagging helper + backfill Cypher
- `scripts/neo4j-queries.js` — the six canonical Cypher queries as constants
- `scripts/widget.js` — standalone widget reference implementation
- `references/cypher-patterns.md` — extended Cypher recipes and tuning notes
