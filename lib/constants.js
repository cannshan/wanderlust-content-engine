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

// Raw file size cap on an uploaded reel - the file never leaves the
// browser (only extracted frames are sent, see lib/videoFrames.js), so
// this is purely a guard against a huge file being slow/heavy for the
// browser to decode and seek through, not a request-size concern. Shared
// by ReelVoiceoverTab and ContentTab's video-grounded voiceover upload.
export const MAX_VIDEO_FILE_BYTES = 300 * 1024 * 1024;
