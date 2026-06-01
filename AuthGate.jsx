import { useState } from "react";
import { supabase } from "./supabaseClient";

const card = {
  background: "#111118",
  border: "1px solid #1e293b",
  borderRadius: 14,
  padding: 28,
  width: "100%",
  maxWidth: 380,
  boxSizing: "border-box",
};
const input = {
  width: "100%",
  padding: "11px 12px",
  background: "#0a0a0f",
  border: "1px solid #334155",
  borderRadius: 8,
  color: "#e2e8f0",
  fontSize: 14,
  fontFamily: "inherit",
  boxSizing: "border-box",
  marginBottom: 10,
};
const btn = (primary) => ({
  width: "100%",
  padding: "11px 12px",
  background: primary ? "linear-gradient(135deg,#4f46e5,#6366f1)" : "#0a0a0f",
  border: primary ? "none" : "1px solid #334155",
  borderRadius: 8,
  color: primary ? "#fff" : "#e2e8f0",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
});

export default function AuthGate() {
  const [mode, setMode] = useState("signin"); // signin | signup
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function emailAuth() {
    setBusy(true); setMsg(null);
    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMsg("Account created. If email confirmation is on, check your inbox, then sign in.");
        setMode("signin");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        // onAuthStateChange in App handles the rest.
      }
    } catch (e) {
      setMsg(e.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  async function googleAuth() {
    setMsg(null);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (error) setMsg(error.message);
  }

  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", color: "#e2e8f0",
      fontFamily: "-apple-system,BlinkMacSystemFont,system-ui,sans-serif",
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={card}>
        <div style={{ textAlign: "center", marginBottom: 22 }}>
          <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: -0.5 }}>
            Psycho <span style={{ color: "#a5b4fc" }}>Trader</span>
          </div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 4 }}>
            {mode === "signup" ? "Create your account" : "Sign in to sync your data"}
          </div>
        </div>

        <button style={{ ...btn(false), display: "flex", alignItems: "center",
          justifyContent: "center", gap: 8, marginBottom: 14 }} onClick={googleAuth}>
          <span style={{ fontSize: 16 }}>G</span> Continue with Google
        </button>

        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 14px" }}>
          <div style={{ flex: 1, height: 1, background: "#1e293b" }} />
          <span style={{ fontSize: 11, color: "#475569" }}>or</span>
          <div style={{ flex: 1, height: 1, background: "#1e293b" }} />
        </div>

        <input style={input} type="email" placeholder="Email" value={email}
          onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        <input style={input} type="password" placeholder="Password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          onKeyDown={(e) => { if (e.key === "Enter") emailAuth(); }} />

        <button style={btn(true)} disabled={busy} onClick={emailAuth}>
          {busy ? "…" : mode === "signup" ? "Sign up" : "Sign in"}
        </button>

        {msg && <div style={{ fontSize: 12, color: "#fbbf24", marginTop: 12,
          lineHeight: 1.4, textAlign: "center" }}>{msg}</div>}

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: "#64748b" }}>
          {mode === "signup" ? "Already have an account?" : "Need an account?"}{" "}
          <button onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setMsg(null); }}
            style={{ background: "none", border: "none", color: "#a5b4fc", cursor: "pointer",
              fontFamily: "inherit", fontSize: 13, fontWeight: 600, padding: 0 }}>
            {mode === "signup" ? "Sign in" : "Sign up"}
          </button>
        </div>
      </div>
    </div>
  );
}
