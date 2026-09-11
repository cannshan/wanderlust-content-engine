"use client";

import { useState } from "react";
import ContentTab from "./components/ContentTab";
import DiscoveryTab from "./components/DiscoveryTab";
import ReelVoiceoverTab from "./components/ReelVoiceoverTab";
import ProfileTab from "./components/ProfileTab";

const TABS = [
  { key: "content", label: "Content" },
  { key: "discovery", label: "Discovery" },
  { key: "reel-voiceover", label: "Reel Voiceover" },
  { key: "profile", label: "Profile" },
];

export default function Shell() {
  const [activeTab, setActiveTab] = useState("content");

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <h1>Wine Wilderness Wanderlust</h1>
        </div>
      </div>

      <div className="top-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab-btn ${activeTab === t.key ? "active" : ""}`}
            onClick={() => setActiveTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "content" && <ContentTab />}
      {activeTab === "discovery" && <DiscoveryTab />}
      {activeTab === "reel-voiceover" && <ReelVoiceoverTab />}
      {activeTab === "profile" && <ProfileTab />}
    </div>
  );
}
