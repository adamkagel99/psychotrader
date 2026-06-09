import { supabase } from "./supabaseClient";

const BUCKET = "screenshots";

// CHANGED: the app stores journal dates as US "M-D-YYYY"; Postgres date columns want ISO
// "YYYY-MM-DD". Normalize on the way up so inserts never silently fail on ambiguous dates.
function appToIsoDate(d) {
  if (!d) return d;
  const s = String(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already ISO
  const m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/); // M-D-YYYY or M/D/YYYY
  if (m) {
    const mm = String(parseInt(m[1], 10)).padStart(2, "0");
    const dd = String(parseInt(m[2], 10)).padStart(2, "0");
    return m[3] + "-" + mm + "-" + dd;
  }
  return s;
}

// Convert a base64 data URL to a Blob for upload.
function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(",");
  const mime = (head.match(/data:([^;]+)/) || [])[1] || "image/jpeg";
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// Upload a data-URL screenshot; returns the storage path "userId/uuid.ext" or null.
async function uploadDataUrl(userId, dataUrl) {
  try {
    const blob = dataUrlToBlob(dataUrl);
    const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const name = `${userId}/${cryptoId()}.${ext}`;
    const { error } = await supabase.storage.from(BUCKET).upload(name, blob, {
      contentType: blob.type,
      upsert: false,
    });
    if (error) { console.error("Screenshot upload failed:", error); return null; }
    return name; // store the path; we sign it on read
  } catch (e) {
    console.error("uploadDataUrl error:", e);
    return null;
  }
}

function cryptoId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return "img-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}

// Turn a stored screenshot value into something <img src> can use.
// Storage paths -> short-lived signed URL. Already-URLs/data URLs pass through.
async function signScreenshot(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith("http") || value.startsWith("data:")) return value;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(value, 60 * 60 * 24 * 7); // 7-day URL
  if (error) { console.error("sign url failed:", error); return value; }
  return data.signedUrl;
}


// ============================================================
// Local-first sync for Psycho Trader.
//
// Strategy: the app reads/writes localStorage exactly as before.
// We (1) hydrate localStorage from the cloud on sign-in, then
// (2) monkey-patch localStorage.setItem/removeItem so every local
// write is debounced and pushed to Supabase. This means the large
// existing app needs ZERO internal changes.
//
// Mapping:
//   journal:YYYY-MM-DD  -> journal_days (+ child trades rows)
//   tf-transfers        -> transfers rows
//   everything else tf-* -> user_kv (key/value JSONB)
// ============================================================

// tf-* keys that are pure UI/cache and NOT worth syncing
const SKIP_KEYS = new Set([
  "tf-events",          // economic-events cache, refetched anyway
  "tf-aicoach-answer",
  "tf-aicoach-result",
  "tf-aicoach-question",
  "tf-progress-collapsed",
  "tf-stats-range",
]);

function isJournalKey(k) {
  return typeof k === "string" && k.startsWith("journal:");
}
function isSyncableKv(k) {
  return (
    typeof k === "string" &&
    k.startsWith("tf-") &&
    k !== "tf-transfers" &&
    !SKIP_KEYS.has(k)
  );
}

let currentUserId = null;
let patched = false;
const pending = new Map(); // key -> { type, op }
let flushTimer = null;

// ---- raw localStorage handles (captured before patching) ----
const rawSet = Storage.prototype.setItem;
const rawRemove = Storage.prototype.removeItem;

function rawSetItem(k, v) {
  rawSet.call(window.localStorage, k, v);
}

// ------------------------------------------------------------
// PULL: load all cloud data for the signed-in user into localStorage
// ------------------------------------------------------------
export async function pullFromCloud(userId) {
  currentUserId = userId;

  // 1. KV blobs
  const { data: kv } = await supabase
    .from("user_kv")
    .select("key,value")
    .eq("user_id", userId);
  (kv || []).forEach((row) => {
    if (row.value != null) rawSetItem(row.key, JSON.stringify(row.value));
  });

  // 2. Transfers
  const { data: transfers } = await supabase
    .from("transfers")
    .select("*")
    .eq("user_id", userId);
  if (transfers) {
    const arr = transfers.map((t) => ({
      id: t.client_id || t.id,
      date: t.date,
      amount: Number(t.amount),
      type: t.type,
    }));
    rawSetItem("tf-transfers", JSON.stringify(arr));
  }

  // 3. Journal days + trades -> journal:DATE blobs
  const { data: days } = await supabase
    .from("journal_days")
    .select("*")
    .eq("user_id", userId);
  const { data: trades } = await supabase
    .from("trades")
    .select("*")
    .eq("user_id", userId);

  const tradesByDay = {};
  (trades || []).forEach((t) => {
    (tradesByDay[t.day_date] = tradesByDay[t.day_date] || []).push(
      tradeRowToApp(t)
    );
  });

  // CHANGED: convert stored screenshot paths into signed URLs the app can render.
  for (const dayArr of Object.values(tradesByDay)) {
    for (const t of dayArr) {
      if (Array.isArray(t.screenshots) && t.screenshots.length) {
        const signed = [];
        for (const s of t.screenshots) signed.push(await signScreenshot(s));
        t.screenshots = signed;
      }
    }
  }

  // CHANGED: Postgres returns dates as ISO "YYYY-MM-DD". The app uses TWO formats:
  //   - the localStorage KEY is "journal:M-D-YYYY" (dashes)
  //   - the entry's internal `date` field is "M/D/YYYY" (slashes), which the calendar matches on.
  // We must rebuild BOTH correctly or days vanish after a sync.
  function isoParts(iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return { y: m[1], mo: parseInt(m[2], 10), d: parseInt(m[3], 10) };
  }
  function isoToKeyDate(iso) { const p = isoParts(iso); return p ? (p.mo + "-" + p.d + "-" + p.y) : iso; }
  function isoToInternalDate(iso) { const p = isoParts(iso); return p ? (p.mo + "/" + p.d + "/" + p.y) : iso; }

  (days || []).forEach((d) => {
    const keyDate = isoToKeyDate(d.date);
    const internalDate = isoToInternalDate(d.date);
    const cloudTrades = tradesByDay[d.date] || [];
    // CHANGED: Merge cloud trades with whatever's already in local for this day. If cloud has
    // no trades but local does, prefer local — empty cloud trades have been the legacy-corruption
    // smoking gun and we never want a background pull to wipe local trades. If both sides have
    // trades, union by client id (cloud wins on conflicts since it just came through validation).
    let mergedTrades = cloudTrades;
    try {
      const existingRaw = window.localStorage.getItem("journal:" + keyDate);
      if (existingRaw) {
        const existing = JSON.parse(existingRaw);
        const localTrades = Array.isArray(existing.trades) ? existing.trades : [];
        if (cloudTrades.length === 0 && localTrades.length > 0) {
          mergedTrades = localTrades;
        } else if (cloudTrades.length > 0 && localTrades.length > 0) {
          const byId = {};
          localTrades.forEach((t) => { if (t && t.id != null) byId[String(t.id)] = t; });
          cloudTrades.forEach((t) => { if (t && t.id != null) byId[String(t.id)] = t; });
          mergedTrades = Object.values(byId);
        }
      }
    } catch (e) { /* fall through with cloudTrades */ }

    const entry = Object.assign({}, d.raw || {}, {
      date: internalDate,
      pnl: Number(d.pnl) || 0,
      riskMax: d.risk_max != null ? Number(d.risk_max) : 100,
      disciplineScore: d.discipline_score,
      noTradeDay: d.no_trade_day || undefined,
      noTradeReason: d.no_trade_reason || undefined,
      commitment: d.commitment || undefined,
      trades: mergedTrades,
    });
    rawSetItem("journal:" + keyDate, JSON.stringify(entry));
  });
}

function tradeRowToApp(t) {
  // CHANGED: Pair with the minimal-column appTradeToRow above — everything except status/pnl
  // lives in `raw`. Spread raw first, then overlay the base columns so they win on any overlap.
  return Object.assign({}, t.raw || {}, {
    id: t.client_id || t.id,
    status: t.status,
    pnl: t.pnl,
  });
}

function appTradeToRow(t, day_date) {
  // CHANGED: Minimal-safe column set. Only push the columns required for keys + the few likely
  // useful for SQL-level aggregations (pnl, status). Everything else — including times, setup,
  // direction, indicators, screenshots, etc. — goes into `raw`. This trades fine-grained SQL
  // queryability for schema robustness: the upsert no longer 400s on missing columns.
  return {
    client_id: String(t.id != null ? t.id : (day_date + "-" + Math.random().toString(36).slice(2))),
    day_date,
    status: t.status || null,
    pnl: numOrNull(t.pnl),
    raw: stripBaseTradeFields(t),
  };
}

function stripBaseTradeFields(t) {
  const known = new Set(["id","status","pnl"]);
  const r = {};
  Object.keys(t || {}).forEach((k) => { if (!known.has(k)) r[k] = t[k]; });
  return r;
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------
// PUSH: debounced flush of pending writes to Supabase
// ------------------------------------------------------------
async function flush() {
  if (!currentUserId) { flushTimer = null; return; }
  const batch = [...pending.entries()];
  pending.clear();
  flushTimer = null;

  for (const [key, info] of batch) {
    try {
      if (info.op === "remove") {
        await handleRemove(key);
      } else {
        await handleSet(key);
      }
    } catch (e) {
      console.error("Sync push failed for", key, e);
    }
  }
}

async function handleSet(key) {
  const uid = currentUserId;
  const rawVal = window.localStorage.getItem(key);
  if (rawVal == null) return;

  if (isJournalKey(key)) {
    const date = key.slice("journal:".length);
    let entry;
    try { entry = JSON.parse(rawVal); } catch { return; }

    // CHANGED: upload any base64 screenshots to Storage and replace them with
    // storage paths BEFORE saving — keeps localStorage small and avoids quota.
    let mutated = false;
    if (Array.isArray(entry.trades)) {
      for (const t of entry.trades) {
        if (Array.isArray(t.screenshots) && t.screenshots.length) {
          const out = [];
          for (const s of t.screenshots) {
            if (typeof s === "string" && s.startsWith("data:")) {
              const path = await uploadDataUrl(uid, s);
              out.push(path || s); // fall back to keeping inline if upload failed
              if (path) mutated = true;
            } else {
              out.push(s);
            }
          }
          t.screenshots = out;
        }
      }
    }
    // Persist the rewritten (path-based) entry locally so the heavy base64 is gone.
    if (mutated) {
      try { rawSetItem(key, JSON.stringify(entry)); } catch (e) { /* ignore */ }
    }

    const known = new Set([
      "date","pnl","riskMax","disciplineScore","noTradeDay","noTradeReason","commitment","trades",
    ]);
    const raw = {};
    Object.keys(entry || {}).forEach((k) => { if (!known.has(k)) raw[k] = entry[k]; });

    const isoDate = appToIsoDate(date);
    await supabase.from("journal_days").upsert(
      {
        user_id: uid,
        date: isoDate,
        pnl: numOrNull(entry.pnl) || 0,
        risk_max: numOrNull(entry.riskMax),
        discipline_score: numOrNull(entry.disciplineScore),
        no_trade_day: !!entry.noTradeDay,
        no_trade_reason: entry.noTradeReason || null,
        commitment: entry.commitment || null,
        raw,
      },
      { onConflict: "user_id,date" }
    );

    // CHANGED: DESTRUCTIVE-DELETE GUARD.
    // Previously we ALWAYS deleted this day's trades and re-upserted from the local entry.
    // If the local entry's trades array was empty (legacy rollover bug, stale state, race
    // between background pull and auto-save, etc.) the delete fired but no insert followed —
    // wiping the trades from Supabase even though the user never asked to clear them.
    //
    // New rule: only touch the cloud trades when EITHER
    //   (a) the local entry has at least one trade to push (delete-then-replace pattern), OR
    //   (b) the day is explicitly marked as a "no-trade day" (intentional clear).
    // Otherwise we leave the cloud trades alone — empty local trades are treated as "no
    // information", not "user cleared the day".
    const localTrades = Array.isArray(entry.trades) ? entry.trades : [];
    if (localTrades.length > 0) {
      await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", isoDate);
      const rows = localTrades.map((t) =>
        Object.assign({ user_id: uid }, appTradeToRow(t, isoDate))
      );
      await supabase.from("trades").upsert(rows, { onConflict: "user_id,client_id" });
    } else if (entry.noTradeDay === true) {
      // User explicitly marked a no-trade day; clear any prior trades for that date.
      await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", isoDate);
    }
    // else: preserve cloud trades. If the user genuinely wants to delete trades, they can
    // remove individual trades (which fires per-trade sync) or remove the whole journal day.
    return;
  }

  if (key === "tf-transfers") {
    let arr;
    try { arr = JSON.parse(rawVal); } catch { return; }
    if (!Array.isArray(arr)) return;
    await supabase.from("transfers").delete().eq("user_id", uid);
    const rows = arr.map((t) => ({
      user_id: uid,
      client_id: String(t.id != null ? t.id : (t.date + "-" + t.amount)),
      date: t.date || null,
      amount: numOrNull(t.amount) || 0,
      type: t.type || "deposit",
    }));
    if (rows.length) {
      await supabase.from("transfers").upsert(rows, { onConflict: "user_id,client_id" });
    }
    return;
  }

  if (isSyncableKv(key)) {
    let value;
    try { value = JSON.parse(rawVal); } catch { value = rawVal; }
    await supabase
      .from("user_kv")
      .upsert({ user_id: uid, key, value }, { onConflict: "user_id,key" });
  }
}

async function handleRemove(key) {
  const uid = currentUserId;
  if (isJournalKey(key)) {
    const date = key.slice("journal:".length);
    const isoDate = appToIsoDate(date);
    await supabase.from("journal_days").delete().eq("user_id", uid).eq("date", isoDate);
    await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", isoDate);
  } else if (key === "tf-transfers") {
    await supabase.from("transfers").delete().eq("user_id", uid);
  } else if (isSyncableKv(key)) {
    await supabase.from("user_kv").delete().eq("user_id", uid).eq("key", key);
  }
}

function queue(key, op) {
  if (!currentUserId) return;
  if (!(isJournalKey(key) || key === "tf-transfers" || isSyncableKv(key))) return;
  pending.set(key, { op });
  if (!flushTimer) flushTimer = setTimeout(flush, 800); // debounce
}

// ------------------------------------------------------------
// Patch localStorage so the existing app syncs transparently.
// ------------------------------------------------------------
export function startSync(userId) {
  currentUserId = userId;
  if (patched) return;
  patched = true;

  Storage.prototype.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (this === window.localStorage) queue(k, "set");
  };
  Storage.prototype.removeItem = function (k) {
    rawRemove.call(this, k);
    if (this === window.localStorage) queue(k, "remove");
  };
}

export function stopSync() {
  currentUserId = null;
  pending.clear();
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
}

// One-time push of whatever is already in localStorage (first sign-in
// on a device that already has local data). Call AFTER deciding the
// local copy should win (e.g. cloud is empty).
export async function pushAllLocal(userId) {
  currentUserId = userId;
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (isJournalKey(k) || k === "tf-transfers" || isSyncableKv(k)) {
      await handleSet(k);
    }
  }
}

// Has this user got any cloud data yet?
export async function cloudHasData(userId) {
  const { count } = await supabase
    .from("journal_days")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  if (count && count > 0) return true;
  const { count: kvCount } = await supabase
    .from("user_kv")
    .select("*", { count: "exact", head: true })
    .eq("user_id", userId);
  return Boolean(kvCount && kvCount > 0);
}

export function clearLocalAppData() {
  const keys = [];
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    // CHANGED: never clear SKIP_KEYS — these are local-only caches (e.g. the economic-events
    // cache) that are intentionally not synced to the cloud. Wiping them here would delete the
    // events list on first sign-in, since the cloud never stored a copy to pull back.
    if (typeof k === "string" && SKIP_KEYS.has(k)) continue;
    if (isJournalKey(k) || (typeof k === "string" && k.startsWith("tf-"))) keys.push(k);
  }
  keys.forEach((k) => rawRemove.call(window.localStorage, k));
}

// Does this device already have the user's app data locally? Used to decide whether the
// page can render instantly (and sync in the background) vs. must block on a first pull.
export function localHasData() {
  for (let i = 0; i < window.localStorage.length; i++) {
    const k = window.localStorage.key(i);
    if (isJournalKey(k)) return true;
  }
  // settings present also counts as "has local data"
  try { if (window.localStorage.getItem("tf-settings")) return true; } catch (e) {}
  return false;
}

// Background pull: refresh local from cloud without clearing first, so the UI never blanks.
// Returns true if it completed (caller can trigger a re-render to reflect any new data).
export async function backgroundPull(userId) {
  try { await pullFromCloud(userId); return true; }
  catch (e) { console.error("Background sync failed:", e); return false; }
}

// Exposed globally so the app's Restore button can push the imported data to the
// cloud and WAIT before reloading (otherwise the debounced push is lost on reload).
if (typeof window !== "undefined") {
  // Restore: clear this user's cloud data, then push every key from the backup
  // OBJECT directly (not localStorage, which may have dropped oversized image keys).
  window.__psychoSyncRestore = async function (backup) {
    if (!currentUserId) return;
    const uid = currentUserId;
    try {
      await supabase.from("trades").delete().eq("user_id", uid);
      await supabase.from("journal_days").delete().eq("user_id", uid);
      await supabase.from("transfers").delete().eq("user_id", uid);
      await supabase.from("user_kv").delete().eq("user_id", uid);
    } catch (e) { console.error("Cloud clear before restore failed:", e); }

    for (const key of Object.keys(backup || {})) {
      if (!(isJournalKey(key) || key === "tf-transfers" || isSyncableKv(key))) continue;
      // Ensure localStorage has the value for handleSet to read; if it was dropped
      // due to quota, write the rewritten (image-stripped) version after upload.
      try { rawSetItem(key, backup[key]); } catch (e) { /* quota: handled below */ }
      try {
        await handleSetFromValue(key, backup[key], uid);
      } catch (e) {
        console.error("Restore push failed for", key, e);
      }
    }
  };

  // Back-compat alias used by older builds.
  window.__psychoSyncPushAll = async function () {
    if (!currentUserId) return;
    await pushAllLocal(currentUserId);
  };
}

// Like handleSet but takes the raw value explicitly (used by restore so it works
// even when the value couldn't be stored in localStorage due to quota).
async function handleSetFromValue(key, rawVal, uid) {
  const prevUser = currentUserId;
  currentUserId = uid;
  if (isJournalKey(key)) {
    let entry;
    try { entry = JSON.parse(rawVal); } catch { currentUserId = prevUser; return; }
    const date = key.slice("journal:".length);
    // upload images
    if (Array.isArray(entry.trades)) {
      for (const t of entry.trades) {
        if (Array.isArray(t.screenshots) && t.screenshots.length) {
          const out = [];
          for (const s of t.screenshots) {
            if (typeof s === "string" && s.startsWith("data:")) {
              const path = await uploadDataUrl(uid, s);
              out.push(path || s);
            } else out.push(s);
          }
          t.screenshots = out;
        }
      }
    }
    const known = new Set(["date","pnl","riskMax","disciplineScore","noTradeDay","noTradeReason","commitment","trades"]);
    const raw = {};
    Object.keys(entry || {}).forEach((k) => { if (!known.has(k)) raw[k] = entry[k]; });
    const isoDate = appToIsoDate(date);
    await supabase.from("journal_days").upsert({
      user_id: uid, date: isoDate,
      pnl: numOrNull(entry.pnl) || 0,
      risk_max: numOrNull(entry.riskMax),
      discipline_score: numOrNull(entry.disciplineScore),
      no_trade_day: !!entry.noTradeDay,
      no_trade_reason: entry.noTradeReason || null,
      commitment: entry.commitment || null,
      raw,
    }, { onConflict: "user_id,date" });
    // CHANGED: Restore is authoritative — the backup IS the truth. Always replace.
    await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", isoDate);
    const rows = (entry.trades || []).map((t) => Object.assign({ user_id: uid }, appTradeToRow(t, isoDate)));
    if (rows.length) await supabase.from("trades").upsert(rows, { onConflict: "user_id,client_id" });
    // write the small, path-based version back to localStorage now that images are uploaded
    try { rawSetItem(key, JSON.stringify(entry)); } catch (e) { /* ignore */ }
    currentUserId = prevUser;
    return;
  }
  // transfers + kv have no images: defer to the normal handler (reads localStorage)
  await handleSet(key);
  currentUserId = prevUser;
}
