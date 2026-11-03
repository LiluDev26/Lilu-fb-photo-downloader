/* FB Photo Downloader — logique front (projet original) */
"use strict";

const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const goBtn = $("go");
const clearBtn = $("clear");
const pasteBtn = $("paste");
const statusEl = $("status");
const resultsEl = $("results");
const gridEl = $("grid");
const countLabel = $("count-label");
const downloadAllBtn = $("download-all");

let currentPhotos = [];
let currentSourceUrl = "";

function setStatus(text, kind = "info") {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
}
function hideStatus() {
  statusEl.hidden = true;
}

function proxyUrl(photoUrl, name, dl) {
  const q = new URLSearchParams({ u: photoUrl, name });
  if (dl) q.set("dl", "1");
  return "/api/proxy?" + q.toString();
}

function render(photos) {
  currentPhotos = photos;
  gridEl.innerHTML = "";
  resultsEl.hidden = false;
  downloadAllBtn.hidden = photos.length < 2;
  countLabel.textContent =
    photos.length === 1 ? "1 photo trouvée" : photos.length + " photos trouvées";

  photos.forEach((p, i) => {
    const card = document.createElement("div");
    card.className = "card";

    const img = document.createElement("img");
    img.alt = "photo " + (i + 1);
    img.loading = "lazy";
    img.src = proxyUrl(p.thumb, "fb-" + p.id + ".jpg", false);
    img.addEventListener("click", () => window.open(proxyUrl(p.full, "fb-" + p.id + ".jpg", false), "_blank"));
    img.addEventListener("error", () => { img.src = p.thumb; });

    const meta = document.createElement("div");
    meta.className = "meta";

    const idSpan = document.createElement("span");
    idSpan.className = "id";
    idSpan.textContent = p.id || "photo";
    idSpan.title = p.full;

    const dl = document.createElement("button");
    dl.className = "btn primary small";
    dl.textContent = "HD";
    dl.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = proxyUrl(p.full, "fb-" + p.id + ".jpg", true);
      a.download = "fb-" + p.id + ".jpg";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    meta.append(idSpan, dl);
    card.append(img, meta);
    gridEl.appendChild(card);
  });
}

async function run() {
  const raw = urlInput.value.trim();
  if (!raw) {
    setStatus("Collez d'abord un lien Facebook.", "error");
    return;
  }
  goBtn.disabled = true;
  goBtn.textContent = "Analyse…";
  clearBtn.hidden = false;
  hideStatus();
  resultsEl.hidden = true;

  try {
    const res = await fetch("/api/analyze?url=" + encodeURIComponent(raw));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Erreur serveur " + res.status);
    if (!data.photos || !data.photos.length) throw new Error("Aucune photo récupérée.");
    currentSourceUrl = raw;
    render(data.photos);
  } catch (e) {
    setStatus(e.message || "Erreur inattendue.", "error");
  } finally {
    goBtn.disabled = false;
    goBtn.textContent = "Récupérer";
  }
}

goBtn.addEventListener("click", run);
urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });

clearBtn.addEventListener("click", () => {
  urlInput.value = "";
  clearBtn.hidden = true;
  hideStatus();
  resultsEl.hidden = true;
  gridEl.innerHTML = "";
  urlInput.focus();
});

pasteBtn.addEventListener("click", async () => {
  try {
    const txt = await navigator.clipboard.readText();
    if (txt) {
      urlInput.value = txt.trim();
      run();
    }
  } catch {
    setStatus("Impossible de lire le presse-papiers — collez manuellement.", "error");
  }
});

downloadAllBtn.addEventListener("click", async () => {
  if (!currentSourceUrl) return;
  const btn = downloadAllBtn;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Préparation du ZIP…";
  setStatus("Création de l'archive ZIP (" + currentPhotos.length + " photos)…", "info");

  try {
    const res = await fetch("/api/zip?url=" + encodeURIComponent(currentSourceUrl));
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Erreur serveur " + res.status);
    }
    const blob = await res.blob();
    const cd = res.headers.get("content-disposition") || "";
    const m = cd.match(/filename="([^"]+)"/i);
    const name = m ? m[1] : "fb-photos.zip";

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus("ZIP téléchargé : " + name + " (" + currentPhotos.length + " photos).", "info");
  } catch (e) {
    setStatus(e.message || "Impossible de créer le ZIP.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});
