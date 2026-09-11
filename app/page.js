"use client";

import { useState } from "react";
import ContentTab from "./components/ContentTab";
import DiscoveryTab from "./components/DiscoveryTab";
import ReelVoiceoverTab from "./components/ReelVoiceoverTab";

const TABS = [
  { key: "content", label: "Content" },
  { key: "discovery", label: "Discovery" },
  { key: "reel-voiceover", label: "Reel Voiceover" },
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
    </div>
  );
}
