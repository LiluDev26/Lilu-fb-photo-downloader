# Déployer sur Render (gratuit, sans carte bancaire)

Ce guide met l'outil en ligne avec une URL HTTPS permanente du type
`https://fb-photo-downloader.onrender.com`.

> Le plan gratuit Render : 512 Mo de RAM, mise en veille après 15 min sans trafic
> (réveil ~1 min), 5 Go de bande passante/mois. Aucune carte bancaire demandée.

## 1. Créer le dépôt GitHub

Le dossier est déjà un dépôt Git local (commit initial créé). Il reste à le publier :

1. Ouvrez <https://github.com/new>.
2. Nom : `fb-photo-downloader` — visibilité **Private** ou **Public** (Render lit les deux).
3. Ne cochez **rien** (pas de README, pas de .gitignore).
4. Cliquez **Create repository**, puis copiez l'URL affichée.

Dans ce dossier :

```powershell
git remote add origin https://github.com/<votre-compte>/fb-photo-downloader.git
git push -u origin main
```

Git Credential Manager ouvrira une fenêtre de connexion GitHub au premier push.

### Si le push est refusé (`403 Permission denied`)

Le gestionnaire d'identifiants contient un token **fine-grained en lecture seule**.
Créez un nouveau token sur <https://github.com/settings/personal-access-tokens/new> :

- **Repository access** : Only select repositories → `LiluDev26/Lilu-fb-photo-downloader`
- **Permissions → Repository permissions → Contents** : **Read and write**
- Durée : 7 jours (suffit pour le déploiement)

Puis, dans ce dossier :

```powershell
git credential-manager github login --username LiluDev26 --force --pat "github_pat_..."
git push -u origin main
```

Le token peut être révoqué après le push (Render utilise sa propre intégration GitHub,
pas ce token).

## 2. Déployer avec le Blueprint Render

1. Créez un compte sur <https://render.com> (connexion avec GitHub, aucun moyen de paiement).
2. Tableau de bord → **New → Blueprint**.
3. Sélectionnez le dépôt `fb-photo-downloader`.
4. Render détecte `render.yaml` et propose le service **fb-photo-downloader** (plan Free).
5. Cliquez **Apply** et attendez la fin du build (2–4 min).

Render affiche ensuite l'URL publique du service.

## 3. Vérifier le déploiement

```powershell
# doit renvoyer {"ok":true}
Invoke-RestMethod https://<votre-url>.onrender.com/health

# test complet : depuis Render, count=24 (viewer photo bloqué)
$fb = [uri]::EscapeDataString("https://www.facebook.com/share/p/1EpmWtAXs5/")
Invoke-RestMethod "https://<votre-url>.onrender.com/api/analyze?url=$fb" |
  Select-Object kind, count

# test ZIP : télécharge une seule archive
Invoke-WebRequest "https://<votre-url>.onrender.com/api/zip?url=$fb" -OutFile photos.zip
```

Ouvrez ensuite l'URL dans le navigateur, collez un lien et cliquez
**« Tout télécharger (ZIP) »**.

## 4. Galeries complètes (30/30) : tunnel Cloudflare

Depuis l'IP de Render, Facebook redirige le viewer photo vers `/login` : les
galeries `pcb` sont plafonnées à **24 photos**. Pour obtenir les 30, exposez le
serveur depuis votre connexion personnelle :

```powershell
# double-cliquez plutôt sur start-public.bat
powershell -ExecutionPolicy Bypass -File .\start-public.ps1
```

Le script démarre le serveur, télécharge `cloudflared` si besoin, crée le tunnel,
copie l'URL `https://<random>.trycloudflare.com` dans le presse-papiers et l'ouvre.
Laissez la fenêtre ouverte ; l'URL change à chaque redémarrage.

## 5. Mises à jour

Chaque `git push` sur `main` redéploie automatiquement (autoDeploy activé) :

```powershell
git add .
git commit -m "description du changement"
git push
```

## Dépannage

| Symptôme | Cause / solution |
|---|---|
| Première visite lente (~1 min) | Le service gratuit était en veille ; c'est normal. |
| 24 photos au lieu de 30 | Facebook bloque le viewer photo depuis l'IP de Render. Utilisez `start-public.bat` (tunnel domicile) pour les 30/30. |
| `count=0`, page de connexion FB, erreur 502 | Facebook bloque l'IP du datacenter. Utilisez l'option Cloudflare Tunnel (voir README) depuis votre PC. |
| Build échoue sur `npm ci` | Vérifiez que `package-lock.json` est bien poussé sur GitHub. |
| ZIP vide ou incomplet | Facebook a limité certaines images ; réessayez plus tard ou vérifiez les logs Render. |

## Sécurité et bon usage

- L'URL Render est **publique** : toute personne qui la connaît peut l'utiliser.
  Pour un usage privé, ajoutez un mot de passe (variable d'environnement + middleware)
  ou gardez le dépôt privé et ne partagez pas l'URL.
- Le service télécharge des contenus publics uniquement ; respectez les droits d'auteur.
- Un usage intensif peut faire bloquer l'IP du service par Facebook et consommer
  la bande passante Render (5 Go/mois).
