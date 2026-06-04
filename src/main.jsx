import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { supabase, supabaseReady } from "./supabaseClient";
import AuthGate from "./AuthGate";
import TradingApp from "./Psycho-Trader";
import {
  pullFromCloud, pushAllLocal, startSync, stopSync,
  cloudHasData, clearLocalAppData, localHasData, backgroundPull,
} from "./sync";

function Splash({ text }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", color: "#64748b",
      fontFamily: "-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
      {text}
    </div>
  );
}

function Root() {
  const [phase, setPhase] = useState("loading"); // loading | auth | syncing | ready
  const [session, setSession] = useState(null);
  const [syncTick, setSyncTick] = useState(0);

  const hydrate = useCallback(async (userId) => {
    // load-instantly model. If this device already has local data, render the app
    // immediately and refresh from the cloud in the background (no blocking "Syncing…" splash).
    // Only the genuine first sign-in on an empty device blocks while we set up.
    if (localHasData()) {
      startSync(userId);
      setPhase("ready");
      // background refresh; bump a key so the app re-reads localStorage when it lands
      backgroundPull(userId).then(function (ok) {
        if (ok) setSyncTick(function (t) { return t + 1; });
      });
      return;
    }
    // First-time device: decide source of truth, then render.
    setPhase("syncing");
    const hasCloud = await cloudHasData(userId).catch(() => true);
    if (!hasCloud) {
      await pushAllLocal(userId).catch((e) => console.error(e));
    } else {
      clearLocalAppData();
      await pullFromCloud(userId).catch((e) => console.error(e));
    }
    startSync(userId);
    setPhase("ready");
  }, []);

  useEffect(() => {
    if (!supabaseReady) { setPhase("auth"); return; }
    supabase.auth.getSession().then(({ data }) => {
      const s = data.session;
      setSession(s);
      if (s) hydrate(s.user.id);
      else setPhase("auth");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) hydrate(s.user.id);
      else { stopSync(); setPhase("auth"); }
    });
    return () => sub.subscription.unsubscribe();
  }, [hydrate]);

  // CHANGED: handler now passed into the app and rendered inside Settings, no floating header button.
  const handleSignOut = useCallback(async () => {
    stopSync();
    await supabase.auth.signOut();
  }, []);

  if (!supabaseReady) {
    return (
      <Splash text="Supabase not configured — add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env" />
    );
  }
  if (phase === "loading") return <Splash text="Loading…" />;
  if (phase === "auth" || !session) return <AuthGate />;
  if (phase === "syncing") return <Splash text="Syncing your data…" />;
  return (
    /* key includes syncTick so a completed background pull re-mounts the app to show fresh data */
    <TradingApp
      key={session.user.id + ":" + syncTick}
      onSignOut={handleSignOut}
    />
  );
}

createRoot(document.getElementById("root")).render(<Root />);
