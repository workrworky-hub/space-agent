# AGENTS

## Purpose

`grafiti/ontology/` owns the live domain-ontology widget inside Space
Agent. It reads the Graphiti knowledge graph in Neo4j directly and renders
an interactive ontology by running pairwise hub-aware shortest-path between
source-tagged anchor nodes.

This module is paired with the doctrine skill at
`ext/skills/graphiti-ontology/SKILL.md`. The skill teaches the "why" and the
canonical Cypher; this module is the live "what".

The ontology never comes from manual schema. It emerges from graph topology.
The same source triplet stamped at Graphiti episode write time is the query
key at read time — that bridge is the entire trick. See the skill for the
full doctrine.

## Ownership

This module owns:

- `view.html`: routed shell at `#/ontology`
- `ontology.css`: module-local layout for the connect card, sidebar, and
  graph canvas
- `ontology.js`: Alpine store that handles connection, querying, hub
  detection, and rendering. Imports from the paired skill so logic stays
  in one place.
- `ext/panels/ontology.yaml`: dashboard-panel manifest
- `ext/html/_core/onscreen_menu/items/ontology.html`: top-bar menu entry
- `ext/skills/graphiti-ontology/`: the doctrine skill plus reusable
  scripts (`neo4j-queries.js`, `ingest.js`, `widget.js`) and an extended
  Cypher reference

## Local Contracts

Routing:

- the module is routed at `#/ontology`
- on first run the user enters `{ httpUrl, username, password, database }`
  for Neo4j
- `httpUrl`, `username`, `database`, the selected source tags, the path
  depth, the layout choice, and the hide-hubs toggle persist in
  `localStorage` under the key `grafiti.ontology.config`
- `password` is held in `sessionStorage` only; closing the tab purges it

Connectivity:

- requests use `space.fetchExternal(...)` so the runtime tries direct
  browser → Neo4j first and falls back to `/api/proxy` automatically on
  CORS failure
- transport is the Neo4j HTTP transactional Cypher endpoint
  (`POST /db/<database>/tx/commit`); Bolt would also work but adds
  protocol weight in the browser

Vendor assets:

- `vis-network` is loaded from a CDN (`unpkg.com/vis-network@9.1.9`) at
  the top of `view.html`. This widget is treated as an online-by-nature
  data-viz feature per the app rules; the rendering library is not
  framework-required
- if your deployment forbids CDNs, vendor `vis-network.min.js` to
  `mod/grafiti/ontology/vendor/` and update the `<script src>` in
  `view.html`

Hub-node solution:

- stage 1 (server side): the canonical Cypher in
  `ext/skills/graphiti-ontology/scripts/neo4j-queries.js` ranks paths by
  summed `log(1 + degree)` of intermediate nodes; the `LIMIT $limit` keeps
  only the lowest-scored paths per anchor pair
- stage 2 (client side): `detectHubs` in the paired `widget.js` flags any
  non-anchor node appearing in more than 50 % of all collected paths and
  the UI fades or hides them based on the toggle
- the toggle is opt-out, not destructive; the user always sees the topology
  truth and can re-include hubs with a click

## Development Guidance

- never reach into `Graphiti` from here — `Space Agent reads Neo4j only`
- never define ontology node types in code; they must emerge from
  shortest-path. If you find yourself MATCHing on `:Tenant` or `:Unit`,
  stop and use the canonical query
- keep `ontology.js` thin; the heavy logic lives in the paired
  `scripts/widget.js` so the live widget and the standalone reference do
  not drift
- when the Cypher contract changes, update both `scripts/neo4j-queries.js`
  and `references/cypher-patterns.md` in the same session
- this module is the proof-of-work surface for the doctrine — if the
  intermediate nodes do not emerge for a real ingest, the source-tag
  propagation broke and the backfill Cypher in the skill must run
