# UHQ Orders Addon

> **Addon officiel pour [UHQ Panel OS](https://github.com/BloumeSAS/UHQ-Panel-OS)** — by [Bloume SAS](https://bloume.fr)
>
> Boutique interne : l'admin gère un catalogue de produits, les utilisateurs passent commande et **paient avec leur solde** géré par l'addon [Wallet](https://github.com/BloumeSAS/UHQ-Addon-Wallet).

NestJS + React, une seule image Docker, persistance JSON — exactement la même architecture que l'addon Wallet.

---

## ⚠️ Dépendance : l'addon Wallet

Orders **ne stocke aucun solde**. Il délègue toute la gestion du solde à l'addon **Wallet** :

- la lecture du solde et le **débit à la commande** passent par l'API du Wallet ;
- à l'annulation d'une commande payée, le montant est **remboursé** automatiquement.

L'addon Wallet doit donc être **installé, déployé et joignable**. Tant qu'il ne l'est pas, la boutique affiche un avertissement et le paiement est désactivé.

> 🔑 **Aucun token admin requis.** Les deux addons s'authentifient mutuellement via `PANEL_API_KEY` — la même clé déjà utilisée pour le système de backup. Pas de JWT à récupérer, pas d'expiration à gérer.

---

## Fonctionnalités

- 🛍️ Catalogue de produits (CRUD admin : nom, description, prix, stock, actif/inactif)
- 💳 Paiement avec le solde Wallet (débit automatique au paiement)
- 📦 Gestion du stock (décrémenté à la commande, illimité si non renseigné)
- 🧾 Suivi des commandes (payée / honorée / annulée) — l'annulation rembourse le solde
- 📊 Widget KPIs sur le Dashboard (commandes, chiffre d'affaires, produits actifs)
- 🛒 Raccourci « Boutique » dans le dropdown topbar
- 💾 Backup automatique inclus (produits + commandes)
- 🌍 Français et anglais

---

## Installation (local)

```bash
git clone https://github.com/BloumeSAS/UHQ-Addon-Orders
cd UHQ-Addon-Orders
npm run install:all
cp .env.example .env   # renseigner WALLET_URL (et PANEL_API_KEY si protection backup souhaitée)
npm run build && npm start
```

Connecter dans le panel : **Extensions → `http://localhost:3002`**.

Pour le hot-reload en développement :

```bash
cd api && npm run start:dev   # NestJS :3002
cd web && npm run dev          # Vite   :5175
```

---

## Intégration Wallet — zero-config

| Variable | Obligatoire | Description |
|---|---|---|
| `WALLET_URL` | ✅ | URL de base de l'addon Wallet (ex. `https://wallet.domaine.com` ou `http://wallet:3001` en compose) |
| `PANEL_API_KEY` | Recommandé | Clé API du panel — protège aussi le backup. Déjà définie si vous utilisez les deux addons en production. |

**C'est tout.** Pas de `WALLET_SERVICE_TOKEN`. Les communications inter-addons sont sécurisées via `PANEL_API_KEY`, le même header `X-Panel-Key` que le système de backup. Si `PANEL_API_KEY` n'est pas définie (dev local), les appels sont autorisés sans authentification (comportement identique au backup).

### Comment ça marche

```
[Orders]  POST /api/wallet/internal/add
          Header: X-Panel-Key: <PANEL_API_KEY>
          ──────────────────────────────────►  [Wallet]
                                               Vérifie X-Panel-Key === PANEL_API_KEY
                                               Débite / crédite le wallet
```

Le Wallet expose `/api/wallet/internal/add` **uniquement** pour les appels inter-addons. Cet endpoint n'est pas documenté dans l'API publique du Wallet et n'est pas accessible sans la clé.

---

## Docker (Coolify)

1. Nouveau service Docker Compose → coller `docker-compose.coolify.yml`
2. Variables : `PANEL_URL`, `PANEL_API_KEY`, `WALLET_URL`, `DOMAIN`
3. Volume : `orders_data` → `/app/data`
4. Connecter dans le panel : `https://orders.domaine.com`

---

## Zones injectées

| Zone | Type | Description |
|---|---|---|
| `topbar` | Slot | « Boutique » dans le dropdown |
| `/admin` | Page admin | « Gestion boutique » (adminOnly) — produits + commandes |
| `/` | Page | Boutique utilisateur (catalogue + mes commandes) |
| `/` | Widget 100px | 3 KPIs : commandes, CA, produits actifs |

---

## API

Authentification : `Authorization: Bearer <jwt-panel>` (passé par le panel).

| Méthode | Endpoint | Accès | Description |
|---|---|---|---|
| `GET`    | `/api/products`               | user  | Catalogue actif (`?all=true` admin → inclut inactifs) |
| `POST`   | `/api/products`               | admin | Créer un produit |
| `PATCH`  | `/api/products/:id`           | admin | Modifier un produit |
| `DELETE` | `/api/products/:id`           | admin | Supprimer un produit |
| `GET`    | `/api/orders`                 | user  | Mes commandes (`?all=true` admin → toutes) |
| `POST`   | `/api/orders`                 | user  | Passer commande `{ items: [{ product_id, quantity }] }` |
| `PATCH`  | `/api/orders/:id/status`      | admin | `paid` \| `fulfilled` \| `cancelled` (annulation = remboursement) |
| `GET`    | `/api/balance`                | user  | Solde de l'utilisateur (proxy Wallet) |
| `GET`    | `/api/wallet-status`          | user  | Wallet joignable / configuré |
| `GET`    | `/api/backup/export`          | panel | Export (header `X-Panel-Key`) |
| `POST`   | `/api/backup/import`          | panel | Import (header `X-Panel-Key`) |

---

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | `3002` | Port d'écoute |
| `PANEL_URL` | `http://localhost:8000` | URL du panel |
| `DB_PATH` | `./orders-data.json` | Fichier de données |
| `PANEL_API_KEY` | *(vide)* | Clé API du panel (backup + auth inter-addon) |
| `WALLET_URL` | `http://localhost:3001` | URL de l'addon Wallet |

---

## Licence

MIT — © 2026 Bloume SAS
