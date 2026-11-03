# FB Photo Downloader (auto-hébergé)

Téléchargeur de photos Facebook **publics** : photo seule, images d'un post, ou album complet —
en pleine résolution, **sans compte Facebook ni clé API**.

Projet original (code écrit de zéro). Il reproduit une *fonction technique* connue —
lire les URLs CDN que Facebook expose publiquement pour le référencement — sans reprendre
de code ni de marque d'aucun service existant.

## Fonctionnement

```
Navigateur → http://localhost:3812
   ↓  URL Facebook (photo, post, partage /share/, album)
Backend (Node/Express)
   ↓  GET page avec User-Agent "facebookexternalhit" (mode robot de FB)
   ←  HTML/JSON contenant les identifiants médias (fbid / media_id)
   ↓  résolution de chaque image via le service crawler public de Facebook :
      lookaside.fbsbx.com/lookaside/crawler/media/?media_id=<id>
   ↓  (post multi-photos) galerie media/set/?set=pcb.<story> + chaîne prevMedia
Front ← JSON {photos:[{id, thumb, full}]}
   ↓  affichage + téléchargement via /api/proxy (same-origin, nom de fichier propre)
```

- Aucun login, aucun cookie de session : le contenu **privé** n'est pas accessible (volontaire).
- Résolution : le service `lookaside/crawler` renvoie le fichier d'origine (souvent 1080–2048 px).
- Post multi-photos : la page `media/set/?set=pcb.<id>` liste les 24 premières photos,
  puis la chaîne `prevMedia` du viewer complète les photos restantes (30/30 vérifiées).
- Certaines visites renvoient une variante de page sans `set=pcb` : l'id de story est alors
  récupéré dans l'URL canonique / `og:url`, ce qui rend l'extraction déterministe.
- Cache mémoire 15 min par URL, album limité à 80 photos, concurrence 4.

## Installation

Node.js 18+ est requis. Si Node n'est pas installé globalement, utilisez la copie portable :

```powershell
# once :
C:\Users\ASS\AppData\Local\Programs\nodejs-portable\node-v26.13.0-win-x64\npm.cmd install
```

## Lancer

```powershell
$env:Path = "C:\Users\ASS\AppData\Local\Programs\nodejs-portable\node-v26.13.0-win-x64;" + $env:Path
node server.js
# → http://localhost:3812
```

## Endpoints

| Route | Rôle |
|---|---|
| `GET /api/analyze?url=<lien FB>` | Analyse le lien, renvoie `{count, photos:[{id, thumb, full}]}` |
| `GET /api/zip?url=<lien FB>` | Analyse puis renvoie **toutes les photos dans un seul fichier ZIP** |
| `GET /api/proxy?u=<url CDN>&name=...&dl=1` | Proxy image (affichage) + téléchargement avec nom de fichier |
| `GET /health` | Vérification de vie |

## Formats de liens acceptés

- `facebook.com/photo.php?fbid=…` / `photo/?fbid=…` — photo seule
- `facebook.com/<page>/posts/…`, `/permalink.php?story_fbid=…` — post (photos)
- `facebook.com/share/p/<code>/` — lien de partage (redirigé puis analysé comme un post)
- `facebook.com/media/set/?set=a.…` — album (multi-photos)
- `facebook.com/media/set/?set=pcb.…` — galerie d'une publication (complétée à 100 %)
- Page/profil public — images og:image présentes

## Outils de diagnostic

| Script | Usage |
|---|---|
| `node probe.mjs "<url>"` | Résumé d'une page (og:image, fbids, media_id) avec UA robot/mobile |
| `node probe.mjs --fbid <id>` | Teste les sources média pour un id (lookaside, graph, mobile) |
| `node dump.mjs [--ua] "<url>" [fichier]` | Sauvegarde le HTML reçu par le serveur + compteurs |

## Télécharger toutes les photos (ZIP)

Le bouton **« Tout télécharger (ZIP) »** envoie une seule requête à `/api/zip` :
le serveur analyse le lien, récupère chaque photo en pleine résolution, puis renvoie
**une seule archive ZIP** (`fb-photos-30-2026-11-03.zip`). Le navigateur n'ouvre donc
qu'**une seule boîte de dialogue d'enregistrement**.

- Format ZIP (universel) plutôt que RAR (création propriétaire, outils payants).
- Testé : 30 photos → archive de ~3 Mo, images 1080–2048 px.
- Les photos indisponibles sont ignorées sans faire échouer l'archive.

## Mettre en ligne gratuitement

### Option A — Render (recommandé, sans carte bancaire)

1. Créez un dépôt GitHub avec ce dossier (`git init`, commit, push).
2. Sur [render.com](https://render.com) → **New → Blueprint**, connectez le dépôt :
   le fichier `render.yaml` crée automatiquement le service gratuit.
   (Ou **New → Web Service** avec Build `npm ci` et Start `npm start`.)
3. Render fournit une URL HTTPS du type `https://fb-photo-downloader.onrender.com`.

Limites du plan gratuit Render : 512 Mo de RAM, mise en veille après 15 min sans
trafic (réveil ~1 min), 5 Go de bande passante/mois. Aucune carte bancaire requise.

### Option B — Cloudflare Tunnel (gratuit, depuis votre PC)

Si Facebook bloque les IP de datacenter (courant avec les hébergeurs gratuits),
exposez le serveur depuis votre connexion personnelle :

```powershell
# une seule fois : télécharger cloudflared
winget install Cloudflare.cloudflared
# puis, serveur démarré :
cloudflared tunnel --url http://localhost:3812
```

Cloudflare affiche une URL publique `https://<random>.trycloudflare.com` (temporaire,
sans compte). Votre PC doit rester allumé. Pour une URL fixe, créez un tunnel nommé
avec un domaine géré par Cloudflare (gratuit).

### Option C — Docker / autres plateformes

Un `Dockerfile` est fourni : il fonctionne sur Render, SnapDeploy, Zeabur, Koyeb,
Northflank, etc.

> ⚠️ **Important** : Facebook peut refuser ou limiter les requêtes venant d'IP de
> datacenter. Testez toujours l'URL déployée avec `/health` puis avec un vrai lien.
> En cas de blocage, l'option B (tunnel domicile) est la plus fiable.

## Limites connues

- Vidéos / Reels / Stories : hors périmètre (v1 images uniquement).
- Contenu privé, amis-restrictions, groupes fermés : inaccessible (par conception).
- Facebook peut modifier son HTML : l'extraction repose sur des motifs stables mais peut exiger des ajustements.
- Un usage intensif peut déclencher un blocage temporaire IP côté Facebook.

## Légal

À des fins personnelles et pédagogiques. Le scraping automatisé est encadré par les CGU de
Facebook — n'auto-saisissez pas de contenu qui ne vous appartient pas : jetez un œil aux droits,
aux CGU et aux lois locales avant d'utiliser l'outil sur des contenus tiers.
