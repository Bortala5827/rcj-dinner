# Dinner for You — Couples Ordering & Date-Night System

> She picks the dishes and records a song; you (the chef) get an email with a one-click link into the admin to listen & review → "Start cooking" / "Sing another" / "Serve".
> Pure front-end + Cloudflare Pages Functions + D1 + Resend. **Zero servers.** Fully migratable, white-label ready.
>
> 中文用户请看各节标题旁的小注。

🟢 **Live demo:** a production instance runs at **https://dinner.955827.xyz** (custom domain). The default admin password is a temporary test value — change it before sharing (see §2).

---

## 1. How it works

```
She opens the page
  └─ enters an invite code (allowlist) ── no code, no entry
       └─ picks dishes → writes "also want" → uploads a reference photo (canvas auto-compresses)
            └─ records a song (≤60s)
                 └─ leaves an email → submits
                       │
                       ├─ Resend email → you: new order + one-click deep link into admin
                       └─ Resend email → her: receipt "your order is in the kitchen"

You in the admin at /admin
  ├─ listen to the song + view the reference photo
  ├─ "Start cooking" → she gets "cooking now"
  ├─ "Sing another"  → she gets "sing one more" (original order kept, only the song swaps, saves storage)
  └─ "Serve"         → she gets "served"

Storage & cleanup
  ├─ media (audio/photos) kept 3 days by default → binary auto-deleted, order metadata kept
  ├─ order metadata kept 30 days by default → whole order purged
  └─ any API hit lazily GCs + /api/gc backs it up via an external timer
```

The core idea is **invite code = allowlist**: one code per person, email auto-bound on first submit, with optional use-limit / expiry. It is more anti-spam than an email allowlist (a stranger with no code can't get in, and each code can be individually revoked).

### Media storage — D1 by default (recommended for personal use)

With no R2 binding, songs and photos are stored **base64-encoded in D1**. No bucket to create, no extra cost, and the 3-day GC keeps the footprint small (a ~60s recording is roughly 60–100KB).

| Setup | Where media lives | When to use |
|-------|-------------------|-------------|
| `[[r2_buckets]]` commented out (default) | D1, base64 | **Personal use — recommended** |
| `MEDIA` bound to R2 | R2 objects; D1 keeps metadata only | High volume / white-label hand-off |

> ⚠️ On a personal instance keep `[[r2_buckets]]` commented out. Binding `MEDIA` silently switches media to R2 — intentional, but it means recordings leave D1.
>
> D1-mode caveat: `MAX_SONG_BYTES` (default 2MB) becomes ~2.7MB of base64 in a single row. It works, but shorter recordings keep D1 lean — and the 3-day GC deletes them anyway.

---

## 2. Deploy (5 minutes)

Requirements: Node 18+, and `wrangler` logged in locally (`wrangler login`) or a `CLOUDFLARE_API_TOKEN` available in CI.

```bash
# 1. enter the directory
cd rcj-dinner

# 2. local preview (optional)
npm run dev                      # http://localhost:8788

# 3. set secrets (sensitive values go through secrets, never into the repo / git)
wrangler pages secret put ADMIN_PASSWORD
wrangler pages secret put RESEND_API_KEY
wrangler pages secret put SITE_URL          # e.g. https://dinner.yourdomain.xyz
wrangler pages secret put GC_KEY            # any long random string; external timer uses it for /api/gc
#    OWNER_EMAIL (where new-order notifications go) is OPTIONAL at deploy time.
#    After deploy you can set / change it in the admin backend (工具 pane → 通知邮箱)
#    without touching env vars — handy for letting each side test with their own email.
# wrangler pages secret put OWNER_EMAIL     # optional fallback; if skipped, set it in the backend

# 4. create tables (first time only)
wrangler d1 execute rcj-analytics-d1 --remote --file=./schema.sql
#    when handing off, point this at the buyer's own database (see §5)

# 5. publish
npm run deploy                    # = wrangler pages deploy . --project-name rcj-dinner
```

> Non-secret vars in `wrangler.toml` (retention days, timezone, …) are editable directly; secrets always go through `secret put`. Any value shown in this README is a **placeholder default** and never a real credential.

One-command option (needs local `wrangler` installed and logged in):

```bash
bash scripts/deploy.sh
# values already exported as env vars are written directly; otherwise it prompts interactively.
```

> ⚠️ The default admin password is a temporary test value — **change it via `wrangler pages secret put ADMIN_PASSWORD` before sharing the site.**

---

## 3. Environment / Secrets

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ADMIN_PASSWORD` | ✅ secret | — | Admin `/admin` login password |
| `ADMIN_SESSION_DAYS` | optional | `2` | Admin session cookie lifetime in days (shorter = safer; re-login required after it expires) |
| `RESEND_API_KEY` | ✅ secret | — | Resend API key (two-way email) |
| `OWNER_EMAIL` | optional | — | New-order notification target. Set here OR in the admin backend (工具 → 通知邮箱); the backend value wins and is stored in D1. If both are blank, no notification email is sent. |
| `SITE_URL` | ✅ secret | `https://dinner.955827.xyz` | Used to build email deep links; set to your domain |
| `GC_KEY` | ✅ secret | — | External timer calls `/api/gc?key=` with this |
| `MAIL_FROM` | optional | `Dinner <noreply@955827.xyz>` | From address |
| `BRAND_JSON` | optional | see `_config.js` | **Rebrand**: `{"name":"...","tagline":"...","chef":"...","guest":"..."}` |
| `MENU_JSON` | optional | see `_config.js` | **Re-menu**: `[{"cat":"Main","items":[{"id":"x","name":"Braised Pork","mins":70}]}]` |
| `RETENTION_DAYS` | optional | `3` | Media retention (days) |
| `ORDER_RETENTION_DAYS` | optional | `30` | Order metadata retention (days) |
| `TZ_OFFSET` | optional | `8` | Timezone used in email timestamps |
| `SONG_REQUIRED` | optional | `1` | Require a song on submit (`0` = song optional, for "order-only" flows) |
| `NOTIFY_GUEST_ON_SUBMIT` | optional | `1` | Email guest a receipt on submit (`0` = only after you review) |
| `MAX_PHOTOS` | optional | `3` | Max reference photos per order |
| `MAX_PHOTO_BYTES` | optional | `307200` | Per-photo limit (~300KB, after compression) |
| `MAX_SONG_BYTES` | optional | `2097152` | Per-song limit (~2MB) |
| `DAILY_LIMIT` | optional | `3` | Max submits per invite code per day |
| `PENDING_LIMIT` | optional | `2` | Max in-progress orders per invite code |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | optional | — | Owner Telegram notification (in addition to email) |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN` / `D1_DATABASE_ID` | REST fallback only | — | Only when no DB binding is set; normally unused |

A copy-paste template is in `.env.example` (note: secrets are never written into a committed `.env`; only names + defaults are listed here for hand-off reference).

---

## 4. Rebrand / White-label (the key to selling it as a product)

**No code changes** — pick one:

- **Option A (recommended):** after deploy, set `BRAND_JSON` / `MENU_JSON` in Cloudflare Pages → `Settings → Environment variables`. Site name, tagline, and menu all change.
- **Option B:** edit `DEFAULT_BRAND` / `DEFAULT_MENU` in `functions/api/_config.js` (good for packaging a fixed theme per customer).

Four anti-spam layers, out of the box:
1. Invite-code gate (no code, no entry)
2. Email binding (auto-bound on first submit; that code then only accepts this email)
3. Rate limiting (by invite code / IP / day + in-progress order count)
4. Honeypot field + minimum fill time (blocks bots)

---

## 5. Migrate / Hand off to a buyer

**Move the whole database (data + media):**
```
GET /api/admin/export?format=json&scope=all&media=1   # includes base64 media, re-importable
```
After the new site is up, replay this JSON into its D1 — zero external dependencies.

**Change Cloudflare account / database:**
1. In the new account: `wrangler d1 create dinner-d1` → get the `database_id`
2. Edit `wrangler.toml`: change the project `name` and the `d1_databases` `database_id`
3. `wrangler d1 execute <new-db> --remote --file=./schema.sql`
4. Re-run `wrangler pages secret put` for all secrets
5. (Optional) Bind R2: uncomment `[[r2_buckets]]` in `wrangler.toml` — media auto-moves to R2, D1 keeps only metadata, **zero code changes**

**Change domain:** change only the `SITE_URL` variable (affects email deep links).

**Owner notification email — set in the backend, no redeploy:**
Once logged in at `/admin`, open the **工具 (Tools) pane → 通知邮箱（站长）** card. Type any email and save — it is stored in D1 (`dinner_meta k='owner_email'`) and overrides the `OWNER_EMAIL` env var. This means both the seller (you) and the buyer can each plug in their own inbox to test the email loop without touching deployment secrets or redeploying. Leave it blank to fall back to the `OWNER_EMAIL` secret, or leave both blank to run email-free.

---

## 5.2 Buyer setup (the only tutorial a buyer needs)

When you hand this off as a white-label product, the buyer does **not** touch code or Cloudflare Functions. The whole setup is two steps:

1. **Cloudflare domain hosting** — point the buyer's domain (or a clean subdomain, e.g. `dinner.theirbrand.xyz`) at Cloudflare, then assign it to the Pages project (`Settings → Custom domains`). A subdomain on an existing zone is fine and causes no conflict with other sites.
2. **Resend API + domain binding** — the buyer signs up at Resend, creates an API key, adds their sending domain, and pastes the SPF/DKIM records into their DNS. Once the domain shows *verified* in Resend, the new account leaves test mode (can send to any `to` address, not just the account email).

After those two steps, the buyer pastes the Resend key into `RESEND_API_KEY`, sets `SITE_URL`, and they are live. The notification inbox is then chosen in the backend (see above) — no env-var juggling required.

> 💡 Keep `MAIL_FROM` at its default unless the buyer wants a custom From name; the default `Dinner <noreply@955827.xyz>` works as long as the Resend-verified domain matches.

---

## 5.1 Automation (GitHub Actions — "periodic export + 3-day auto-cleanup")

Cloudflare **Pages** Functions have no cron; cleanup runs on two legs: ① any request lazily GCs, and ② **an external timer as backstop** so the site still cleans up when nobody visits.

Two workflows ship in this repo (run on GitHub, no local wrangler needed):

| File | Purpose | Default frequency |
|------|---------|-------------------|
| `.github/workflows/gc-keepalive.yml` | pings `/api/gc?key=` to trigger media/order cleanup | every 6 hours |
| `.github/workflows/backup.yml` | calls `/api/admin/export?format=json&media=1&key=` for a full backup (with base64 media), stored as a 30-day Artifact | every Monday |

**Before enabling, add two Actions secrets** in `Settings → Secrets and variables → Actions`:
- `SITE_URL`: e.g. `https://dinner.yourdomain.xyz`
- `GC_KEY`: the same long random string used for `wrangler pages secret put GC_KEY` (the export endpoint reuses it for auth, so CI needs no admin login)

The export endpoint originally only accepted an admin cookie; it now also accepts `key=<GC_KEY>` as a fallback (see `functions/api/admin/export.js`), so CI can trigger backups without a session.

---

## 6. Project structure

```
rcj-dinner/
├─ wrangler.toml              # deploy config (for hand-off, change project name + d1_databases id)
├─ package.json               # dev / deploy / check / db:init
├─ schema.sql                 # 5 tables, all `dinner_`-prefixed and isolated
├─ index.html + assets/       # ordering UI (gate → menu → reference photo → record → submit → progress)
├─ admin.html + assets/admin.js  # chef admin (review / invite codes / export / cleanup)
├─ functions/api/
│  ├─ _lib.js                 # shared layer: CORS / HMAC / D1 dual-channel / media / GC / invite codes
│  ├─ _config.js              # brand / menu / email templates (change these to rebrand)
│  ├─ _notify.js              # two-way email (notifyOwner / notifyGuest)
│  ├─ config.js               # GET /api/config?k=<code> (gate + load menu)
│  ├─ order.js                # POST /api/order (new order / re-sing)
│  ├─ order/status.js         # GET progress
│  ├─ order/media/[id].js     # GET media binary
│  ├─ admin/login.js          # login / session
│  ├─ admin/orders.js         # list / review actions
│  ├─ admin/invites.js        # invite-code management
│  ├─ admin/settings.js       # owner notification email (backend-set, stored in D1)
│  ├─ admin/export.js         # JSON / CSV export
│  └─ gc.js                   # external-timer cleanup trigger
└─ scripts/check-syntax.mjs   # pre-commit syntax gate: node scripts/check-syntax.mjs
```

---

## 7. Pre-commit self-check

```bash
npm run check     # validates functions + front-end JS + inline scripts (catches cross-line quote corruption)
```
All SQL uses prepared parameters; media storage is dual-channel (R2 first, D1 fallback).
