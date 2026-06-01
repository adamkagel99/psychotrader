import { supabase } from "./supabaseClient";

const BUCKET = "screenshots";

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

  (days || []).forEach((d) => {
    const entry = Object.assign({}, d.raw || {}, {
      date: d.date,
      pnl: Number(d.pnl) || 0,
      riskMax: d.risk_max != null ? Number(d.risk_max) : 100,
      disciplineScore: d.discipline_score,
      noTradeDay: d.no_trade_day || undefined,
      noTradeReason: d.no_trade_reason || undefined,
      commitment: d.commitment || undefined,
      trades: tradesByDay[d.date] || [],
    });
    rawSetItem("journal:" + String(d.date), JSON.stringify(entry));
  });
}

function tradeRowToApp(t) {
  // Start from the catch-all raw blob, then overlay mapped columns.
  return Object.assign({}, t.raw || {}, {
    id: t.client_id || t.id,
    status: t.status,
    pnl: t.pnl,
    pctPnl: t.pct_pnl,
    positionSize: t.position_size,
    risk: t.risk,
    instrument: t.instrument,
    direction: t.direction,
    sessionId: t.session_id,
    setup: t.setup,
    timeframe: t.timeframe,
    grade: t.grade,
    emotions: t.emotions,
    violations: t.violations,
    patterns: t.patterns,
    indicators: t.indicators,
    screenshots: t.screenshots,
    openedAt: t.opened_at,
    closedAt: t.closed_at,
    notes: t.notes,
  });
}

function appTradeToRow(t, dayDate) {
  const mapped = {
    client_id: String(t.id),
    day_date: dayDate,
    status: t.status || null,
    pnl: numOrNull(t.pnl),
    pct_pnl: numOrNull(t.pctPnl),
    position_size: numOrNull(t.positionSize),
    risk: numOrNull(t.risk),
    instrument: t.instrument || null,
    direction: t.direction || null,
    session_id: t.sessionId || null,
    setup: t.setup || null,
    timeframe: t.timeframe || null,
    grade: t.grade || null,
    emotions: t.emotions || null,
    violations: t.violations || null,
    patterns: t.patterns || null,
    indicators: t.indicators || null,
    screenshots: t.screenshots || null,
    opened_at: t.openedAt != null ? Math.round(t.openedAt) : null,
    closed_at: t.closedAt != null ? Math.round(t.closedAt) : null,
    notes: t.notes || null,
  };
  // Preserve any fields we didn't explicitly map.
  const known = new Set([
    "id","status","pnl","pctPnl","positionSize","risk","instrument","direction",
    "sessionId","setup","timeframe","grade","emotions","violations","patterns",
    "indicators","screenshots","openedAt","closedAt","notes",
  ]);
  const raw = {};
  Object.keys(t || {}).forEach((k) => { if (!known.has(k)) raw[k] = t[k]; });
  mapped.raw = raw;
  return mapped;
}

function numOrNull(v) {
  if (v === "" || v == null) return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// ------------------------------------------------------------
// PUSH: flush queued local writes up to the cloud
// ------------------------------------------------------------
async function flush() {
  flushTimer = null;
  if (!currentUserId || pending.size === 0) return;
  const batch = Array.from(pending.entries());
  pending.clear();

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

    await supabase.from("journal_days").upsert(
      {
        user_id: uid,
        date,
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

    // Replace this day's trades.
    await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", date);
    const rows = (entry.trades || []).map((t) =>
      Object.assign({ user_id: uid }, appTradeToRow(t, date))
    );
    if (rows.length) {
      await supabase.from("trades").upsert(rows, { onConflict: "user_id,client_id" });
    }
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
    await supabase.from("journal_days").delete().eq("user_id", uid).eq("date", date);
    await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", date);
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
    if (isJournalKey(k) || (typeof k === "string" && k.startsWith("tf-"))) keys.push(k);
  }
  keys.forEach((k) => rawRemove.call(window.localStorage, k));
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
  // Temporarily stash into a module var the handlers read from localStorage; to keep
  // things simple we write to localStorage if possible, else parse inline for journals.
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
    await supabase.from("journal_days").upsert({
      user_id: uid, date,
      pnl: numOrNull(entry.pnl) || 0,
      risk_max: numOrNull(entry.riskMax),
      discipline_score: numOrNull(entry.disciplineScore),
      no_trade_day: !!entry.noTradeDay,
      no_trade_reason: entry.noTradeReason || null,
      commitment: entry.commitment || null,
      raw,
    }, { onConflict: "user_id,date" });
    await supabase.from("trades").delete().eq("user_id", uid).eq("day_date", date);
    const rows = (entry.trades || []).map((t) => Object.assign({ user_id: uid }, appTradeToRow(t, date)));
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
