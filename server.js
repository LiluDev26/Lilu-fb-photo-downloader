/**
 * FB Photo Downloader — serveur auto-hébergé (projet original, code écrit de zéro).
 *
 * Principe (2026) : Facebook expose publiquement ses médias aux robots via
 * lookaside.fbsbx.com/lookaside/crawler/media/?media_id=<fbid> (sans login)
 * et les pages publiques (User-Agent "facebookexternalhit") contiennent les
 * fbids / og:image. On récupère donc : URL → fbids → URLs imagen pleine
 * résolution (1920px mesurés lors des tests). Aucun compte Facebook requis.
 *
 * Usage personnel / éducatif. Contenu PUBLIC uniquement (aucune contournement
 * de confidentialité). Respectez les droits d'auteur des contenus téléchargés.
 */

"use strict";

const express = require("express");
const path = require("path");
const { Readable } = require("stream");

const app = express();
const PORT = process.env.PORT || 3812;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------
const UA_CRAWLER =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const UA_MOBILE =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36";

const CDN_HOST_RE = /(^|\.)(fbcdn\.net|cdninstagram\.com|fbsbx\.com)$/i;
const FB_HOST_RE = /(^|\.)(facebook\.com|fb\.watch)$/i;

const ALBUM_MAX = 80;
const ALBUM_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 20000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX = 200;

// ---------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------

/** Normalise une chaîne contenant des URLs échappées par Facebook. */
function normalizeFbEncoding(s) {
  return String(s)
    .replace(/\\u003[aA]/g, ":")
    .replace(/\\u002[fF]/g, "/")
    .replace(/\\\//g, "/")   // \/ → /
    .replace(/\\u002[5E]/g, (m) => (m.toLowerCase() === "\\u0025" ? "%" : "&"))
    .replace(/&amp;/g, "&");
}

/** Nettoie une URL extraite (protocole, double slashes dans le host). */
function cleanUrl(raw) {
  let u = normalizeFbEncoding(String(raw || "")).trim();
  if (u.startsWith("//")) u = "https:" + u;
  // protocole absent
  if (!/^https?:\/\//i.test(u) && /^(scontent|lookaside|static)/i.test(u)) u = "https://" + u;
  return u;
}

/** GET HTML avec timeout et UA choisi ; renvoie aussi l'URL finale. */
async function fetchPage(url, ua, referer) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "user-agent": ua,
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
      ...(referer ? { referer } : {}),
    },
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const cookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .join("; ")
      : res.headers.get("set-cookie") || "";
  return { html: await res.text(), finalUrl: res.url, status: res.status, cookies };
}

/** GET HTML avec timeout et UA choisi. */
async function fetchHtml(url, ua, referer) {
  return (await fetchPage(url, ua, referer)).html;
}

/** Vérifie qu'une adresse média renvoie bien une image ; renvoie l'URL ou null. */
async function resolveMediaUrl(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA_CRAWLER, referer: "https://www.facebook.com/" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const type = (res.headers.get("content-type") || "").toLowerCase();
    if (res.ok && type.startsWith("image/")) {
      // on libère le corps sans tout télécharger
      try { await res.body.cancel(); } catch {}
      return url;
    }
    try { await res.body.cancel(); } catch {}
    return null;
  } catch {
    return null;
  }
}

/** Idem mais renvoie le détail {content-type, length} pour diagnostique. */
async function photoFromLookup(mediaId) {
  const id = String(mediaId).replace(/\D/g, "");
  if (!id) return null;
  const url = `https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=${id}`;
  return resolveMediaUrl(url);
}

/** Exécute fn sur items avec limite de concurrence. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const size = Math.min(limit, items.length);
  const workers = Array.from({ length: size }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch {
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// Cache mémoire simple des résultats d'analyse
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { ts: Date.now(), data });
}

// ---------------------------------------------------------------------------
// Exctrations HTML
// ---------------------------------------------------------------------------

/** fbids / media_ids trouvés dans un HTML (dédupliqués, ordre d'apparition). */
function extractFbids(html, limit = 20) {
  const norm = normalizeFbEncoding(html);
  const out = [];
  const re = /(?:\?|&)fbid=(\d{6,20})|media_id=(\d{6,20})/g;
  let m;
  while ((m = re.exec(norm)) !== null) {
    const id = m[1] || m[2];
    if (id && !out.includes(id)) out.push(id);
    if (out.length >= limit * 3) break;
  }
  return out.slice(0, limit);
}

/**
 * Éléments d'album / galerie de post :
 *  P1 albums : "image":{"uri":"…media_id=ID"…},"viewer_image":{"height":H,"width":W}
 *  P2 galerie de post (set=pcb) : "__isMedia":"Photo","image":{"height":H,"width":W,"uri":"…media_id=ID"}
 * (vue robot, sans JS ; ordre = ordre d'apparition).
 */
function extractAlbumItems(html, limit = ALBUM_MAX) {
  const norm = normalizeFbEncoding(html);
  const out = [];
  const push = (id, h, w) => {
    if (!out.some((x) => x.id === id) && out.length < limit) {
      out.push({ id, h: h || null, w: w || null });
    }
  };
  // P1
  {
    const re =
      /lookaside\.fbsbx\.com\/lookaside\/crawler\/media\/\?media_id=(\d{6,20})[^{]*?\},"viewer_image":\{"height":(\d+),"width":(\d+)/g;
    let m;
    while ((m = re.exec(norm)) !== null) push(m[1], parseInt(m[2], 10), parseInt(m[3], 10));
  }
  // P2
  {
    const re =
      /"__isMedia":"Photo","image":\{"height":(\d+),"width":(\d+),"uri":"[^"]*media_id=(\d{6,20})"/g;
    let m;
    while ((m = re.exec(norm)) !== null) push(m[3], parseInt(m[1], 10), parseInt(m[2], 10));
  }
  return out;
}

/** Extrait l'id de la photo suivante/précédente dans la chaîne du mediaset. */
function extractAdjacentMediaId(html, dir) {
  const norm = normalizeFbEncoding(html);
  const re = new RegExp(
    `"${dir}Media":\\{"edges":\\[\\{"node":\\{[^}]*?"id":"(\\d{6,20})"`
  );
  const m = norm.match(re);
  return m ? m[1] : null;
}

/** Filtre : un média appartient à la galerie du post si son id a la même "époque". */
function sameIdEra(id, setId, window = 50_000_000_000) {
  const a = Number(id), b = Number(setId);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < window;
}

/**
 * Retrouve l'id de story d'un post même quand Facebook sert une variante de
 * page qui n'expose pas directement `set=pcb.<id>` (constaté ~1 fois sur 6).
 * Sources, par ordre de fiabilité :
 *  1. URL canonique / og:url : /<owner>/posts/<slug>/<storyId>/ ;
 *  2. paramètre story_fbid= (numérique uniquement, pas les pfbid…) ;
 *  3. JSON post_id / top_level_post_id.
 */
function extractStoryIdFromPage(html) {
  const norm = normalizeFbEncoding(html);
  const canonM =
    norm.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) ||
    norm.match(/<meta[^>]+property="og:url"[^>]+content="([^"]+)"/i);
  if (canonM) {
    const m = canonM[1].match(/\/(\d{10,20})\/?(?:$|[?#])/);
    if (m) return m[1];
  }
  let m = norm.match(/[?&]story_fbid=(\d{10,20})\b/);
  if (m) return m[1];
  m = norm.match(/"post_id":"(?:\d+_)?(\d{10,20})"/);
  if (m) return m[1];
  m = norm.match(/"top_level_post_id":"?(\d{10,20})"?/);
  if (m) return m[1];
  return null;
}

/** Toutes les méta og:image (indépendant de l'ordre attribut/valeur). */
function extractOgImages(html) {
  const out = [];
  const metaRe = /<meta\s+[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/og:image/i.test(tag)) continue;
    const c = tag.match(/content=["']([^"']+)["']/i);
    if (!c) continue;
    const url = cleanUrl(c[1]);
    if (/^https?:\/\//i.test(url) && !/secure_url/i.test(tag)) out.push(url);
  }
  return out;
}

/** URLs scontent (filet de sécurité) — HTML normalisé avant regex. */
function extractSccontentUrls(html) {
  const norm = normalizeFbEncoding(html);
  const re = /https?:\/\/[^"'\\\s<>]+scontent[^"'\\\s<>]+/g;
  const set = new Set();
  let m;
  while ((m = re.exec(norm)) !== null) set.add(m[0].split('"')[0]);
  return [...set];
}

/** Heuristique : préférer les URLs sans pattern de réduction (p320x320…). */
function pickLargest(urls) {
  if (!urls || !urls.length) return null;
  const score = (u) => {
    let s = 0;
    const sizeM = u.match(/\/(?:p|s)(\d{2,4})x(\d{2,4})\//);
    if (sizeM) s -= parseInt(sizeM[1], 10);
    if (/(960|1080|1440|1920|2048|_o\.jpe?g)/i.test(u)) s += 20;
    if (/lookaside|stp=/i.test(u)) s += 5;
    return s;
  };
  return urls.slice().sort((a, b) => score(b) - score(a))[0];
}

/** Construit un slug court du lien d'image. */
function slugOf(u) {
  const base = (u.split("?")[0].split("/").pop() || "").replace(/\.(jpe?g|png|webp)$/i, "");
  const clean = base.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24);
  return clean || "photo";
}

// ---------------------------------------------------------------------------
// Convertisseurs de fbids → URLs médias (vérifiés)
// ---------------------------------------------------------------------------

/** Vérifie lookaside pour une liste d'ids (ou {id,w,h}); renvoie [{id,url,w,h}] valides. */
async function idsToPhotos(ids, concurrency = ALBUM_CONCURRENCY) {
  const results = await mapLimit(ids, concurrency, async (item) => {
    const id = typeof item === "string" ? item : item.id;
    const url = await photoFromLookup(id);
    if (!url) return null;
    return {
      id,
      thumb: url,
      full: url,
      ...(typeof item === "object" && item.w ? { w: item.w, h: item.h } : {}),
    };
  });
  return results.filter(Boolean);
}

// alias de compatibilité
const fbidsToPhotos = idsToPhotos;

/** Classifie une URL Facebook. */
function classify(target) {
  const p = target.pathname + target.search;
  if (/fb\.watch/i.test(target.hostname)) return "video";
  if (/\/share\//i.test(p)) return "post"; // lien court de partage → post
  if (/fbid=\d+/i.test(p) || /\/photo(\.php)?/i.test(p)) return "photo";
  if (/media\/set\//i.test(p) || /set=a\./i.test(p)) return "album";
  if (/\/(posts|photos|permalink\.php|story\.php|groups\/[^/]+\/(?:posts|permalink))/i.test(p)) return "post";
  return "page";
}

/** Analyse d'une photo (fbid direct, ou la première fbid de la page). */
async function analyzePhoto(target) {
  const p = target.pathname + target.search;
  const directM = p.match(/fbid=(\d+)/i);

  let html = "";
  try {
    html = await fetchHtml(
      "https://www.facebook.com" + pathOfUrl(target.toString()),
      UA_CRAWLER
    );
  } catch (e) {
    if (!directM) throw withUnavailable(e);
  }

  // 1) fbid direct de l'URL → lookaside
  if (directM) {
    const photos = await fbidsToPhotos([directM[1]], 1);
    if (photos.length) return photos;
  }
  // 2) fbid trouvé dans la page
  const pageFbids = extractFbids(html, 5);
  const photos = await fbidsToPhotos(pageFbids, 4);
  if (photos.length) return photos.slice(0, 1);

  // 3) og:image puis scontent en dernier recours
  const og = extractOgImages(html);
  const ogPhoto = og.length ? og[0] : null;
  const sc = extractSccontentUrls(html);
  const large = pickLargest(sc) || ogPhoto;
  if (large) {
    return [{ id: slugOf(large), thumb: large, full: large }];
  }
  throw new Error(
    "Photo inaccessible : la publication n'est pas publique (ou le lien est invalide)."
  );
}

/** Complète une galerie de post (set=pcb) via la chaîne prevMedia du viewer. */
async function completePcbGallery(setId, baseItems, maxSteps = 20) {
  const items = [...baseItems];
  const seen = new Set(items.map((i) => i.id));
  if (!items.length) return items;

  const maxId = items.reduce((m, i) => (Number(i.id) > Number(m) ? i.id : m), items[0].id);
  let cur = maxId;

  for (let step = 0; step < maxSteps; step++) {
    let html;
    try {
      html = await fetchHtml(
        `https://www.facebook.com/photo/?fbid=${cur}&set=pcb.${setId}`,
        UA_CRAWLER
      );
    } catch {
      break;
    }
    const prev = extractAdjacentMediaId(html, "prev");
    if (!prev || seen.has(prev)) break;
    // Hors de l'époque du post (ex. photos d'autres publications plus récentes) → stop
    if (!sameIdEra(prev, setId)) break;
    seen.add(prev);
    items.push({ id: prev, h: null, w: null });
    cur = prev;
  }
  return items;
}

/**
 * Complète une galerie `pcb` via l'API GraphQL interne de Facebook
 * (`CometAlbumPhotoCollagePaginationQuery`, doc_id 29240820045553628).
 * Contrairement au viewer `/photo/`, cette API répond aussi depuis une IP de
 * datacenter : c'est elle qui permet à Render d'obtenir les 30/30.
 * Renvoie `{ items, complete }` ; `complete=false` si Facebook a refusé.
 */
async function paginatePcbGallery(setId, page, baseItems) {
  const items = [...baseItems];
  const seen = new Set(items.map((i) => String(i.id)));
  const norm = normalizeFbEncoding(page.html || "");

  const lsd = (norm.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1] || null;
  const nodeId =
    (norm.match(/"id":"(bWVkaWFzZXQ6[^"]+)"/) || [])[1] ||
    Buffer.from(`mediaset:pcb.${setId}`).toString("base64");
  const pageInfo = norm.match(
    /"page_info":\{"end_cursor":"([^"]+)","has_next_page":(true|false)\}/
  );
  let cursor = pageInfo ? pageInfo[1] : null;
  let hasNext = pageInfo ? pageInfo[2] === "true" : false;

  // La page expose déjà la fin de la galerie → rien à compléter.
  if (!hasNext) return { items, complete: true };
  if (!lsd || !cursor) return { items, complete: false };

  const cookies = page.cookies || "";
  const pageUrl = `https://www.facebook.com/media/set/?set=pcb.${setId}`;
  const variables = {
    count: 24,
    cursor,
    id: nodeId,
    renderLocation: "permalink",
    scale: 1,
  };

  for (let step = 0; step < 10 && hasNext && cursor; step++) {
    let text;
    try {
      const res = await fetch("https://www.facebook.com/api/graphql/", {
        method: "POST",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          "user-agent": UA_CRAWLER,
          "content-type": "application/x-www-form-urlencoded",
          accept: "*/*",
          "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
          origin: "https://www.facebook.com",
          referer: pageUrl,
          "x-fb-friendly-name": "CometAlbumPhotoCollagePaginationQuery",
          "x-requested-with": "XMLHttpRequest",
          "x-fb-lsd": lsd,
          ...(cookies ? { cookie: cookies } : {}),
        },
        body: new URLSearchParams({
          av: "0",
          __a: "1",
          __req: "1",
          dpr: "1",
          __ccg: "UNKNOWN",
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: "CometAlbumPhotoCollagePaginationQuery",
          variables: JSON.stringify(variables),
          doc_id: "29240820045553628",
          server_timestamps: "true",
        }),
      });
      if (!res.ok) return { items, complete: false };
      text = normalizeFbEncoding(await res.text());
    } catch {
      return { items, complete: false };
    }

    const ids = [
      ...new Set(
        [...text.matchAll(/\/photo\/\?fbid=(\d{6,20})/g)]
          .map((m) => m[1])
          .filter((id) => !seen.has(id))
      ),
    ];
    for (const id of ids) {
      seen.add(id);
      items.push({ id, h: null, w: null });
    }

    const next = [...text.matchAll(
      /"page_info":\{"end_cursor":"([^"]+)","has_next_page":(true|false)\}/g
    )].pop();
    if (!next) return { items, complete: false };
    cursor = next[1];
    hasNext = next[2] === "true";
    // Sécurité anti-boucle : page suivante mais aucun nouvel id.
    if (!ids.length && hasNext) return { items, complete: false };
  }

  return { items, complete: !hasNext };
}

/**
 * Résout un lien court `share/p/...` : depuis certaines IP (Render), Facebook
 * redirige vers /login/?next=<permalien>. On extrait de ce paramètre l'auteur
 * et l'id pfbid, puis on utilise la forme publique /<auteur>/posts/<pfbid>.
 * En local, la redirection mène directement à la publication : on la réutilise.
 */
async function resolveShareTarget(url) {
  try {
    const page = await fetchPage(url, UA_CRAWLER);
    const finalUrl = page.finalUrl || url;
    let u;
    try {
      u = new URL(finalUrl);
    } catch {
      return null;
    }
    if (!u.pathname.startsWith("/login")) {
      return finalUrl === url ? null : finalUrl;
    }
    const next = u.searchParams.get("next");
    if (!next) return null;
    const n = new URL(next, "https://www.facebook.com");
    const story = n.searchParams.get("story_fbid");
    const owner = n.searchParams.get("id");
    if (story && owner && /^\d+$/.test(owner)) {
      return `https://www.facebook.com/${owner}/posts/${story}`;
    }
    const groupM = n.pathname.match(/^\/groups\/([^/]+)\/posts\/([^/]+)/i);
    if (groupM) return `https://www.facebook.com/groups/${groupM[1]}/posts/${groupM[2]}`;
    return null;
  } catch {
    return null;
  }
}

/** Page d'un post : 2e tentative si la variante servie n'expose aucun id exploitable. */
async function fetchPostPage(target) {
  let url = "https://www.facebook.com" + pathOfUrl(target.toString());
  if (/\/share\//i.test(target.pathname)) {
    const resolved = await resolveShareTarget(url);
    if (resolved) url = resolved;
  }
  let html = "";
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      html = await fetchHtml(url, UA_CRAWLER);
    } catch (e) {
      lastErr = e;
      continue;
    }
    const norm = normalizeFbEncoding(html);
    if (/set=pcb\.\d/.test(norm) || extractStoryIdFromPage(html)) return html;
  }
  if (!html && lastErr) throw withUnavailable(lastErr);
  return html;
}

/** Analyse d'un post : galerie complète si set=pcb, sinon photos/og classiques. */
async function analyzePost(target) {
  const html = await fetchPostPage(target);
  const norm = normalizeFbEncoding(html);

  // 1) Galerie de publication (set=pcb.<storyId>) → liste JSON complète + chaîne prev.
  //    L'id pcb peut manquer dans certaines variantes de page → on le déduit
  //    de l'URL canonique / des métadonnées du post.
  const pcbM = norm.match(/set=pcb\.(\d{6,20})/);
  const setId = pcbM ? pcbM[1] : extractStoryIdFromPage(html);
  if (setId) {
    try {
      const setPage = await fetchPage(
        `https://www.facebook.com/media/set/?set=pcb.${setId}`,
        UA_CRAWLER
      );
      // Les items de cette page appartiennent par définition à la galerie :
      // pas de filtre d'époque ici (les photos peuvent être plus anciennes).
      let items = extractAlbumItems(setPage.html, ALBUM_MAX);
      if (items.length) {
        const paginated = await paginatePcbGallery(setId, setPage, items);
        items = paginated.items;
        // Filet de sécurité (IP résidentielle) si l'API de pagination échoue.
        if (!paginated.complete) items = await completePcbGallery(setId, items);
        const photos = await idsToPhotos(items, 4);
        if (photos.length) return dedupeById(sortByIdDesc(photos));
      }
    } catch {
      /* on retombe sur la méthode classique */
    }
  }

  // 2) Méthode classique : fbids présents dans la page
  const fbids = extractFbids(html, 24);
  const photos = await fbidsToPhotos(fbids, 4);
  if (photos.length) return dedupeById(photos);

  // 3) fallback og:image / scontent
  const og = extractOgImages(html);
  const large = pickLargest(og) || pickLargest(extractSccontentUrls(html));
  if (large) return [{ id: slugOf(large), thumb: large, full: large }];

  throw new Error("Aucune photo trouvée sur ce post (privé ou sans image).");
}

/** Analyse d'un album (/media/set/?set=a…) : toutes ses photos. */
async function analyzeAlbum(target) {
  const targetPath = pathOfUrl(target.toString());
  let page = null;
  for (const host of ["www.facebook.com", "m.facebook.com"]) {
    try {
      const candidate = await fetchPage(
        "https://" + host + targetPath,
        host === "m" ? UA_MOBILE : UA_CRAWLER
      );
      page = candidate;
      if (extractFbids(candidate.html, 1).length) break;
    } catch {
      /* host suivant */
    }
  }
  if (!page) throw withUnavailable(new Error("album fetch failed"));
  const html = page.html;

  // Priorité : items structurés de l'album (media_id + dimensions)
  let items = extractAlbumItems(html, ALBUM_MAX);
  // Galerie d'une publication (set=pcb) : compléter via la pagination GraphQL
  // (fonctionne aussi depuis Render), puis via la chaîne prevMedia en secours.
  const pcbM = targetPath.match(/set=pcb\.(\d{6,20})/);
  if (pcbM && items.length) {
    const paginated = await paginatePcbGallery(pcbM[1], page, items);
    items = paginated.items;
    if (!paginated.complete) items = await completePcbGallery(pcbM[1], items);
  }
  let source = "json";
  if (!items.length) {
    const ids = extractFbids(html, ALBUM_MAX);
    items = ids.map((id) => ({ id }));
    source = "fallback";
  }
  if (!items.length) {
    // L'URL peut être une photo d'album qui contient déjà le set
    try {
      return await analyzePhoto(target);
    } catch {
      throw new Error("Album inaccessible ou vide (privé ?).");
    }
  }
  const photos = (await idsToPhotos(items, ALBUM_CONCURRENCY))
    .map((p) => (source === "json" ? p : p));
  if (!photos.length) throw new Error("Aucune photo extractible de cet album.");
  return dedupeById(photos);
}

/** Page/profil public : og:image + lookaside du profile id possible. */
async function analyzePage(target) {
  let html = "";
  try {
    html = await fetchHtml(target.toString(), UA_CRAWLER);
  } catch (e) {
    throw withUnavailable(e);
  }
  // regarde les fbids présents (posts VN de la page)
  const fbids = extractFbids(html, 24);
  const photos = await fbidsToPhotos(fbids, 4);
  if (photos.length) return dedupeById(photos.slice(0, 24));

  const og = extractOgImages(html);
  const large = pickLargest(og);
  if (large) return [{ id: slugOf(large), thumb: large, full: large }];

  throw new Error(
    "Page publique analysée mais aucune photo exploitable. Utilisez plutôt un lien de photo, post ou album."
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pathOfUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.pathname + u.search;
  } catch {
    return urlStr;
  }
}
function dedupeById(arr) {
  const seen = new Set();
  return arr.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}
function sortByIdDesc(arr) {
  return [...arr].sort((a, b) => Number(b.id) - Number(a.id));
}
function withUnavailable(e) {
  const st = e && e.status ? ` (HTTP ${e.status})` : "";
  return new Error(
    "Page Facebook inaccessible ou non publique" + st +
    ". Seules les publications visibles sans connexion sont supportées."
  );
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

/** Valide le paramètre d'URL Facebook (erreurs 400). */
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function parseFbTarget(raw) {
  if (!raw) throw httpError(400, "Paramètre 'url' manquant.");
  let target;
  try {
    target = new URL(/^https?:\/\//i.test(raw) ? raw : "https://" + raw);
  } catch {
    throw httpError(400, "URL invalide.");
  }
  if (!FB_HOST_RE.test(target.hostname)) {
    throw httpError(400, "Seuls les liens facebook.com / fb.watch sont supportés.");
  }
  return target;
}

/** Analyse complète d'un lien Facebook, avec cache mémoire. */
async function analyzeTarget(target) {
  const urlStr = target.toString();
  const cached = cacheGet(urlStr);
  if (cached) return cached;

  const kind = classify(target);
  let photos;
  if (kind === "video") {
    throw httpError(400, "fb.watch / vidéos : non supporté dans cette version (images uniquement).");
  } else if (kind === "photo") photos = await analyzePhoto(target);
  else if (kind === "album") photos = await analyzeAlbum(target);
  else if (kind === "post") photos = await analyzePost(target);
  else photos = await analyzePage(target);

  const payload = { kind, count: photos.length, photos };
  cacheSet(urlStr, payload);
  return payload;
}

app.get("/api/analyze", async (req, res) => {
  try {
    const target = parseFbTarget(String(req.query.url || "").trim());
    res.json(await analyzeTarget(target));
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "Erreur inconnue" });
  }
});

/**
 * Téléchargement groupé : renvoie UN SEUL fichier ZIP (une seule demande
 * d'enregistrement au navigateur), photos en pleine résolution.
 */
app.get("/api/zip", async (req, res) => {
  let payload;
  try {
    const target = parseFbTarget(String(req.query.url || "").trim());
    payload = await analyzeTarget(target);
  } catch (e) {
    return res.status(e.status || 502).json({ error: e.message || "Erreur inconnue" });
  }
  if (!payload.photos.length) {
    return res.status(404).json({ error: "Aucune photo à compresser." });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const zipName = `fb-photos-${payload.count}-${stamp}.zip`;
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);
  res.setHeader("Cache-Control", "no-store");

  // archiver v8 est un module ESM : import dynamique depuis ce serveur CommonJS.
  const { ZipArchive } = await import("archiver");
  const archive = new ZipArchive({ zlib: { level: 1 } });
  let aborted = false;
  archive.on("warning", (err) => {
    if (err.code !== "ENOENT") console.warn("[zip] warning:", err.message);
  });
  archive.on("error", (err) => {
    console.error("[zip] erreur:", err.message);
    if (!res.headersSent) res.status(502).json({ error: "Erreur de compression." });
    else res.destroy(err);
  });
  res.on("close", () => {
    if (!res.writableEnded) {
      aborted = true;
      archive.abort();
    }
  });
  archive.pipe(res);

  let added = 0;
  for (const photo of payload.photos) {
    if (aborted) break;
    try {
      const upstream = await fetch(photo.full, {
        headers: { "user-agent": UA_CRAWLER, referer: "https://www.facebook.com/" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!upstream.ok || !upstream.body) continue;
      const type = (upstream.headers.get("content-type") || "").toLowerCase();
      const ext = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : ".jpg";
      const buf = Buffer.from(await upstream.arrayBuffer());
      if (!buf.length) continue;
      const safeId = String(photo.id || "photo").replace(/[^\w.-]+/g, "_");
      archive.append(buf, { name: `fb-${safeId}${ext}` });
      added++;
    } catch (e) {
      console.warn(`[zip] photo ${photo.id} ignorée:`, e.message);
    }
  }

  if (!aborted) {
    console.log(`[zip] ${added}/${payload.photos.length} photos → ${zipName}`);
    await archive.finalize();
  }
});

/** Proxy d'images : affichage + téléchargement (filename propre, same-origin). */
app.get("/api/proxy", async (req, res) => {
  const u = String(req.query.u || "");
  const dl = String(req.query.dl || "") === "1";
  const name = String(req.query.name || "").replace(/[^\w.\-]+/g, "_") || "fb-photo.jpg";

  let target;
  try {
    target = new URL(u);
  } catch {
    return res.status(400).end("URL invalide");
  }
  if (!CDN_HOST_RE.test(target.hostname)) {
    return res.status(403).end("Domaine non autorisé");
  }

  try {
    const upstream = await fetch(u, {
      headers: { "user-agent": UA_CRAWLER, referer: "https://www.facebook.com/" },
    });
    if (!upstream.ok || !upstream.body) {
      return res.status(upstream.status || 502).end("Récupération impossible");
    }
    const type = upstream.headers.get("content-type") || "image/jpeg";
    res.setHeader("Content-Type", type);
    res.setHeader("Content-Disposition", (dl ? "attachment" : "inline") + `; filename="${name}"`);
    res.setHeader("Cache-Control", "public, max-age=3600");
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    res.status(502).end("Erreur proxy : " + ("message" in e ? e.message : e));
  }
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`FB Photo Downloader démarré → http://localhost:${PORT}`);
});
