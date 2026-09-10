"use client";

import { useState } from "react";
import ContentTab from "./components/ContentTab";
import DashboardTab from "./components/DashboardTab";

export default function Shell() {
  const [activeMainTab, setActiveMainTab] = useState("content");

  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <h1>Wine Wilderness Wanderlust</h1>
          <div className="main-tabs">
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "content" ? "active" : ""}`}
              onClick={() => setActiveMainTab("content")}
            >
              Content
            </button>
            <button
              type="button"
              className={`main-tab-btn ${activeMainTab === "dashboard" ? "active" : ""}`}
              onClick={() => setActiveMainTab("dashboard")}
            >
              Dashboard
            </button>
          </div>
        </div>
      </div>

      {activeMainTab === "content" ? <ContentTab /> : <DashboardTab />}
    </div>
  );
}
