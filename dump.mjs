/** Dump et diagnostic d'une page FB en UA crawler. Usage : node dump.mjs "<url>" [fichier.out] */
"use strict";
const UA_CRAWLER =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const UA_MOB =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.230 Mobile Safari/537.36";

const args = process.argv.slice(2);
let mobile = false, urlArg = null, outFile = "last-dump.html";
for (const a of args) {
  if (a === "--ua") mobile = true;
  else if (!urlArg) urlArg = a;
  else outFile = a;
}
const ua = mobile ? UA_MOB : UA_CRAWLER;
if (!urlArg) { console.error("usage: node dump.mjs [--ua] <url> [out.html]"); process.exit(1); }

const res = await fetch(urlArg, {
  headers: {
    "user-agent": ua,
    accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    "accept-language": "fr-FR,fr;q=0.9,en;q=0.7",
  },
  redirect: "follow",
});
const html = await res.text();
await import("fs").then((fs) => fs.promises.writeFile(outFile, html, "utf8"));

console.log("status:", res.status, "| len:", html.length);
for (const pat of [
  "photo_id", "photo.php", "fallbackImage", "/m1/v/t6/", "media_id", '"id"',
  "scontent", "lookaside", "fbid=", "preferred_image", "thumbnail",
]) {
  const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const n = (html.match(re) || []).length;
  console.log(`  ${pat.padEnd(16)}: ${n}`);
}
