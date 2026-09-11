// Shared UI constants used across ContentTab, DiscoveryTab, and
// ReelVoiceoverTab - pulled out so all three stay in sync (e.g. the
// category list below is used both for "nearby filming ideas" inside a
// generated result and for the standalone Discovery tab).

export const PLATFORM_LABELS = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

export const PLATFORM_ORDER = ["tiktok", "instagram", "youtube"];

export const CATEGORY_OPTIONS = [
  { key: "foodie", label: "Foodie" },
  { key: "restaurants", label: "Restaurants" },
  { key: "hiking", label: "Hiking" },
  { key: "speakeasies", label: "Speakeasies / bars" },
  { key: "museums", label: "Museums" },
];
