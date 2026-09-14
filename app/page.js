"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ContentTab from "./components/ContentTab";
import DiscoveryTab from "./components/DiscoveryTab";
import PlanningTab from "./components/PlanningTab";
import ReelVoiceoverTab from "./components/ReelVoiceoverTab";
import ProfileTab from "./components/ProfileTab";
import MonthlySpend from "./components/MonthlySpend";

const TABS = [
  { key: "discovery", label: "Discovery" },
  { key: "planning", label: "Planning" },
  { key: "content", label: "Content" },
  { key: "reel-voiceover", label: "Reel Voiceover" },
  { key: "profile", label: "Profile" },
];

const ACTIVE_TAB_STORAGE_KEY = "wwwActiveTab";

export default function Shell() {
  const router = useRouter();
  // Starts on Discovery (matches server-rendered HTML, avoiding a
  // hydration mismatch), then a client-only effect below restores
  // whatever tab was open before a refresh, from localStorage.
  const [activeTab, setActiveTab] = useState("discovery");

  // Clears the auth cookie server-side, then a hard-ish redirect - not
  // just router.push, since proxy.js's own cookie check is what actually
  // decides access; router.refresh() forces it to re-run against the
  // now-cleared cookie rather than trusting stale client-side state.
  async function signOut() {
    try {
      await fetch("/api/logout", { method: "POST" });
    } finally {
      router.push("/login");
      router.refresh();
    }
  }

  useEffect(() => {
    try {
      const saved = localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
      if (saved && TABS.some((t) => t.key === saved)) setActiveTab(saved);
    } catch {
      // No persisted tab (private browsing, storage disabled) - just stays
      // on the default.
    }
  }, []);

  // Deliberately not a second useEffect watching activeTab - that raced
  // with the read effect above: on mount, this would fire with the
  // still-default "discovery" value and overwrite whatever the read
  // effect had just loaded, before its setActiveTab call could trigger a
  // re-render. Writing only in response to an explicit click sidesteps
  // that entirely - a write only ever happens because the user actually
  // changed tabs, never as a side effect of the initial render.
  function selectTab(key) {
    setActiveTab(key);
    try {
      localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, key);
    } catch {
      // Non-fatal - the tab just won't be remembered on refresh this time.
    }
  }

  return (
    <div className="shell">
      <div className="topbar">
        <button type="button" className="signout-btn" onClick={signOut}>
          Sign out
        </button>
        <div>
          <h1>Wine Wilderness Wanderlust</h1>
        </div>
        <MonthlySpend />
      </div>

      <div className="top-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab-btn ${activeTab === t.key ? "active" : ""}`}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "content" && <ContentTab />}
      {activeTab === "discovery" && <DiscoveryTab />}
      {activeTab === "planning" && <PlanningTab />}
      {activeTab === "reel-voiceover" && <ReelVoiceoverTab />}
      {activeTab === "profile" && <ProfileTab />}
    </div>
  );
}
