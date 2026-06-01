import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { supabase, supabaseReady } from "./supabaseClient";
import AuthGate from "./AuthGate";
import TradingApp from "./TradingApp";
import {
  pullFromCloud, pushAllLocal, startSync, stopSync,
  cloudHasData, clearLocalAppData,
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

function SignOutButton() {
  return (
    <button
      onClick={async () => { stopSync(); await supabase.auth.signOut(); }}
      title="Sign out"
      style={{ position: "fixed", top: 10, right: 12, zIndex: 9999,
        background: "#111118", border: "1px solid #334155", borderRadius: 8,
        color: "#94a3b8", fontSize: 12, fontWeight: 600, padding: "6px 10px",
        cursor: "pointer", fontFamily: "inherit" }}>
      Sign out
    </button>
  );
}

function Root() {
  const [phase, setPhase] = useState("loading"); // loading | auth | syncing | ready
  const [session, setSession] = useState(null);

  const hydrate = useCallback(async (userId) => {
    setPhase("syncing");
    // First sign-in on a device that already has local data, and the cloud
    // is empty? Treat local as the source of truth and push it up.
    const hasCloud = await cloudHasData(userId).catch(() => true);
    if (!hasCloud) {
      await pushAllLocal(userId).catch((e) => console.error(e));
    } else {
      // Cloud wins: clear stale local app data, then pull the cloud copy down.
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

  if (!supabaseReady) {
    return (
      <Splash text="Supabase not configured — add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to .env" />
    );
  }
  if (phase === "loading") return <Splash text="Loading…" />;
  if (phase === "auth" || !session) return <AuthGate />;
  if (phase === "syncing") return <Splash text="Syncing your data…" />;

  return (
    <>
      <SignOutButton />
      {/* key forces a fresh mount after hydration so the app reads the synced localStorage */}
      <TradingApp key={session.user.id} />
    </>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
