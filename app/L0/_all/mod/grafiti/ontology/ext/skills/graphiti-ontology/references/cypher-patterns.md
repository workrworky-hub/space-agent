# Cypher patterns reference

Companion to `SKILL.md`. Extended recipes, tuning notes, and edge cases for
the ontology extraction pipeline.

## Index propagation

If episode metadata propagation breaks (Graphiti version difference, or you
ran ingestion without the metadata block), backfill the tag from the
Episodic node down to its derived entities and edges:

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

`coalesce(...)` keeps any value that was already set, so re-running the
backfill is idempotent.

## Indexes

For useful query performance, index `source_id` on every label that may
carry it. The exact label names depend on your Graphiti schema — check
`CALL db.labels()` first.

```cypher
CREATE INDEX entity_source_id IF NOT EXISTS FOR (n:Entity) ON (n.source_id);
CREATE INDEX episodic_source_id IF NOT EXISTS FOR (n:Episodic) ON (n.source_id);
```

If your Graphiti schema does not put a single label on every node, fall back
to the schema-agnostic version that scans all nodes:

```cypher
CREATE INDEX node_source_id_universal IF NOT EXISTS
FOR (n) ON (n.source_id)
```

(Universal property indexes require Neo4j 5.x.)

## Hub-aware shortest path

The query the widget actually runs. Note: `*..K` cannot be parameterised;
the JS side interpolates `K` after clamping it to `[1, 8]`.

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
         n IN nodes(path)[1..-1] | s + log(1 + toFloat(size((n)--())))
       )
     END AS hub_score
RETURN nodes(path) AS ns, relationships(path) AS rs, hub_score
ORDER BY hub_score ASC
LIMIT $limit
```

Tuning notes:

- Bumping `LIMIT` from 3 → 5 catches alternative spines without much noise.
- Replacing `[1..-1]` with `nodes(path)` includes anchor degrees in the
  score; useful if your anchors are themselves wildly different in size.
- For very large graphs, swap `allShortestPaths(...)` for `shortestPath(...)`
  inside a per-row scoring CALL { ... } to get one path per pair faster.

## Two anchor diagnostics

When the rendered ontology looks empty for a particular pair, run the
diagnostic Cypher to confirm both anchors exist:

```cypher
MATCH (a {source_id: $tag1}) WITH count(a) AS a_count
MATCH (b {source_id: $tag2}) RETURN a_count, count(b) AS b_count
```

A zero on either side means the source-tag propagation broke.

When anchors exist but no path is found within `maxHops`:

```cypher
MATCH (a {source_id: $tag1}), (b {source_id: $tag2})
WHERE a <> b
MATCH path = (a)-[*1..8]-(b)
RETURN length(path) AS hops, count(*) AS paths
ORDER BY hops ASC
LIMIT 5
```

If this returns rows with `hops` greater than 6, raise the slider in the
widget.

## Densify a thin spine

When the ontology comes out too sparse (only the literal anchor pair edges,
no intermediates), Graphiti probably did not infer any cross-domain edges.
Run a one-off densification by running an Episodic neighborhood expansion:

```cypher
MATCH (e:Episodic)
WHERE e.source_id IN $tags
WITH collect(DISTINCT e) AS eps
UNWIND eps AS e
MATCH (e)-[:MENTIONS|HAS_FACT*1..3]->(n)
RETURN DISTINCT n.uuid AS uuid, labels(n) AS labels, n.source_id AS source_id
```

This surfaces every node touched by any anchor-tagged episode regardless of
shortest-path inclusion.

## Counter-pattern: do not predefine the ontology

Resist the temptation to write Cypher like:

```cypher
// DO NOT DO THIS
MATCH (a:Tenant)-[:LIVES_IN]->(u:Unit)-[:UNDER]->(l:Lease)
RETURN a, u, l
```

This is the manual-schema antipattern the whole skill exists to avoid. The
intermediate node types must emerge from `shortestPath`, never from a
hand-written MATCH chain. If you find yourself writing labels into the
ontology query, stop and re-run the canonical hub-aware shortest path.
