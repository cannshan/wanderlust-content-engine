"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import ContentTab from "./components/ContentTab";
import CalendarTab from "./components/CalendarTab";
import DiscoveryTab from "./components/DiscoveryTab";
import CollabSearchTab from "./components/CollabSearchTab";
import PlanningTab from "./components/PlanningTab";
import ReelVoiceoverTab from "./components/ReelVoiceoverTab";
import StoriesTab from "./components/StoriesTab";
import ProfileTab from "./components/ProfileTab";

const TABS = [
  { key: "discovery", label: "Discovery" },
  { key: "planning", label: "Planning" },
  { key: "trip-calendar", label: "Trip Calendar" },
  { key: "content", label: "Content" },
  { key: "content-calendar", label: "Content Calendar" },
  { key: "reel-voiceover", label: "Reel Voiceover" },
  { key: "stories", label: "Stories" },
  { key: "collab-search", label: "Collab Search" },
  { key: "profile", label: "Profile" },
];

// On a phone, the nine tabs above don't fit in one row - they were a
// sideways-scrolling strip with most of them out of sight. Below 700px
// they're grouped behind a bottom tab bar instead (the standard phone app
// pattern), and the top row only shows the current group's own tabs. On
// wider screens nothing changes: the full row stays and this bar is
// hidden. Every tab belongs to exactly one group.
const TAB_GROUPS = [
  { key: "discover", label: "Discover", icon: "compass", tabs: ["discovery", "collab-search"] },
  { key: "plan", label: "Plan", icon: "map", tabs: ["planning", "trip-calendar"] },
  { key: "create", label: "Create", icon: "sparkle", tabs: ["content", "reel-voiceover", "stories"] },
  { key: "calendar", label: "Calendar", icon: "calendar", tabs: ["content-calendar"] },
  { key: "profile", label: "Profile", icon: "person", tabs: ["profile"] },
];

function groupOf(tabKey) {
  return TAB_GROUPS.find((g) => g.tabs.includes(tabKey)) || TAB_GROUPS[0];
}

// Simple line icons (24px grid, stroked with currentColor so they take
// the active/inactive color from CSS).
const ICON_PATHS = {
  compass: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z M15.5 8.5l-2 5-5 2 2-5 5-2Z",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z M9 4v14 M15 6v14",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  calendar: "M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z M4 10h16 M8 3v4 M16 3v4",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21a8 8 0 0 1 16 0",
};

function NavIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

const ACTIVE_TAB_STORAGE_KEY = "wwwActiveTab";

export default function Shell() {
  const router = useRouter();
  // Starts on Discovery (matches server-rendered HTML, avoiding a
  // hydration mismatch), then a client-only effect below restores
  // whatever tab was open before a refresh, from localStorage.
  const [activeTab, setActiveTab] = useState("discovery");
  // The tab last open in each group, so tapping a bottom-bar group goes
  // back to where she was in it (e.g. Stories, not always Content).
  const [lastTabByGroup, setLastTabByGroup] = useState({});
  const activeGroup = groupOf(activeTab);

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
    setLastTabByGroup((m) => ({ ...m, [groupOf(key).key]: key }));
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
        <div className="topbar-title">
          {/* Her real logo artwork (from winewildernesswanderlust.com), not
              a font imitating it - see public/brand/. */}
          <h1>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/wordmark.png" alt="Wine Wilderness Wanderlust" width={1022} height={205} className="wordmark-img" />
          </h1>
        </div>
      </div>

      {/* On a phone only the current group's tabs show here (and none for a
          one-tab group) - see TAB_GROUPS. */}
      <div className={`top-tabs ${activeGroup.tabs.length === 1 ? "single-tab-group" : ""}`}>
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab-btn ${activeTab === t.key ? "active" : ""} ${
              activeGroup.tabs.includes(t.key) ? "" : "other-group"
            }`}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <nav className="bottom-nav" aria-label="Sections">
        {TAB_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            className={`bottom-nav-btn ${activeGroup.key === g.key ? "active" : ""}`}
            aria-current={activeGroup.key === g.key ? "page" : undefined}
            onClick={() => selectTab(lastTabByGroup[g.key] || g.tabs[0])}
          >
            <NavIcon name={g.icon} />
            <span>{g.label}</span>
          </button>
        ))}
      </nav>

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
        {/* `active`/`kind` are passed rather than read from context because
            CalendarTab needs to know when it's been opened, not just that
            it exists - it refetches then, so a date set over on Content or
            Planning shows up here without a page reload. Two separate
            instances, one per kind, placed next to the tab each one's data
            comes from - Trip Calendar after Planning, Content Calendar
            after Content. */}
        <div className="tab-panel" hidden={activeTab !== "content-calendar"}>
          <CalendarTab kind="content" active={activeTab === "content-calendar"} />
        </div>
        <div className="tab-panel" hidden={activeTab !== "discovery"}>
          <DiscoveryTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "collab-search"}>
          <CollabSearchTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "planning"}>
          <PlanningTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "trip-calendar"}>
          <CalendarTab kind="trip" active={activeTab === "trip-calendar"} />
        </div>
        <div className="tab-panel" hidden={activeTab !== "reel-voiceover"}>
          <ReelVoiceoverTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "stories"}>
          <StoriesTab />
        </div>
        <div className="tab-panel" hidden={activeTab !== "profile"}>
          <ProfileTab active={activeTab === "profile"} />
        </div>
      </div>
    </div>
  );
}
