const express = require("express");
const NodeCache = require("node-cache");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

// Stremio (web e, em vários casos, desktop) exige CORS liberado para
// carregar manifest.json, catalog e meta. Sem isso o cliente mostra
// "Failed to fetch" mesmo com o servidor no ar.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 10000);
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const TRANSLATE_URL = process.env.TRANSLATE_URL || "https://translate.googleapis.com/translate_a/single";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // opcional: se definido, protege /admin e /api/sources
const ADDONS_FILE = path.join(__dirname, "addons.json");
const SOURCE_FETCH_TIMEOUT_MS = 8000;
const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 min

const metaCache = new NodeCache({ stdTTL: 60 * 60 * 12, checkperiod: 60 * 30, useClones: false });
const catalogCache = new NodeCache({ stdTTL: 60 * 10, checkperiod: 60 * 5, useClones: false });
const tmdbCache = new NodeCache({ stdTTL: 60 * 60 * 24, checkperiod: 60 * 60, useClones: false });
const idSourceCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 60 * 30, useClones: false });

// ---------------------------------------------------------------------------
// Config das fontes (addons.json), editável via /admin
// ---------------------------------------------------------------------------

function loadAddonsConfig() {
  try {
    const raw = fs.readFileSync(ADDONS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveAddonsConfig(list) {
  fs.writeFileSync(ADDONS_FILE, JSON.stringify(list, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------

async function getJson(url, timeoutMs = SOURCE_FETCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Agregador-PTBR/2.0" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function cleanYear(value) {
  const m = String(value || "").match(/^(19|20)\d{2}$/);
  return m ? m[0] : null;
}

function extractYear(meta) {
  const m = String(meta.releaseInfo || meta.year || "").match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

function extrasFromRequest(req) {
  const raw = req.params.extras || "";
  const out = {};
  if (!raw) return out;
  for (const part of raw.split("&")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = decodeURIComponent(part.slice(0, i));
    const v = decodeURIComponent(part.slice(i + 1));
    out[k] = v;
  }
  return out;
}

function buildExtraSegment(pairs) {
  if (!pairs.length) return "";
  return "/" + pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

// ---------------------------------------------------------------------------
// TMDB / tradução (mesma lógica da v1, reaproveitada)
// ---------------------------------------------------------------------------

async function translateText(text) {
  if (!text || !text.trim()) return text;
  const key = `tr:${text}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  const u = new URL(TRANSLATE_URL);
  u.searchParams.set("client", "gtx");
  u.searchParams.set("sl", "auto");
  u.searchParams.set("tl", "pt-BR");
  u.searchParams.set("dt", "t");
  u.searchParams.set("q", text);

  try {
    const data = await getJson(u.toString());
    const translated = Array.isArray(data?.[0]) ? data[0].map(x => x?.[0] || "").join("") : "";
    if (translated) {
      metaCache.set(key, translated);
      return translated;
    }
  } catch (_) {}
  return text;
}

async function tmdbFind(imdbId) {
  if (!TMDB_API_KEY) return null;
  const key = `find:${imdbId}`;
  const cached = tmdbCache.get(key);
  if (cached !== undefined) return cached;

  const u = new URL(`https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}`);
  u.searchParams.set("api_key", TMDB_API_KEY);
  u.searchParams.set("external_source", "imdb_id");
  u.searchParams.set("language", "pt-BR");
  try {
    const data = await getJson(u.toString());
    const found = data.movie_results?.[0] || data.tv_results?.[0] || null;
    tmdbCache.set(key, found || false);
    return found;
  } catch (_) {
    tmdbCache.set(key, false);
    return null;
  }
}

async function tmdbPoster(imdbId, type) {
  if (!TMDB_API_KEY) return null;
  const key = `poster:${type}:${imdbId}`;
  const cached = tmdbCache.get(key);
  if (cached !== undefined) return cached || null;

  const found = await tmdbFind(imdbId);
  if (!found?.id) {
    tmdbCache.set(key, false);
    return null;
  }

  const endpoint = type === "series" ? "tv" : "movie";
  const u = new URL(`https://api.themoviedb.org/3/${endpoint}/${found.id}/images`);
  u.searchParams.set("api_key", TMDB_API_KEY);
  u.searchParams.set("include_image_language", "pt,null");

  try {
    const data = await getJson(u.toString());
    const pt = (data.posters || []).filter(p => p.iso_639_1 === "pt");
    const poster = pt[0] || (data.posters || []).find(p => p.iso_639_1 === null) || null;
    const url = poster?.file_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster.file_path}` : null;
    tmdbCache.set(key, url || false);
    return url;
  } catch (_) {
    tmdbCache.set(key, false);
    return null;
  }
}

async function enrichMetaFull(type, imdbId) {
  const key = `meta:${type}:${imdbId}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  let meta = null;
  try {
    meta = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(imdbId)}.json`).then(d => d.meta);
  } catch (_) {}
  if (!meta) return null;

  let description = meta.description || "";
  const tmdb = await tmdbFind(imdbId);
  if (tmdb?.overview?.trim()) {
    description = tmdb.overview.trim();
  } else if (description.trim()) {
    description = await translateText(description);
  }
  const poster = await tmdbPoster(imdbId, type);

  const result = { ...meta };
  if (description) result.description = description;
  if (poster) result.poster = poster;
  metaCache.set(key, result);
  return result;
}

async function withConcurrency(items, limit, worker) {
  const queue = [...items];
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await worker(item); } catch (_) {}
    }
  });
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Registro de fontes (addons agregados)
// ---------------------------------------------------------------------------

let sourceRegistry = []; // [{ name, url, base, query, manifest }]
let lastRefreshAt = null;
let lastRefreshErrors = [];

function parseSourceUrl(url) {
  const u = new URL(url);
  const query = u.search || "";
  const base = `${u.origin}${u.pathname.replace(/\/manifest\.json$/, "")}`;
  return { base, query };
}

function resourceNames(manifest) {
  return (manifest.resources || []).map(r => (typeof r === "string" ? r : r.name));
}

function resourceSupportsType(manifest, resourceName, type) {
  const entry = (manifest.resources || []).find(r => (typeof r === "string" ? r === resourceName : r.name === resourceName));
  if (!entry) return false;
  if (typeof entry === "string") return (manifest.types || []).includes(type);
  const types = entry.types || manifest.types || [];
  return types.includes(type);
}

function catalogSupportsExtra(catalogDef, name) {
  if (Array.isArray(catalogDef.extra) && catalogDef.extra.some(e => e.name === name)) return true;
  if (Array.isArray(catalogDef.extraSupported) && catalogDef.extraSupported.includes(name)) return true;
  return false;
}

async function resolveSource(entry) {
  const { base, query } = parseSourceUrl(entry.url);
  const manifest = await getJson(entry.url, SOURCE_FETCH_TIMEOUT_MS);
  return { name: entry.name || manifest.name || base, url: entry.url, base, query, manifest };
}

async function refreshSources() {
  const cfg = loadAddonsConfig();
  const enabled = cfg.filter(e => e.enabled !== false);
  const errors = [];
  const resolved = await Promise.all(enabled.map(async entry => {
    try {
      return await resolveSource(entry);
    } catch (err) {
      errors.push({ url: entry.url, error: String(err.message || err) });
      return null;
    }
  }));
  sourceRegistry = resolved.filter(Boolean);
  lastRefreshAt = new Date().toISOString();
  lastRefreshErrors = errors;
  console.log(`[sources] ${sourceRegistry.length}/${enabled.length} fontes OK`, errors.length ? `(${errors.length} falharam)` : "");
}

function sourcesForCatalogType(type) {
  return sourceRegistry.filter(src => {
    if (!resourceSupportsType(src.manifest, "catalog", type)) return false;
    return Array.isArray(src.manifest.catalogs) && src.manifest.catalogs.some(c => c.type === type);
  });
}

function availableTypes() {
  const types = new Set();
  for (const src of sourceRegistry) {
    if (!resourceNames(src.manifest).includes("catalog")) continue;
    for (const c of src.manifest.catalogs || []) types.add(c.type);
  }
  return [...types];
}

function genreOptionsForType(type) {
  const set = new Set();
  for (const src of sourceRegistry) {
    for (const c of src.manifest.catalogs || []) {
      if (c.type !== type) continue;
      const extra = Array.isArray(c.extra) ? c.extra.find(e => e.name === "genre") : null;
      if (extra?.options) extra.options.forEach(g => set.add(g));
      if (Array.isArray(c.genres)) c.genres.forEach(g => set.add(g));
    }
  }
  return [...set].sort();
}

function buildManifest() {
  const types = availableTypes();
  const catalogs = types.map(type => ({
    type,
    id: "agregado",
    name: "Agregado PT-BR",
    extra: [
      { name: "genre", isRequired: false, options: genreOptionsForType(type) || undefined },
      { name: "year", isRequired: false },
      { name: "search", isRequired: false },
      { name: "sort", isRequired: false, options: ["Novidades", "Popularidade"] },
      { name: "skip", isRequired: false }
    ]
  }));

  return {
    id: "com.cesar.agregador.ptbr",
    version: "2.0.0",
    name: "Agregador PT-BR",
    description: "Agrega catálogos de vários addons, traduz sinopses e prefere pôsteres em PT-BR. Filtros: tipo, ano, novidades/popularidade e gênero (opcionais e cumulativos).",
    idProperty: "imdb_id",
    contactEmail: "replace-me@example.com",
    types,
    resources: ["catalog", "meta"],
    catalogs,
    behaviorHints: { configurable: true, configurationRequired: false }
  };
}

// ---------------------------------------------------------------------------
// Agregação de catálogo
// ---------------------------------------------------------------------------

async function fetchSourceCatalog(src, catalogDef, extras) {
  const pairs = [];
  if (extras.search && catalogSupportsExtra(catalogDef, "search")) pairs.push(["search", extras.search]);
  if (extras.genre && catalogSupportsExtra(catalogDef, "genre")) pairs.push(["genre", extras.genre]);

  const url = `${src.base}/catalog/${catalogDef.type}/${encodeURIComponent(catalogDef.id)}${buildExtraSegment(pairs)}.json${src.query}`;
  try {
    const data = await getJson(url);
    return { source: src, metas: Array.isArray(data.metas) ? data.metas : [] };
  } catch (err) {
    return { source: src, metas: [], error: String(err.message || err) };
  }
}

function mergeRoundRobin(resultSets) {
  const merged = [];
  const seen = new Set();
  let index = 0;
  let added = true;
  while (added) {
    added = false;
    for (const set of resultSets) {
      const item = set.metas[index];
      if (!item) continue;
      added = true;
      const key = item.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      idSourceCache.set(key, set.source.base + set.source.query);
      merged.push(item);
    }
    index++;
  }
  return merged;
}

async function aggregateCatalog(type, extras) {
  const year = cleanYear(extras.year);
  const skip = Math.max(0, Number.parseInt(extras.skip || "0", 10) || 0);
  const sort = extras.sort || "";

  const cacheKey = `agg:${type}:${JSON.stringify({ ...extras, skip: 0 })}`;
  let merged = catalogCache.get(cacheKey);

  if (!merged) {
    const sources = sourcesForCatalogType(type);
    const jobs = sources.flatMap(src =>
      (src.manifest.catalogs || [])
        .filter(c => c.type === type)
        .map(c => fetchSourceCatalog(src, c, extras))
    );
    const results = await Promise.all(jobs);
    merged = mergeRoundRobin(results.filter(r => r.metas.length));
    catalogCache.set(cacheKey, merged);
  }

  let filtered = merged;
  if (year) filtered = filtered.filter(m => String(m.releaseInfo || m.year || "").includes(year));
  if (extras.genre) {
    const g = extras.genre.toLowerCase();
    filtered = filtered.filter(m => Array.isArray(m.genres) && m.genres.some(x => x.toLowerCase() === g));
  }
  if (sort === "Novidades") {
    filtered = [...filtered].sort((a, b) => (extractYear(b) || 0) - (extractYear(a) || 0));
  }
  // "Popularidade" (ou sem sort): mantém a ordem de mescla round-robin,
  // que já intercala pela ordem de cada fonte (aproximação de popularidade).

  const page = filtered.slice(skip, skip + 100);

  // Enriquecimento de pôster PT-BR só na página exibida (mantém a resposta rápida).
  await withConcurrency(page.filter(m => /^tt\d+$/.test(m.id)), 10, async item => {
    const poster = await tmdbPoster(item.id, type);
    if (poster) item.poster = poster;
  });

  return { metas: page };
}

// ---------------------------------------------------------------------------
// Rotas do addon
// ---------------------------------------------------------------------------

app.get("/", (_, res) => res.json({
  name: "Agregador PT-BR",
  status: "ok",
  manifest: "/manifest.json",
  admin: "/admin",
  sources: sourceRegistry.length,
  lastRefreshAt
}));

app.get("/manifest.json", (_, res) => res.json(buildManifest()));

app.get("/catalog/:type/:id.json", async (req, res) => {
  try {
    const data = await aggregateCatalog(req.params.type, req.query || {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ metas: [], error: "catalog_error" });
  }
});

app.get("/catalog/:type/:id/:extras.json", async (req, res) => {
  try {
    const extras = extrasFromRequest(req);
    const data = await aggregateCatalog(req.params.type, extras);
    res.json(data);
  } catch (e) {
    res.status(500).json({ metas: [], error: "catalog_error" });
  }
});

app.get("/meta/:type/:id.json", async (req, res) => {
  const { type, id } = req.params;
  try {
    if (/^tt\d+$/.test(id)) {
      const meta = await enrichMetaFull(type, id);
      if (meta) return res.json({ meta });
    }

    // Fallback: proxya a fonte original que forneceu esse id no catálogo mesclado.
    const originBase = idSourceCache.get(id);
    if (originBase) {
      try {
        const data = await getJson(`${originBase}/meta/${type}/${encodeURIComponent(id)}.json`);
        if (data?.meta) return res.json(data);
      } catch (_) {}
    }

    // Último recurso: tenta as primeiras fontes que suportam meta para esse tipo.
    const candidates = sourceRegistry.filter(s => resourceSupportsType(s.manifest, "meta", type)).slice(0, 5);
    for (const src of candidates) {
      try {
        const data = await getJson(`${src.base}/meta/${type}/${encodeURIComponent(id)}.json${src.query}`);
        if (data?.meta) return res.json(data);
      } catch (_) {}
    }

    res.json({ meta: null });
  } catch (e) {
    res.status(500).json({ meta: null, error: "metadata_error" });
  }
});

// ---------------------------------------------------------------------------
// Administração das fontes: /admin (UI) e /api/sources (dados)
// ---------------------------------------------------------------------------

function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN) return next();
  const token = req.query.token || req.headers["x-admin-token"];
  if (token === ADMIN_TOKEN) return next();
  res.status(401).json({ error: "unauthorized" });
}

app.get("/api/sources", requireAdminToken, (req, res) => {
  const cfg = loadAddonsConfig();
  const status = cfg.map(entry => {
    const resolved = sourceRegistry.find(s => s.url === entry.url);
    const failed = lastRefreshErrors.find(e => e.url === entry.url);
    return {
      ...entry,
      status: resolved ? "ok" : (entry.enabled === false ? "disabled" : "error"),
      resolvedName: resolved?.manifest?.name || null,
      types: resolved?.manifest?.types || null,
      error: failed?.error || null
    };
  });
  res.json({ sources: status, lastRefreshAt, total: cfg.length, ok: sourceRegistry.length });
});

app.post("/api/sources", requireAdminToken, async (req, res) => {
  const { name, url, enabled } = req.body || {};
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "url invalida" });
  const cfg = loadAddonsConfig();
  if (cfg.some(e => e.url === url)) return res.status(409).json({ error: "url ja existe" });
  cfg.push({ name: name || url, url, enabled: enabled !== false });
  saveAddonsConfig(cfg);
  await refreshSources();
  res.json({ ok: true });
});

app.put("/api/sources/:index", requireAdminToken, async (req, res) => {
  const idx = Number(req.params.index);
  const cfg = loadAddonsConfig();
  if (!cfg[idx]) return res.status(404).json({ error: "nao encontrado" });
  const { name, url, enabled } = req.body || {};
  if (name !== undefined) cfg[idx].name = name;
  if (url !== undefined) cfg[idx].url = url;
  if (enabled !== undefined) cfg[idx].enabled = enabled;
  saveAddonsConfig(cfg);
  await refreshSources();
  res.json({ ok: true });
});

app.delete("/api/sources/:index", requireAdminToken, async (req, res) => {
  const idx = Number(req.params.index);
  const cfg = loadAddonsConfig();
  if (!cfg[idx]) return res.status(404).json({ error: "nao encontrado" });
  cfg.splice(idx, 1);
  saveAddonsConfig(cfg);
  await refreshSources();
  res.json({ ok: true });
});

app.post("/api/sources/refresh", requireAdminToken, async (_req, res) => {
  await refreshSources();
  res.json({ ok: true, sources: sourceRegistry.length, errors: lastRefreshErrors });
});

app.get("/api/sources/export", requireAdminToken, (_req, res) => {
  res.setHeader("Content-Disposition", "attachment; filename=addons.json");
  res.setHeader("Content-Type", "application/json");
  res.send(fs.readFileSync(ADDONS_FILE, "utf8"));
});

app.get("/admin", requireAdminToken, (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(ADMIN_HTML);
});

const ADMIN_HTML = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin - Agregador PT-BR</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f1117; color:#e8e8ec; margin:0; padding:24px; }
  h1 { font-size:20px; }
  .muted { color:#9a9aa5; font-size:13px; }
  table { width:100%; border-collapse: collapse; margin-top:16px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid #26262f; font-size:14px; vertical-align: top; }
  th { color:#9a9aa5; font-weight:600; }
  .ok { color:#5ee39b; }
  .error { color:#f27272; }
  .disabled { color:#9a9aa5; }
  input[type=text] { background:#1a1c25; border:1px solid #303240; color:#fff; padding:6px 8px; border-radius:6px; }
  button { background:#3a5bfd; color:#fff; border:none; padding:6px 12px; border-radius:6px; cursor:pointer; font-size:13px; }
  button.secondary { background:#26262f; }
  button.danger { background:#7a2a2a; }
  .row { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; align-items:center; }
  .row input { flex:1; min-width:180px; }
  .toolbar { display:flex; gap:8px; margin-top:16px; }
  code { background:#1a1c25; padding:1px 5px; border-radius:4px; }
</style>
</head>
<body>
  <h1>Fontes do Agregador PT-BR</h1>
  <p class="muted">Adicione, desative ou remova addons agregados. Alterações valem imediatamente nesta instância, mas <b>não persistem após um redeploy</b> — use "Baixar addons.json" e suba o arquivo no GitHub para tornar permanente.</p>

  <div class="toolbar">
    <button id="refreshBtn">Recarregar fontes agora</button>
    <button class="secondary" id="exportBtn">Baixar addons.json</button>
  </div>

  <div class="row">
    <input type="text" id="newName" placeholder="Nome (opcional)">
    <input type="text" id="newUrl" placeholder="https://.../manifest.json">
    <button id="addBtn">Adicionar</button>
  </div>

  <table>
    <thead>
      <tr><th>Nome</th><th>URL</th><th>Status</th><th>Tipos</th><th></th></tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>

<script>
const token = new URLSearchParams(location.search).get('token');
function withToken(url) { return token ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token) : url; }

async function load() {
  const r = await fetch(withToken('/api/sources'));
  const data = await r.json();
  const tbody = document.getElementById('rows');
  tbody.innerHTML = '';
  data.sources.forEach((s, i) => {
    const tr = document.createElement('tr');
    const statusClass = s.status === 'ok' ? 'ok' : (s.status === 'disabled' ? 'disabled' : 'error');
    tr.innerHTML = \`
      <td>\${s.name || ''}</td>
      <td style="max-width:320px; word-break:break-all;"><code>\${s.url}</code></td>
      <td class="\${statusClass}">\${s.status}\${s.error ? ' - ' + s.error : ''}</td>
      <td>\${(s.types || []).join(', ')}</td>
      <td>
        <button class="secondary" data-toggle="\${i}">\${s.enabled === false ? 'Ativar' : 'Desativar'}</button>
        <button class="danger" data-del="\${i}">Excluir</button>
      </td>\`;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-toggle]').forEach(btn => {
    btn.onclick = async () => {
      const idx = btn.getAttribute('data-toggle');
      const current = data.sources[idx];
      await fetch(withToken('/api/sources/' + idx), {
        method: 'PUT', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ enabled: current.enabled === false ? true : false })
      });
      load();
    };
  });
  tbody.querySelectorAll('[data-del]').forEach(btn => {
    btn.onclick = async () => {
      if (!confirm('Remover esta fonte?')) return;
      const idx = btn.getAttribute('data-del');
      await fetch(withToken('/api/sources/' + idx), { method: 'DELETE' });
      load();
    };
  });
}

document.getElementById('addBtn').onclick = async () => {
  const name = document.getElementById('newName').value.trim();
  const url = document.getElementById('newUrl').value.trim();
  if (!url) return alert('Informe a URL do manifest.json');
  const r = await fetch(withToken('/api/sources'), {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, url, enabled: true })
  });
  if (!r.ok) { const e = await r.json(); return alert('Erro: ' + (e.error || r.status)); }
  document.getElementById('newName').value = '';
  document.getElementById('newUrl').value = '';
  load();
};

document.getElementById('refreshBtn').onclick = async () => {
  await fetch(withToken('/api/sources/refresh'), { method: 'POST' });
  load();
};

document.getElementById('exportBtn').onclick = () => {
  window.location = withToken('/api/sources/export');
};

load();
</script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Agregador PT-BR listening on 0.0.0.0:${PORT}`);
  refreshSources();
  setInterval(refreshSources, REFRESH_INTERVAL_MS);
});
