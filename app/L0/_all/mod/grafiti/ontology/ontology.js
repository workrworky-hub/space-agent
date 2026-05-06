/**
 * Live ontology widget for Space Agent.
 *
 * Imports the canonical query and rendering helpers from the paired skill
 * so the live widget and the standalone reference are one implementation.
 */

import {
  cypherHttp,
  fetchSourceTags,
  fetchOntologyPaths,
  mergePathsToGraph,
  detectHubs,
  toVisDataset,
  buildPalette,
} from "/mod/grafiti/ontology/ext/skills/graphiti-ontology/scripts/widget.js";

const STORAGE_KEY = "grafiti.ontology.config";
const SESSION_PASSWORD_KEY = "grafiti.ontology.password";
const GRAPHITI_API_KEY = "grafiti.api.base";
const DEFAULT_GRAPHITI_API = "http://localhost:8000";

function graphitiApiBase() {
  try {
    const v = localStorage.getItem(GRAPHITI_API_KEY);
    if (v) return v.replace(/\/$/, "");
  } catch (_) { /* ignore */ }
  return DEFAULT_GRAPHITI_API;
}

async function fetchGraphitiNeo4jConfig() {
  const base = graphitiApiBase();
  const res = await fetch(`${base}/neo4j/config`, { credentials: "omit" });
  if (!res.ok) throw new Error(`Graphiti /neo4j/config returned HTTP ${res.status}`);
  return res.json();
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return {};
}

function savePersisted(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        httpUrl: state.config.httpUrl,
        username: state.config.username,
        database: state.config.database,
        selected: [...state.selected],
        maxHops: state.maxHops,
        layout: state.layout,
        hideHubs: state.hideHubs,
      })
    );
  } catch (_) { /* ignore */ }
}

function loadSessionPassword() {
  try { return sessionStorage.getItem(SESSION_PASSWORD_KEY) || ""; }
  catch (_) { return ""; }
}

function saveSessionPassword(value) {
  try {
    if (value) sessionStorage.setItem(SESSION_PASSWORD_KEY, value);
    else sessionStorage.removeItem(SESSION_PASSWORD_KEY);
  } catch (_) { /* ignore */ }
}

function buildStoreModel() {
  const persisted = loadPersisted();
  return {
    config: {
      httpUrl:  persisted.httpUrl  || "http://localhost:7474",
      username: persisted.username || "neo4j",
      password: loadSessionPassword(),
      database: persisted.database || "neo4j",
    },
    connected: false,
    busy: false,
    error: "",
    statusMessage: "",
    tags: [],
    selected: new Set(persisted.selected || []),
    maxHops: persisted.maxHops || 4,
    layout: persisted.layout || "physics",
    hideHubs: persisted.hideHubs ?? true,
    palette: {},
    graph: { nodes: [], edges: [] },
    hubs: new Set(),
    selectedNode: null,
    _network: null,
    _refs: null,

    async init() {
      // Try to auto-connect using Graphiti's already-configured Neo4j.
      // Falls back silently to manual connect form on any error.
      try {
        const cfg = await fetchGraphitiNeo4jConfig();
        if (cfg && (cfg.http_url || cfg.uri)) {
          this.config.httpUrl = cfg.http_url || this.config.httpUrl;
          this.config.username = cfg.user || this.config.username;
          this.config.password = cfg.password || this.config.password;
          this.config.database = cfg.database || this.config.database;
          this.statusMessage = "Auto-connecting to Graphiti's Neo4j…";
          await this.connect();
        }
      } catch (err) {
        this.statusMessage = "";
        // leave error empty — user can fill in connection card manually
      }
    },

    mount(refs) {
      this._refs = refs;
      // Wait for the canvas to exist when the user is connected.
    },

    async connect() {
      this.error = "";
      this.busy = true;
      try {
        await cypherHttp(this.config, "RETURN 1 AS ok");
        saveSessionPassword(this.config.password);
        this.connected = true;
        await this.loadTags();
        savePersisted(this);
        this.statusMessage = `Connected to ${this.config.httpUrl}`;
        // Defer one frame so x-if mounts the canvas div before we attach.
        requestAnimationFrame(() => this.run());
      } catch (err) {
        this.connected = false;
        this.error = err?.message || String(err);
      } finally {
        this.busy = false;
      }
    },

    disconnect() {
      this.connected = false;
      this.busy = false;
      this.error = "";
      this.statusMessage = "";
      this.config.password = "";
      saveSessionPassword("");
      this.tags = [];
      this.selected = new Set();
      this.graph = { nodes: [], edges: [] };
      this.hubs = new Set();
      this.selectedNode = null;
      if (this._network) {
        try { this._network.destroy(); } catch (_) {}
        this._network = null;
      }
    },

    async loadTags() {
      const tags = await fetchSourceTags(this.config);
      this.tags = tags;
      this.palette = buildPalette(tags.map((t) => t.source_id));
      // First-run default: select all tags.
      if (this.selected.size === 0 && tags.length) {
        this.selected = new Set(tags.map((t) => t.source_id));
      }
    },

    toggleTag(sourceId) {
      if (this.selected.has(sourceId)) this.selected.delete(sourceId);
      else this.selected.add(sourceId);
      this.selected = new Set(this.selected);
      savePersisted(this);
    },

    toggleHideHubs() {
      this.hideHubs = !this.hideHubs;
      savePersisted(this);
      this.applyDataset();
    },

    async run() {
      if (!this.connected) return;
      if (this.selected.size < 2) {
        this.error = "Select at least two source tags.";
        return;
      }
      this.error = "";
      this.busy = true;
      this.statusMessage = "Running pairwise shortest-path…";
      try {
        const tagList = [...this.selected];
        const paths = await fetchOntologyPaths(this.config, tagList, {
          maxHops: this.maxHops,
          limitPerPair: 3,
        });
        const errors = paths.filter((p) => p.error).map((p) => p.error);
        const valid = paths.filter((p) => !p.error);
        this.graph = mergePathsToGraph(valid);
        this.hubs = detectHubs(valid, tagList);
        savePersisted(this);
        this.statusMessage =
          `Loaded ${this.graph.nodes.length} nodes, ${this.graph.edges.length} edges. ` +
          `${this.hubs.size} hubs flagged.` +
          (errors.length ? ` ${errors.length} pair queries errored.` : "");
        this.applyDataset();
      } catch (err) {
        this.error = err?.message || String(err);
      } finally {
        this.busy = false;
      }
    },

    applyDataset() {
      const container = this._refs?.canvas;
      if (!container || !globalThis.vis) return;
      const dataset = toVisDataset(this.graph, {
        hubs: this.hubs,
        tagPalette: this.palette,
        hideHubs: this.hideHubs,
      });
      const data = {
        nodes: new globalThis.vis.DataSet(dataset.nodes),
        edges: new globalThis.vis.DataSet(dataset.edges),
      };
      const options = {
        layout: this.layout === "hierarchical"
          ? { hierarchical: { direction: "UD", sortMethod: "directed", nodeSpacing: 140 } }
          : { hierarchical: false },
        physics: this.layout === "physics"
          ? { solver: "forceAtlas2Based", stabilization: { iterations: 250 } }
          : false,
        interaction: { hover: true, tooltipDelay: 120, navigationButtons: false, zoomView: true },
        nodes: { borderWidth: 1.4, shadow: false },
        edges: { font: { color: "#8e9bb2", size: 10, strokeWidth: 0 }, smooth: { type: "dynamic" } },
        height: "100%",
        width: "100%",
        autoResize: true,
      };
      if (this._network) {
        try { this._network.destroy(); } catch (_) {}
      }
      this._network = new globalThis.vis.Network(container, data, options);
      this._network.on("selectNode", (params) => {
        const id = params.nodes?.[0];
        if (!id) { this.selectedNode = null; return; }
        const n = this.graph.nodes.find((x) => (x.uuid || x.id) === id);
        if (!n) { this.selectedNode = null; return; }
        const connections = this.graph.edges.filter(
          (e) => e.from === id || e.to === id
        ).length;
        this.selectedNode = { ...n, connections };
      });
      this._network.on("deselectNode", () => { this.selectedNode = null; });
    },

    fitView() {
      if (this._network) this._network.fit({ animation: { duration: 400 } });
    },
  };
}

function registerStore() {
  if (!globalThis.Alpine) return false;
  if (globalThis.Alpine.store("ontology")) return true;
  globalThis.Alpine.store("ontology", buildStoreModel());
  return true;
}

if (!registerStore()) {
  document.addEventListener("alpine:init", registerStore, { once: true });
}
