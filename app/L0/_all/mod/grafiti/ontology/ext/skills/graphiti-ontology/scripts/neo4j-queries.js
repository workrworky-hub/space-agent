/**
 * scripts/neo4j-queries.js
 *
 * The six canonical Cypher queries used by the ontology widget and by any
 * external skill that wants the same semantics. Parameter names are stable;
 * do not rename without updating every consumer in this skill.
 *
 * Note: Cypher does not allow parameterised variable-length bounds, so any
 * max-hops value must be interpolated into the query string before execution.
 * The TEMPLATE functions below take a numeric `maxHops` and return a string.
 */

export const Q_DISTINCT_SOURCE_IDS = `
MATCH (n)
WHERE n.source_id IS NOT NULL
RETURN DISTINCT n.source_id AS source_id, count(n) AS node_count
ORDER BY node_count DESC
`;

export const Q_NODES_BY_SOURCE_ID = `
MATCH (n {source_id: $source_id})
RETURN n.uuid AS uuid, n.name AS name, labels(n) AS labels, n.summary AS summary
LIMIT $limit
`;

function clampHops(maxHops) {
  const n = parseInt(maxHops, 10);
  if (!Number.isFinite(n)) return 6;
  return Math.max(1, Math.min(8, n));
}

export const Q_SHORTEST_PATH = (maxHops = 6) => `
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = shortestPath((a)-[*..${clampHops(maxHops)}]-(b))
RETURN nodes(path) AS ns, relationships(path) AS rs
LIMIT $limit
`;

export const Q_ALL_SHORTEST_PATHS = (maxHops = 6) => `
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = allShortestPaths((a)-[*..${clampHops(maxHops)}]-(b))
RETURN nodes(path) AS ns, relationships(path) AS rs
LIMIT $limit
`;

/**
 * Hub-aware variant of allShortestPaths. Sorts paths by the summed
 * log(1 + degree) of intermediate nodes so paths through high-degree hubs
 * fall to the bottom. This is stage 1 of the elegant hub solution.
 */
export const Q_HUB_AWARE_SHORTEST_PATHS = (maxHops = 6) => `
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = allShortestPaths((a)-[*..${clampHops(maxHops)}]-(b))
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
`;

export const Q_FULL_SUBGRAPH = (maxHops = 3) => `
MATCH (a {source_id: $tag1})
MATCH (b {source_id: $tag2})
WHERE a <> b
MATCH path = (a)-[*1..${clampHops(maxHops)}]-(b)
RETURN nodes(path) AS ns, relationships(path) AS rs
LIMIT $limit
`;

export const QUERIES = Object.freeze({
  Q_DISTINCT_SOURCE_IDS,
  Q_NODES_BY_SOURCE_ID,
  Q_SHORTEST_PATH,
  Q_ALL_SHORTEST_PATHS,
  Q_HUB_AWARE_SHORTEST_PATHS,
  Q_FULL_SUBGRAPH,
});
