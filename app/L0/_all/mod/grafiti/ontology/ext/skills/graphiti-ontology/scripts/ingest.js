/**
 * scripts/ingest.js
 *
 * Source-triplet tagging helpers for Graphiti episodes.
 *
 * The same tag stamped here at write time is what the ontology widget uses
 * as a query key at read time. This file is the bridge between the two.
 */

export const TAG_KEYS = Object.freeze({
  SOURCE_ID: "source_id",
  SUBJECT:   "triplet_subject",
  PREDICATE: "triplet_predicate",
  OBJECT:    "triplet_object",
});

/**
 * Build the metadata block to attach to a Graphiti add_episode call.
 *
 * @param {{subject:string, predicate:string, object:string, sourceId:string}} t
 * @returns {object} payload suitable for spreading into episode metadata
 */
export function buildEpisodeTag(t) {
  if (!t || typeof t !== "object") {
    throw new Error("buildEpisodeTag requires a triplet object");
  }
  if (!t.sourceId) throw new Error("source_id is required");
  if (!t.subject || !t.predicate || !t.object) {
    throw new Error("triplet (subject, predicate, object) is required");
  }
  return {
    [TAG_KEYS.SOURCE_ID]: String(t.sourceId).trim(),
    [TAG_KEYS.SUBJECT]:   String(t.subject).trim(),
    [TAG_KEYS.PREDICATE]: String(t.predicate).trim(),
    [TAG_KEYS.OBJECT]:    String(t.object).trim(),
  };
}

/**
 * Backfill Cypher to push episode-level tags onto derived entities and edges.
 * Run once per ingest batch if the Graphiti version does not already
 * propagate episode metadata down to the extracted nodes.
 *
 * Parameters: $episode_uuid, $source_id, $subject, $predicate, $object
 */
export const BACKFILL_CYPHER = `
MATCH (e:Episodic {uuid: $episode_uuid})-[:MENTIONS|HAS_FACT*1..2]->(n)
SET n.source_id        = coalesce(n.source_id,        $source_id),
    n.triplet_subject  = coalesce(n.triplet_subject,  $subject),
    n.triplet_predicate= coalesce(n.triplet_predicate,$predicate),
    n.triplet_object   = coalesce(n.triplet_object,   $object)
WITH e
MATCH (e)-[:MENTIONS|HAS_FACT*1..2]->()-[r]-()
SET r.source_id = coalesce(r.source_id, $source_id)
`;

/**
 * Convenience: build the full backfill parameter object from a triplet.
 */
export function buildBackfillParams(episodeUuid, triplet) {
  if (!episodeUuid) throw new Error("episode_uuid is required");
  const tag = buildEpisodeTag(triplet);
  return {
    episode_uuid: String(episodeUuid).trim(),
    source_id:    tag[TAG_KEYS.SOURCE_ID],
    subject:      tag[TAG_KEYS.SUBJECT],
    predicate:    tag[TAG_KEYS.PREDICATE],
    object:       tag[TAG_KEYS.OBJECT],
  };
}
