"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // The whole page is one small centered card - there's never a genuine
  // need to scroll here, so lock it while this page is mounted. Scoped
  // to a body class (not a global overflow:hidden in globals.css) so it
  // reverts automatically the moment the real app - which does need to
  // scroll - takes over after a successful login.
  useEffect(() => {
    document.body.classList.add("no-scroll");
    return () => document.body.classList.remove("no-scroll");
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      // A non-JSON reply (proxy error, timeout) would otherwise surface as
      // a raw "Unexpected token" message.
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) throw new Error(data?.error || "Couldn't sign in just now. Try again.");
      router.push(params.get("next") || "/");
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-shell">
      <h1 className="login-wordmark">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/wordmark.png" alt="Wine Wilderness Wanderlust" width={1022} height={205} className="wordmark-img" />
        <span className="login-subtitle">Wander HQ</span>
      </h1>
      <form onSubmit={onSubmit} className="card">
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={loading || !password}>
          {loading ? "Checking…" : "Enter"}
        </button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
