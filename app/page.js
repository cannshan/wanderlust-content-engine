"use client";

import ContentTab from "./components/ContentTab";

export default function Shell() {
  return (
    <div className="shell">
      <div className="topbar">
        <div>
          <h1>Wine Wilderness Wanderlust</h1>
        </div>
      </div>

      <ContentTab />
    </div>
  );
}
