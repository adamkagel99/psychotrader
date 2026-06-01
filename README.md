# Psycho Trader — Cloud Sync Edition

Your trading journal with account sign-in (email + Google) and cross-device
data sync, powered by Supabase. The app is **local-first**: it works against
your browser's local storage, and when you're signed in, every change syncs to
the cloud and pulls down on other devices.

---

## How it works (architecture)

- **Auth + database:** Supabase (Postgres). Each user only ever sees their own
  rows (enforced by Row-Level Security).
- **Local-first sync:** the existing app keeps using `localStorage`. A small sync
  layer (`src/sync.js`) hydrates local storage from the cloud on sign-in, then
  mirrors every local write back up (debounced). The big app needed no rewrite.
- **Data mapping:**
  - `journal:YYYY-MM-DD` → `journal_days` + child `trades` rows
  - `tf-transfers` → `transfers` rows
  - other `tf-*` settings blobs → `user_kv` (key/value JSONB)
  - pure UI/cache keys (economic-events cache, AI-coach scratch) are not synced.

---

## One-time setup

### 1. Create a Supabase project
- Go to https://supabase.com → **New project** (free tier is fine).
- Wait ~2 minutes for it to provision.

### 2. Create the database
- Left sidebar → **SQL Editor** → **New query**.
- Paste the contents of **`psycho-trader-schema.sql`** (included separately) → **Run**.
- Confirm the tables appear under **Table Editor**:
  `profiles, journal_days, trades, transfers, user_kv`.

### 3. Enable Email auth
- **Authentication → Providers → Email** → make sure it's enabled.
- For testing, you can disable "Confirm email" so you don't wait on verification mail.

### 4. Enable Google auth
- **Authentication → Providers → Google** → toggle on. It shows a redirect URL like
  `https://<your-project>.supabase.co/auth/v1/callback`.
- In **Google Cloud Console** (https://console.cloud.google.com):
  - Create/select a project → **APIs & Services → Credentials**.
  - **Create credentials → OAuth client ID → Web application**.
  - Under **Authorized redirect URIs**, paste the Supabase callback URL above.
  - Also add your app's URL(s) under **Authorized JavaScript origins**
    (e.g. `http://localhost:5173` for dev and your deployed domain for prod).
  - Copy the **Client ID** and **Client secret** → paste into Supabase's Google
    provider fields → **Save**.

### 5. Get your keys
- Supabase → **Settings → API**.
- Copy **Project URL** and the **anon / public** key.
- ⚠️ Never use the **service_role** key in frontend code.

---

## Run locally

```bash
npm install
cp .env.example .env      # then edit .env with your URL + anon key
npm run dev               # opens http://localhost:5173
```

Sign up with email, or click **Continue with Google**.

---

## Deploy (Vercel — recommended)

1. Push this folder to a GitHub repo.
2. Go to https://vercel.com → **New Project** → import the repo.
3. Framework preset: **Vite** (auto-detected). Build command `npm run build`,
   output dir `dist`.
4. **Environment Variables** → add:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon key
5. Deploy. You'll get a URL like `https://psycho-trader.vercel.app`.
6. Back in **Google Cloud Console**, add that URL to **Authorized JavaScript
   origins**, and in **Supabase → Authentication → URL Configuration**, add it to
   **Site URL / Redirect URLs**. (Otherwise Google sign-in will reject the redirect.)

### Netlify alternative
Same idea: New site from Git → build `npm run build`, publish dir `dist`, add the
two `VITE_` env vars, then whitelist the domain in Google + Supabase.

---

## First sign-in & merging local data

- If you already used the app locally (data in `localStorage`) and your cloud
  account is **empty**, that local data is pushed up on first sign-in.
- If the cloud **already has** data, the cloud copy wins: local app data is cleared
  and replaced with the cloud copy (so a second device doesn't double up).
- Conflict policy is last-write-wins via `updated_at`.

---

## Notes & limits

- This is a single-user-per-account design; it's not built for multiple people
  editing the same account simultaneously.
- Screenshots are currently stored inline (data URLs) inside trade rows. If you
  store many large images, consider moving them to **Supabase Storage** later and
  keeping only URLs in the DB — happy to wire that up if needed.
- The sync layer skips a few cache/UI keys on purpose (see `SKIP_KEYS` in
  `src/sync.js`); adjust if you want those synced too.
