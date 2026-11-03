/**
 * Sonde de diagnostic : fetch d'une URL FB avec le User-Agent robot
 * et signalement de ce que le HTML expose (og:image, fbids, scontent).
 * Usage : node probe.mjs "https://www.facebook.com/<page>"
 */
"use strict";

const UA_CRAWLER =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const UA_MOBILE =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36";

function unescapeFbUrl(raw) {
  let u = String(raw);
  u = u.replace(/\\u002[fF]/g, "/");
  u = u.replace(/\\u002[5E]/g, (m) => (m.toLowerCase() === "\\u0025" ? "%" : "&"));
  u = u.replace(/\\\//g, "/");
  u = u.replace(/&amp;/g, "&");
  return u.trim();
}

function extractOgImages(html) {
  const out = [];
  const metaRe = /<meta\s+[^>]*>/gi;
  let m;
  while ((m = metaRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/og:image/i.test(tag)) continue;
    const c = tag.match(/content=["']([^"']+)["']/i);
    if (c) out.push(unescapeFbUrl(c[1]));
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: node probe.mjs <url> | --fbid <id>");
    process.exit(1);
  }

  // Mode fbid : piste 1 = lookaside crawler media (service public FB pour robots)
  if (arg === "--fbid") {
    const fbid = process.argv[3];
    const tries = [
      ["lookaside crawler", `https://lookaside.fbsbx.com/lookaside/crawler/media/?media_id=${fbid}`, UA_CRAWLER],
      ["graph picture", `https://graph.facebook.com/v21.0/${fbid}/picture`, UA_CRAWLER],
      ["mbasic view_full_size", `https://mbasic.facebook.com/photo/view_full_size/?fbid=${fbid}`, UA_MOBILE],
      ["m view_full_size", `https://m.facebook.com/photo/view_full_size/?fbid=${fbid}`, UA_MOBILE],
    ];
    for (const [label, url, ua] of tries) {
      try {
        const res = await fetch(url, { redirect: "manual", headers: { "user-agent": ua, referer: "https://www.facebook.com/" } });
        const info = {
          label,
          status: res.status,
          type: res.headers.get("content-type"),
          len: res.headers.get("content-length"),
          location: (res.headers.get("location") || "").slice(0, 140),
          url: res.url.slice(0, 140),
        };
        console.log(label, "→", JSON.stringify(info, null, 1));
        if (res.status === 200 && !info.location) await res.body.cancel();
      } catch (e) {
        console.log(label, "FAILED:", e.cause?.code || e.message);
      }
    }
    return;
  }

  const target = arg;
  for (const [label, ua] of [["crawler", UA_CRAWLER], ["mobile", UA_MOBILE]]) {
    try {
      const res = await fetch(target, {
        headers: { "user-agent": ua, accept: "text/html,*/*;q=0.8", "accept-language": "fr-FR,fr;q=0.9" },
        redirect: "follow",
      });
      const html = await res.text();
      const norm = html
        .replace(/\\u003[aA]/g, ":")
        .replace(/\\u002[fF]/g, "/")
        .replace(/\\\//g, "/");
      const ogs = extractOgImages(norm);
      const fbids = [...norm.matchAll(/fbid=(\d+)/g)].map((x) => x[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);
      const scontent = [...norm.matchAll(/https?:\/\/[^"'\s<>]*scontent[^"'\s<>]+/g)]
        .map((x) => unescapeFbUrl(x[0])).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6);
      console.log(`\n=== UA ${label} ===`);
      console.log("status:", res.status, "| html length:", html.length);
      console.log("occurrences scontent:", (norm.match(/scontent/g) || []).length);
      console.log("meta og:image tag:", /<meta[^>]*og:image/i.test(norm) ? "present" : "absent");
      console.log("og:image:", ogs.length ? ogs.slice(0, 4) : "(none)");
      console.log("fbids:", fbids.join(", ") || "(none)");
      const sets = [...norm.matchAll(/\/media\/set\/\?set=(a[\w.=-]{4,80})/g)].map((x) => x[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 5);
      console.log("albums media/set:", sets.length ? sets : "(none)");
      const setParams = [...norm.matchAll(/[?&]set=(a(?:\.\d+){1,6})/g)].map((x) => x[1]).filter((v, i, a) => a.indexOf(v) === i).slice(0, 6);
      console.log("params set=a:", setParams.length ? setParams : "(none)");
      console.log("scontent sample:", scontent.length ? scontent : "(none)");
    } catch (e) {
      console.log(`\n=== UA ${label} === FAILED:`, e.cause?.code || e.message);
    }
  }
}

main();
