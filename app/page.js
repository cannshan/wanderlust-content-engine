"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ContentTab from "./components/ContentTab";
import CalendarTab from "./components/CalendarTab";
import DiscoveryTab from "./components/DiscoveryTab";
import PlanningTab from "./components/PlanningTab";
import ReelVoiceoverTab from "./components/ReelVoiceoverTab";
import ProfileTab from "./components/ProfileTab";
import MonthlySpend from "./components/MonthlySpend";

const TABS = [
  { key: "discovery", label: "Discovery" },
  { key: "planning", label: "Planning" },
  { key: "content", label: "Content" },
  { key: "calendar", label: "Calendar" },
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

      {/* Every tab stays mounted at all times now, just hidden - switching
          conditionally rendered ({activeTab === "x" && <XTab />}) unmounted
          whichever tab wasn't active, and unmounting killed that tab's
          in-flight fetches' ability to ever update state again (React
          drops a state update aimed at an unmounted component instead of
          erroring, so a long Discovery/Generate call in flight looked like
          it silently stopped - the request itself was still running
          server-side, but there was no live component left to receive the
          result when it finished). `hidden` is the plain HTML attribute,
          not a class - the browser's own UA stylesheet already treats
          `[hidden]` as `display: none`, no extra CSS needed, and it's
          automatically removed from the accessibility tree/tab order, so
          a hidden tab's inputs don't intercept focus or clicks. The real
          request lifecycle is now: keeps running regardless of which tab
          is visible, ends only if the browser tab/window actually closes -
          exactly the intended behavior. */}
      <div className="tab-panels">
        <div className="tab-panel" hidden={activeTab !== "content"}>
          <ContentTab />
        </div>
        {/* `active` is passed rather than read from context because
            CalendarTab needs to know when it's been opened, not just
            that it exists - it refetches then, so a date set over on
            Content shows up here without a page reload. */}
        <div className="tab-panel" hidden={activeTab !== "calendar"}>
          <CalendarTab active={activeTab === "calendar"} />
        </div>
        <div className="tab-panel" hidden={activeTab !== "discovery"}>
          <DiscoveryTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "planning"}>
          <PlanningTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "reel-voiceover"}>
          <ReelVoiceoverTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "profile"}>
          <ProfileTab />
        </div>
      </div>
    </div>
  );
}
