<div align="center">

# 🛒 UHQ Orders Add-on

**A built-in shop: sell proxy accounts and have them delivered automatically.**

Official free add-on for [UHQ Panel OS](https://github.com/BloumeSAS/UHQ-Panel-OS) — by [Bloume SAS](https://bloume.fr)

[![Release](https://img.shields.io/github/v/release/BloumeSAS/UHQ-Addon-Orders?color=f97316)](https://github.com/BloumeSAS/UHQ-Addon-Orders/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-online-0ea5e9)](https://uhq-panel-os-docs.bloume.fr/addons/official/orders)
[![Video](https://img.shields.io/badge/video-YouTube-red?logo=youtube)](https://youtu.be/YRiaL9PhQ5o)

🇬🇧 English · [🇫🇷 Français](README.fr.md)

</div>

---

## Features

- Product catalogue with stock, fixed price or pay-per-GB
- Payment by Wallet balance, card (Stripe), crypto (NOWPayments) or PayPal
- Automatic delivery of proxy accounts, optional admin approval
- Automatic renewal from the Wallet balance
- Promo codes, PDF invoices and receipts
- Read-only order feed for the Referral add-on

▶️ **Video — install, test and tour:** https://youtu.be/YRiaL9PhQ5o

## Requirements

- UHQ Panel OS (latest version recommended)
- Wallet add-on

## Installation

### Bundled (recommended)

The add-on is already included in the UHQ Panel OS image. In the panel, open **Extensions**, find **Orders** and click **Enable**. Nothing else to configure: the panel starts it as an internal process and serves it under `/addon-proxy/orders/`.

### Standalone (Docker)

```bash
docker run -d --name uhq-addon-orders -p 3102:3102 \
  -e PANEL_URL=https://panel.example.com \
  -e PANEL_API_KEY=your-panel-api-key \
  -v uhq-addon-orders:/app/data \
  ghcr.io/bloumesas/uhq-addon-orders:latest
```

Then add its URL in **Extensions → Add an add-on**.

## Configuration

| Variable | Description |
|---|---|
| `PORT` | Listening port (default `3102`) |
| `PANEL_URL` | Panel URL (token verification, panel API) |
| `PANEL_API_KEY` | Panel API key (Settings → API key): backups, e-mails, add-on to add-on calls |
| `DB_PATH` | Data file (JSON) |
| `WALLET_URL` | Wallet add-on URL |
| `PROMO_URL` | Promo Codes add-on URL |
| `NODE_ENV` | `production` or `development` |

## Security

Every request is verified by the panel (`/api/panel/security/me`): roles are never read from the token alone. Add-on to add-on calls and backups require the panel API key (`X-Panel-Key`, constant-time comparison). Report vulnerabilities privately — see the [UHQ Panel OS security policy](https://github.com/BloumeSAS/UHQ-Panel-OS/blob/main/SECURITY.md).

## Development

```bash
npm run install:all
cd api && npm run start:dev   # API :3102
cd web && npm run dev         # Vite dev server
npm run build                 # web + api
```

When bundled in the panel image, the web app is built with `--base="/addon-proxy/orders/"`.

## Documentation

https://uhq-panel-os-docs.bloume.fr/addons/official/orders

## License

[MIT](LICENSE) © [Bloume SAS](https://bloume.fr)
