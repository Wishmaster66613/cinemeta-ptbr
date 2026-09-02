const express = require("express");
const NodeCache = require("node-cache");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const CINEMETA_BASE = (process.env.CINEMETA_BASE || "https://v3-cinemeta.strem.io").replace(/\/$/, "");
const TRANSLATE_URL = process.env.TRANSLATE_URL || "https://translate.googleapis.com/translate_a/single";

const metaCache = new NodeCache({ stdTTL: 60 * 60 * 12, checkperiod: 60 * 30, useClones: false });
const catalogCache = new NodeCache({ stdTTL: 60 * 10, checkperiod: 60 * 5, useClones: false });
const tmdbCache = new NodeCache({ stdTTL: 60 * 60 * 24, checkperiod: 60 * 60, useClones: false });

function cleanYear(value) {
  const m = String(value || "").match(/^(19|20)\d{2}$/);
  return m ? m[0] : null;
}

function extrasFromRequest(req) {
  // Supports Stremio's standard path style:
  // /catalog/movie/popular/genre=Action&search=foo&skip=0
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

function addQuery(url, key, value) {
  if (value === undefined || value === null || value === "") return url;
  url.searchParams.set(key, value);
  return url;
}

async function getJson(url, options = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Cinemeta-PTBR/1.2.0" },
    ...options
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function translateText(text) {
  if (!text || !text.trim()) return text;
  const key = `tr:${text}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  // First try TMDB's localized metadata elsewhere; this is the final fallback.
  const u = new URL(TRANSLATE_URL);
  u.searchParams.set("client", "gtx");
  u.searchParams.set("sl", "auto");
  u.searchParams.set("tl", "pt-BR");
  u.searchParams.set("dt", "t");
  u.searchParams.set("q", text);

  try {
    const data = await getJson(u.toString());
    const translated = Array.isArray(data?.[0])
      ? data[0].map(x => x?.[0] || "").join("")
      : "";
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
    // Prefer explicitly Portuguese posters. Null-language posters are only fallback.
    const poster = pt[0] || (data.posters || []).find(p => p.iso_639_1 === null) || null;
    const url = poster?.file_path ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${poster.file_path}` : null;
    tmdbCache.set(key, url || false);
    return url;
  } catch (_) {
    tmdbCache.set(key, false);
    return null;
  }
}

function preserveAndPatchMeta(meta, translatedDescription, poster) {
  const out = { ...meta };
  if (translatedDescription) out.description = translatedDescription;
  if (poster) out.poster = poster;
  return out;
}

async function enrichMeta(type, imdbId, incomingMeta = null) {
  const key = `meta:${type}:${imdbId}`;
  const cached = metaCache.get(key);
  if (cached) return cached;

  let meta = incomingMeta;
  try {
    meta = await getJson(`${CINEMETA_BASE}/meta/${type}/${encodeURIComponent(imdbId)}.json`);
  } catch (_) {}

  if (!meta) return null;

  let description = meta.description || "";
  // Cinemeta itself may already contain PT-BR text. TMDB is preferred when available.
  const tmdb = await tmdbFind(imdbId);
  if (tmdb?.overview?.trim()) {
    description = tmdb.overview.trim();
  } else if (description.trim()) {
    description = await translateText(description);
  }

  const poster = await tmdbPoster(imdbId, type);
  const result = preserveAndPatchMeta(meta, description, poster);
  metaCache.set(key, result);
  return result;
}

async function proxyCatalog(type, id, extras) {
  const year = cleanYear(extras.year);
  const search = extras.search || "";
  const genre = extras.genre || "";
  const skip = Math.max(0, Number.parseInt(extras.skip || "0", 10) || 0);

  const cacheKey = `cat:${type}:${id}:${JSON.stringify({year, search, genre, skip})}`;
  const cached = catalogCache.get(cacheKey);
  if (cached) return cached;

  // For ordinary requests, proxy Cinemeta directly.
  // For year filtering, request successive Cinemeta pages and filter locally.
  const collected = [];
  let sourceSkip = year ? 0 : skip;
  let attempts = 0;
  const pageSize = 100;

  while (attempts < (year ? 8 : 1) && collected.length < 100) {
    const u = new URL(`${CINEMETA_BASE}/catalog/${type}/${id}.json`);
    if (search) u.pathname += `/search=${encodeURIComponent(search)}`;
    // Cinemeta supports skip in its catalog path.
    u.searchParams.set("skip", String(sourceSkip));

    let data;
    try {
      data = await getJson(u.toString());
    } catch (_) {
      data = { metas: [] };
    }

    let metas = Array.isArray(data.metas) ? data.metas : [];
    if (!metas.length) break;

    if (genre) {
      metas = metas.filter(m => Array.isArray(m.genres) && m.genres.some(g => g.toLowerCase() === genre.toLowerCase()));
    }

    if (year) {
      metas = metas.filter(m => {
        const release = String(m.releaseInfo || m.year || "");
        return release.includes(year);
      });
    }

    collected.push(...metas);
    sourceSkip += pageSize;
    attempts++;
    if (data.metas.length < pageSize) break;
  }

  const result = { metas: collected.slice(0, 100) };
  catalogCache.set(cacheKey, result);
  return result;
}

const manifest = {
  id: "com.cesar.cinemeta.ptbr",
  version: "1.2.0",
  name: "Cinemeta PT-BR",
  description: "Cinemeta com sinopses em Português do Brasil, preferência por pôsteres PT-BR e filtro Ano.",
  idProperty: "imdb_id",
  contactEmail: "replace-me@example.com",
  types: ["movie", "series"],
  resources: ["catalog", "meta"],
  catalogs: [
    {
      type: "movie",
      id: "popular",
      name: "Popular",
      extra: [
        { name: "genre", isRequired: false },
        { name: "year", isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "movie",
      id: "featured",
      name: "Featured",
      extra: [
        { name: "genre", isRequired: false },
        { name: "year", isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "movie",
      id: "new",
      name: "New",
      extra: [
        { name: "genre", isRequired: false },
        { name: "year", isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "series",
      id: "popular",
      name: "Popular",
      extra: [
        { name: "genre", isRequired: false },
        { name: "year", isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "series",
      id: "featured",
      name: "Featured",
      extra: [
        { name: "genre", isRequired: false },
        { name: "year", isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    },
    {
      type: "series",
      id: "new",
      name: "New",
      extra: [
        { name: "genre", isRequired: false },
        { name: "year", isRequired: false },
        { name: "search", isRequired: false },
        { name: "skip", isRequired: false }
      ]
    }
  ]
};

app.get("/", (_, res) => res.json({
  name: manifest.name,
  version: manifest.version,
  status: "ok",
  manifest: "/manifest.json"
}));

app.get("/manifest.json", (_, res) => res.json(manifest));

app.get("/meta/:type/:id.json", async (req, res) => {
  try {
    const { type, id } = req.params;
    if (!["movie", "series"].includes(type)) return res.status(404).json({ error: "type" });
    const meta = await enrichMeta(type, id);
    if (!meta) return res.json({ meta: null });
    res.json({ meta });
  } catch (e) {
    res.status(500).json({ error: "metadata_error" });
  }
});

app.get("/catalog/:type/:id.json", async (req, res) => {
  try {
    const data = await proxyCatalog(req.params.type, req.params.id, req.query || {});
    res.json(data);
  } catch (e) {
    res.status(500).json({ metas: [], error: "catalog_error" });
  }
});

app.get("/catalog/:type/:id/:extras.json", async (req, res) => {
  try {
    const extras = extrasFromRequest(req);
    const data = await proxyCatalog(req.params.type, req.params.id, extras);
    res.json(data);
  } catch (e) {
    res.status(500).json({ metas: [], error: "catalog_error" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Cinemeta PT-BR listening on 0.0.0.0:${PORT}`);
});
