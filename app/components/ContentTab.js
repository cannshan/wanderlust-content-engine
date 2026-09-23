"use client";

import { useState, useEffect, useRef } from "react";
import { PLATFORM_LABELS, PLATFORM_ORDER, CATEGORY_OPTIONS, MAX_VIDEO_FILE_BYTES } from "../../lib/constants";
import { extractVideoFrames } from "../../lib/videoFrames";
import { useCategorizedItems } from "../../lib/useCategorizedItems";
import { useDraftAutosave, useWarnBeforeLeaving } from "../../lib/useDraftAutosave";
import { CategoryFilterRow, CategorizePanel } from "./CategoryUI";
import PlanningCalendar from "./PlanningCalendar";

// Combined raw size cap across every uploaded menu photo/PDF (not per
// file) - base64 encoding inflates size by ~33%, so 4MB raw becomes
// ~5.3MB in the request body. Kept safely under Vercel's serverless
// request body limit regardless of how that 4MB is split across files.
const MAX_MENU_FILES_TOTAL_BYTES = 4 * 1024 * 1024;
// A paper menu might need a front and back photo, or separate food/
// drink shots - 3 is enough room for that without the request ballooning.
const MAX_MENU_FILES = 3;

// Same as DiscoveryTab's/PlanningTab's own version - a Google Maps search
// link rather than a model-cited source URL the app never verifies. Only
// ever passed a name here (nearby-ideas places carry DISTANCE, not AREA -
// "~8 miles, 15 min drive" isn't useful appended to a maps query the way a
// real town/neighborhood name is), which Maps resolves fine on its own.
function mapsSearchUrl(name) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}`;
}

// "Oct 15" for the sidebar's compact date chip - built from separate y/m/d
// numbers rather than `new Date(item.planned_date)` directly, since that
// parses a bare "YYYY-MM-DD" as UTC midnight, which toLocaleDateString()
// can then display as the PREVIOUS day in any negative-UTC-offset timezone
// (all of the US). Same reasoning as dateKey() in PlanningCalendar.js and
// formatShortDate() in PlanningTab.js, just in reverse.
function formatShortDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Caption + hashtags as one paste-ready block, tags on their own line at
// the end - matches how this actually gets pasted into TikTok/Instagram/
// YouTube (one field, hashtags trailing the caption), rather than two
// separate copies the user has to paste and stitch together themselves.
function descriptionWithTags(platform) {
  return platform.hashtags?.length > 0
    ? `${platform.description}\n\n${platform.hashtags.join(" ")}`
    : platform.description;
}

// Everything that gets persisted as a saved idea's `results` blob. The
// platform-agnostic extras ride along under reserved underscore keys
// rather than needing their own saved_ideas columns - none of them can
// collide with a real platform key. _research is what the generation
// already looked up (location-tag and restaurant research), kept so a
// later "Tweak this" on a reloaded idea can reuse it instead of searching
// again; _tag_suggestions is the "Who to tag" result, kept so it isn't
// paid for twice.
function resultsBlob(r) {
  return {
    ...r.platforms,
    _styling_tip: r.stylingTip ?? null,
    _footage_scene_summary: r.footageSceneSummary ?? null,
    _research: r.research ?? null,
    _tag_suggestions: r.tagSuggestions ?? null,
  };
}

// Tells apart two different results that happen to be for the same idea,
// so a slow "Who to tag"/"Tweak this" call that finishes after she's
// already moved on to another idea doesn't write into the wrong one.
function newRunId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const TAG_HOW_LABELS = {
  collab_invite: "Invite as a Collab (Instagram)",
  photo_tag: "Tag them on the reel",
  caption_mention: "@mention in the caption",
};

// A few well-matched tags beat a wall of them.
const MAX_TAG_ACCOUNTS = 5;
const REPOST_ODDS_RANK = { high: 0, medium: 1, low: 2 };

// The handle check (findTagSuggestions in lib/claude.js) runs quietly: a
// handle nothing could confirm is dropped rather than shown with a warning,
// an account left with no usable handle is dropped, and the rest are
// ordered by likely reach (the model's repost odds, then its own best-first
// order) and capped. Done at display time rather than on the server so
// lists saved before this change show the same way.
function tagAccountsToShow(tagSuggestions) {
  const usable = (check) => (check && check.status !== "unverified" ? check : null);
  return (tagSuggestions?.accounts || [])
    .map((a, i) => ({ ...a, instagram: usable(a.instagram), tiktok: usable(a.tiktok), order: i }))
    .filter((a) => a.instagram || a.tiktok)
    .sort(
      (x, y) => (REPOST_ODDS_RANK[x.repostOdds] ?? 3) - (REPOST_ODDS_RANK[y.repostOdds] ?? 3) || x.order - y.order
    )
    .slice(0, MAX_TAG_ACCOUNTS);
}

// A place can have separate food/drink/dessert menus, or a seasonal one
// alongside the regular one - 5 is generous room for that without turning
// the form into an open-ended list.
const MAX_MENU_LINKS = 5;

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data URL like "data:image/jpeg;base64,/9j/4AA...."
      // - strip the prefix, keep just the base64 payload.
      const base64 = String(reader.result).split(",")[1] || "";
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Browser-only autosave of the Content tab (see useDraftAutosave below).
// Bump the version if the saved shape ever changes in a way an
// older draft can't be read back into.
const CONTENT_DRAFT_STORAGE_KEY = "wwwContentDraft";
const CONTENT_DRAFT_VERSION = 1;

const initialForm = {
  idea: "",
  location: "",
  storyBeat: "",
  notes: "",
  lengthSeconds: 60,
};

export default function ContentTab() {
  const [form, setForm] = useState(initialForm);
  const [selectedPlatforms, setSelectedPlatforms] = useState({
    tiktok: true,
    instagram: true,
    youtube: true,
  });
  const [extras, setExtras] = useState({
    music: false,
    styling: false,
  });
  const [isRestaurant, setIsRestaurant] = useState(false);
  const [restaurantName, setRestaurantName] = useState("");
  const [menuLinks, setMenuLinks] = useState([""]);
  const [menuFiles, setMenuFiles] = useState([]);
  const [menuFileError, setMenuFileError] = useState("");
  // The finished reel, if she's already filmed it. Used to ground the
  // caption in what the video actually shows (see fetchFootageContext) -
  // it is never uploaded as a file, only sampled frames are sent.
  const [reelVideoFile, setReelVideoFile] = useState(null);
  const [reelVideoUrl, setReelVideoUrl] = useState("");
  const [reelVideoFileError, setReelVideoFileError] = useState("");
  const [videoProgress, setVideoProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState("");
  const [activeTab, setActiveTab] = useState("tiktok");
  // Which of YouTube's 3 title options is selected. Deliberately not
  // persisted with the saved idea - this is a pick-one-and-paste-it
  // choice at upload time, not a field of the post - so it resets to the
  // model's own best-first ordering whenever the shown result changes.
  const [chosenTitleIndex, setChosenTitleIndex] = useState(0);
  const [savedIdeas, setSavedIdeas] = useState([]);
  const [savedIdeasLoading, setSavedIdeasLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [nearbyCategories, setNearbyCategories] = useState(["all"]);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyResult, setNearbyResult] = useState(null);
  const [nearbyError, setNearbyError] = useState("");
  const [tagLoading, setTagLoading] = useState(false);
  const [tagError, setTagError] = useState("");
  const [copiedHandles, setCopiedHandles] = useState("");

  // "Tweak this" - plain-language feedback on a generated post.
  const [tweakText, setTweakText] = useState("");
  const [tweakAllPlatforms, setTweakAllPlatforms] = useState(true);
  const [tweakLoading, setTweakLoading] = useState(false);
  const [tweakError, setTweakError] = useState("");
  // Earlier versions of result.platforms, newest last, so a tweak that
  // made things worse can be undone. Client-only on purpose - the saved
  // idea keeps the latest version plus a log of what was asked for (see
  // `refinements` below), not every intermediate draft.
  const [tweakUndo, setTweakUndo] = useState([]);
  // A lasting preference the last tweak revealed, offered as a Profile
  // rule - never saved without her say-so.
  const [pendingLesson, setPendingLesson] = useState(null);
  const [lessonState, setLessonState] = useState(""); // "" | "saving" | "saved" | "error"

  // Latest result, readable from inside a slow async call that started
  // against an older one (see newRunId).
  const resultRef = useRef(null);
  useEffect(() => {
    resultRef.current = result;
  }, [result]);

  // Autosave (lib/useDraftAutosave.js): everything on screen that cost
  // money to generate - the result, including tweaks and Who to tag, plus
  // nearby ideas - and the form that produced it. The uploaded reel and
  // menu files can't be kept (browsers don't allow restoring a picked
  // file); everything they produced is inside the result.
  useDraftAutosave(
    CONTENT_DRAFT_STORAGE_KEY,
    {
      version: CONTENT_DRAFT_VERSION,
      form,
      selectedPlatforms,
      extras,
      isRestaurant,
      restaurantName,
      menuLinks,
      result,
      nearbyResult,
      activeTab,
    },
    (draft) => {
      if (draft.version !== CONTENT_DRAFT_VERSION) return;
      if (draft.form) setForm({ ...initialForm, ...draft.form });
      if (draft.selectedPlatforms) setSelectedPlatforms(draft.selectedPlatforms);
      if (draft.extras) setExtras(draft.extras);
      setIsRestaurant(!!draft.isRestaurant);
      setRestaurantName(draft.restaurantName || "");
      if (Array.isArray(draft.menuLinks) && draft.menuLinks.length) setMenuLinks(draft.menuLinks);
      if (draft.result) setResult(draft.result);
      if (draft.nearbyResult) setNearbyResult(draft.nearbyResult);
      if (draft.activeTab) setActiveTab(draft.activeTab);
    }
  );
  useWarnBeforeLeaving(loading || !!tagLoading || tweakLoading || nearbyLoading);

  // The month calendar (PlanningCalendar.js, moved here from the Planning
  // tab - places to go don't need a content calendar, but scheduling when
  // a saved idea goes out does) is hidden until the button next to
  // "Content" above the form opens it, then renders as its own full-width
  // block above the whole two-column layout - a real month grid needs more
  // width than either the form or the 280px sidebar has room for. Starts
  // on the current real month, not tied to whatever month a saved idea's
  // planned_date falls in.
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarDate, setCalendarDate] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
  });

  function calendarPrevMonth() {
    setCalendarDate((d) => (d.month === 0 ? { year: d.year - 1, month: 11 } : { year: d.year, month: d.month - 1 }));
  }

  function calendarNextMonth() {
    setCalendarDate((d) => (d.month === 11 ? { year: d.year + 1, month: 0 } : { year: d.year, month: d.month + 1 }));
  }

  const {
    categorizingId,
    newCategoryDraft,
    setNewCategoryDraft,
    categoryFilter,
    setCategoryFilter,
    allCategories,
    filteredItems: filteredSavedIdeas,
    toggleCategorize,
    applyCategory,
    submitNewCategory,
  } = useCategorizedItems(savedIdeas, setSavedIdeas, "/api/ideas");

  // Plain scheduling notes from the Calendar tab (already-made content
  // that only needed a post date). Shown here so this calendar is the
  // whole schedule rather than only the half of it that came out of this
  // tab - they're read-only here, since adding and removing them belongs
  // where they're created.
  const [calendarNotes, setCalendarNotes] = useState([]);

  useEffect(() => {
    loadSavedIdeas();
    loadCalendarNotes();
  }, []);

  async function loadCalendarNotes() {
    try {
      const res = await fetch("/api/calendar-items");
      if (res.ok) {
        const data = await res.json();
        setCalendarNotes(data.items || []);
      }
    } catch {
      // Calendar just shows saved ideas alone - nothing else breaks.
    }
  }

  async function loadSavedIdeas() {
    setSavedIdeasLoading(true);
    try {
      const res = await fetch("/api/ideas");
      if (res.ok) {
        const data = await res.json();
        const ideas = data.ideas || [];
        setSavedIdeas(ideas);
        // An autosaved result can point at a saved idea that's since been
        // deleted (here or on another device) - un-stick its "Saved" button
        // rather than showing it as saved when it no longer exists.
        setResult((r) => (r?.savedId && !ideas.some((i) => i.id === r.savedId) ? { ...r, savedId: null } : r));
      }
    } catch {
      // Sidebar just stays empty/stale - saving/generating still works.
    }
    setSavedIdeasLoading(false);
  }

  // Same optimistic-update, best-effort-PATCH pattern as PlanningTab's own
  // updatePlannedDate. Only meaningful for an idea that's actually been
  // saved (a real saved_ideas row to attach the date to) - see the
  // "Planned date" field below, which only renders once result.savedId
  // exists. date: a plain "YYYY-MM-DD" string from the <input type="date">,
  // or null to clear it.
  async function updatePlannedDate(id, date) {
    setSavedIdeas((list) => list.map((s) => (s.id === id ? { ...s, planned_date: date } : s)));
    try {
      await fetch(`/api/ideas/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plannedDate: date }),
      });
    } catch {
      // Degrades the same way every other best-effort write in this app does.
    }
  }

  async function saveCurrentResult() {
    if (!result || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...result.formSnapshot,
          platforms: result.attempted,
          results: resultsBlob(result),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSavedIdeas((list) => [data.savedIdea, ...list]);
        setResult((r) => ({ ...r, savedId: data.savedIdea.id }));
      }
    } catch {
      // Leaves the Save button active so they can just try again.
    }
    setSaving(false);
  }

  function loadSavedIdea(saved) {
    const {
      _styling_tip: stylingTip,
      _footage_scene_summary: footageSceneSummary,
      _research: research,
      _tag_suggestions: tagSuggestions,
      ...platformResults
    } = saved.results || {};

    setForm({
      idea: saved.idea,
      location: saved.location,
      storyBeat: saved.story_beat || "",
      notes: saved.notes || "",
      lengthSeconds: saved.length_seconds,
    });
    setSelectedPlatforms({
      tiktok: saved.platforms.includes("tiktok"),
      instagram: saved.platforms.includes("instagram"),
      youtube: saved.platforms.includes("youtube"),
    });
    // The menu link(s) come back too, but never the files - those were
    // never saved in the first place (see the comment on the
    // restaurant_name/menu_link insert in app/api/ideas/route.js). menu_links
    // (the array column) is the current source; menu_link (singular) is the
    // fallback for ideas saved before multiple links were supported.
    setIsRestaurant(!!saved.restaurant_name);
    setRestaurantName(saved.restaurant_name || "");
    setMenuLinks(saved.menu_links?.length ? saved.menu_links : saved.menu_link ? [saved.menu_link] : [""]);
    setMenuFiles([]);
    setMenuFileError("");
    // Same as the menu file above - the uploaded reel itself was never
    // saved (only the footage rundown it produced), so there's nothing
    // to restore here either.
    setReelVideoFile(null);
    setReelVideoFileError("");
    if (reelVideoUrl) URL.revokeObjectURL(reelVideoUrl);
    setReelVideoUrl("");
    setNearbyResult(null);
    setNearbyError("");
    resetTweakAndTagState();
    setResult({
      runId: newRunId(),
      research: research ?? null,
      tagSuggestions: tagSuggestions ?? null,
      platforms: platformResults,
      errors: {},
      attempted: saved.platforms,
      savedId: saved.id,
      stylingTip: stylingTip ?? null,
      footageSceneSummary: footageSceneSummary ?? null,
      formSnapshot: {
        idea: saved.idea,
        location: saved.location,
        storyBeat: saved.story_beat || "",
        notes: saved.notes || "",
        lengthSeconds: saved.length_seconds,
        restaurantName: saved.restaurant_name || "",
        menuLinks: saved.menu_links?.length ? saved.menu_links : saved.menu_link ? [saved.menu_link] : [],
      },
    });
    setActiveTab(saved.platforms[0]);
    setError("");
  }

  async function deleteSavedIdea(id) {
    setSavedIdeas((list) => list.filter((s) => s.id !== id));
    // If the deleted idea is the one currently on screen, the Save button
    // needs to un-stick from "Saved" - otherwise it stays disabled for a
    // result that no longer actually exists in the saved list.
    setResult((r) => (r?.savedId === id ? { ...r, savedId: null } : r));
    try {
      await fetch(`/api/ideas/${id}`, { method: "DELETE" });
    } catch {
      // Already removed from the visible list; a failed delete just means
      // it'll reappear next time the sidebar reloads, not silently lost.
    }
  }

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  function togglePlatform(p) {
    setSelectedPlatforms((s) => ({ ...s, [p]: !s[p] }));
  }

  function toggleExtra(key) {
    setExtras((e) => ({ ...e, [key]: !e[key] }));
  }

  // "All" and the specific categories are mutually exclusive - picking a
  // specific one drops "all", and clearing every specific one falls back
  // to "all" rather than leaving nothing selected (an empty selection
  // would be ambiguous with "search nothing").
  function toggleNearbyCategory(key) {
    setNearbyCategories((current) => {
      if (key === "all") return ["all"];
      const withoutAll = current.filter((c) => c !== "all");
      const next = withoutAll.includes(key)
        ? withoutAll.filter((c) => c !== key)
        : [...withoutAll, key];
      return next.length === 0 ? ["all"] : next;
    });
  }

  async function findNearbyIdeas() {
    if (!result?.formSnapshot || nearbyLoading) return;
    setNearbyLoading(true);
    setNearbyError("");
    try {
      const res = await fetch("/api/nearby-ideas", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idea: result.formSnapshot.idea,
          location: result.formSnapshot.location,
          storyBeat: result.formSnapshot.storyBeat,
          categories: nearbyCategories,
        }),
      });
      // Same reasoning as generateOne() above - a non-JSON body means the
      // platform killed the request (almost always a timeout on "all
      // categories"), not an application error.
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Request timed out or failed before completing. Try again, or narrow the categories.");
      }
      if (!res.ok) throw new Error(data.error || "Couldn't find nearby ideas.");
      setNearbyResult(data.nearbyIdeas);
    } catch (err) {
      setNearbyError(err.message || "Couldn't find nearby ideas.");
    }
    setNearbyLoading(false);
  }

  // Files accumulate across picks (each pick's FileList replaces the
  // native input's own selection, so this app keeps its own list instead
  // and resets the input each time so picking again - even the same file -
  // still fires onChange).
  function handleMenuFilesChange(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = "";
    if (picked.length === 0) return;
    setMenuFiles((current) => {
      if (current.length >= MAX_MENU_FILES) {
        setMenuFileError(`Up to ${MAX_MENU_FILES} files - remove one first.`);
        return current;
      }
      const combined = [...current, ...picked].slice(0, MAX_MENU_FILES);
      const totalBytes = combined.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > MAX_MENU_FILES_TOTAL_BYTES) {
        setMenuFileError("Those add up to more than 4MB total - try smaller photos, fewer files, or a PDF instead.");
        return current;
      }
      setMenuFileError("");
      return combined;
    });
  }

  function removeMenuFile(index) {
    setMenuFiles((files) => files.filter((_, i) => i !== index));
    setMenuFileError("");
  }

  function updateMenuLink(index, value) {
    setMenuLinks((links) => links.map((l, i) => (i === index ? value : l)));
  }

  function addMenuLink() {
    setMenuLinks((links) => (links.length >= MAX_MENU_LINKS ? links : [...links, ""]));
  }

  // Always leaves at least one (empty) field rather than an empty array -
  // there should always be a link input visible to type into.
  function removeMenuLink(index) {
    setMenuLinks((links) => {
      const next = links.filter((_, i) => i !== index);
      return next.length > 0 ? next : [""];
    });
  }

  function handleReelVideoChange(e) {
    const file = e.target.files?.[0] || null;
    if (reelVideoUrl) URL.revokeObjectURL(reelVideoUrl);
    if (!file) {
      setReelVideoFile(null);
      setReelVideoUrl("");
      return;
    }
    if (file.size > MAX_VIDEO_FILE_BYTES) {
      setReelVideoFileError("That file's too big - please use something under 300MB.");
      setReelVideoFile(null);
      setReelVideoUrl("");
      e.target.value = "";
      return;
    }
    setReelVideoFileError("");
    setReelVideoFile(file);
    setReelVideoUrl(URL.createObjectURL(file));
  }

  const platformsToGenerate = PLATFORM_ORDER.filter((p) => selectedPlatforms[p]);

  async function generateOne(platformName, restaurantContext, locationContext, footageContext) {
    const res = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        platform: platformName,
        restaurantContext,
        locationContext,
        footageContext,
        includeMusic: extras.music,
      }),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      // A non-JSON body means the platform (Vercel) killed the request
      // before our own code could respond - most likely the function
      // timeout, not an application error.
      throw new Error("Request timed out or failed before completing. Try again.");
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (platformsToGenerate.length === 0) return;

    // Captured now, not read from `form` later - the form stays editable
    // while a generation is in flight, and Save needs to persist what was
    // actually generated, not whatever the fields currently hold. The menu
    // links ride along the same way (see saveCurrentResult) - the uploaded
    // file itself deliberately doesn't, nothing to snapshot there.
    const trimmedMenuLinks = menuLinks.map((l) => l.trim()).filter(Boolean);
    const formSnapshot = {
      ...form,
      restaurantName: isRestaurant ? restaurantName.trim() : "",
      menuLinks: isRestaurant ? trimmedMenuLinks : [],
    };

    setLoading(true);
    setError("");
    setResult(null);
    setActiveTab(platformsToGenerate[0]);
    // A fresh generation means a new location - last run's nearby-ideas
    // search no longer applies to it.
    setNearbyResult(null);
    setNearbyError("");
    resetTweakAndTagState();

    // Neither the restaurant check nor the location-tag search varies by
    // platform (a menu and a place's real-world popularity don't change
    // based on which app it's posted to), so both run once here, in
    // parallel with each other, and get passed into every platform
    // request below - instead of each platform's own /api/generate call
    // repeating the same live read/search.
    async function fetchContext(path, body) {
      try {
        const res = await fetch(path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        return await res.json();
      } catch {
        // Degrades silently, same as if the check had found nothing -
        // generation still proceeds, just without that grounding.
        return null;
      }
    }

    // The restaurant check is opt-in via the checkbox now, not
    // auto-detected - only fires (and only reads the uploaded menu files,
    // which need converting to base64 first) when isRestaurant is on and
    // a restaurant name was actually given. Styling is opt-in the same
    // way. Neither adds a request at all when its toggle is off.
    const menuFilesData = await Promise.all(
      menuFiles.map(async (f) => ({ base64: await fileToBase64(f), mediaType: f.type }))
    );

    // If she's already filmed it, the caption should describe THAT video
    // rather than the idea typed before filming. Frame extraction happens
    // entirely in the browser (see lib/videoFrames.js), then the frames
    // are sent once here and the resulting rundown is shared across every
    // platform's request - same pre-fetch-and-share pattern as
    // restaurantContext/locationContext below, since what's on screen
    // doesn't change per platform.
    async function fetchFootageContext() {
      if (!reelVideoFile) return null;
      try {
        setVideoProgress({ done: 0, total: 0 });
        const { frames, durationSeconds } = await extractVideoFrames(reelVideoFile, (done, total) =>
          setVideoProgress({ done, total })
        );
        setVideoProgress(null);
        return await fetchContext("/api/reel-footage", {
          frames,
          durationSeconds,
          idea: form.idea,
          location: form.location,
          notes: form.notes,
        });
      } catch {
        // Same silent-degrade rule as fetchContext's own catch - a
        // caption written from the idea alone is still a real result, so
        // this never blocks generation.
        setVideoProgress(null);
        return null;
      }
    }

    const [restaurantData, locationData, stylingData, footageData] = await Promise.all([
      isRestaurant && restaurantName.trim()
        ? fetchContext("/api/restaurant-check", {
            restaurantName: restaurantName.trim(),
            location: form.location,
            idea: form.idea,
            storyBeat: form.storyBeat,
            menuLinks: trimmedMenuLinks,
            menuFiles: menuFilesData,
          })
        : Promise.resolve(null),
      fetchContext("/api/location-search", {
        idea: form.idea,
        location: form.location,
        storyBeat: form.storyBeat,
      }),
      extras.styling
        ? fetchContext("/api/styling", {
            idea: form.idea,
            location: form.location,
            storyBeat: form.storyBeat,
          })
        : Promise.resolve(null),
      fetchFootageContext(),
    ]);
    const restaurantContext = restaurantData?.restaurantContext ?? null;
    const locationContext = locationData?.locationContext ?? null;
    const stylingTip = stylingData?.stylingTip ?? null;
    const footageSceneSummary = footageData?.sceneSummary ?? null;
    // Handed to every platform's call as one plain block of beats - the
    // same rundown shown under "What Claude saw" below, so what grounded
    // the caption is exactly what she can read and check it against.
    const footageContext = footageSceneSummary?.length ? footageSceneSummary.join("\n") : null;

    // Independent, parallel requests, one per selected platform - each
    // platform's generation is faster and more reliable on its own than
    // one combined call (a combined version routinely hit Vercel's
    // function timeout in testing). Every platform gets the same footage
    // rundown, since the video is the video regardless of where it goes.
    const outcomes = await Promise.allSettled(
      platformsToGenerate.map((p) => generateOne(p, restaurantContext, locationContext, footageContext))
    );

    const platforms = {};
    const errors = {};
    outcomes.forEach((outcome, i) => {
      const p = platformsToGenerate[i];
      if (outcome.status === "fulfilled") {
        platforms[p] = outcome.value;
      } else {
        errors[p] = outcome.reason?.message || "Failed to generate.";
      }
    });

    if (Object.keys(platforms).length === 0) {
      setError(
        errors[platformsToGenerate[0]] ||
          (platformsToGenerate.length > 1
            ? "All selected platforms failed to generate."
            : "Failed to generate.")
      );
    } else {
      setResult({
        runId: newRunId(),
        platforms,
        errors,
        attempted: platformsToGenerate,
        formSnapshot,
        savedId: null,
        stylingTip,
        footageSceneSummary,
        research: { locationContext, restaurantContext },
        tagSuggestions: null,
      });
    }
    setLoading(false);
  }

  function resetTweakAndTagState() {
    setTweakText("");
    setTweakError("");
    setTweakUndo([]);
    setPendingLesson(null);
    setLessonState("");
    setTagError("");
  }

  // Keeps an already-saved idea in sync after a tweak or a tag lookup, so
  // reopening it later shows the latest version. Same best-effort rule as
  // every other write here - an unsaved result just lives on screen.
  async function persistResults(next) {
    if (!next?.savedId) return;
    try {
      await fetch(`/api/ideas/${next.savedId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ results: resultsBlob(next) }),
      });
      setSavedIdeas((list) => list.map((s) => (s.id === next.savedId ? { ...s, results: resultsBlob(next) } : s)));
    } catch {
      // The on-screen version is still right; only the saved copy lags.
    }
  }

  async function findWhoToTag() {
    const current = resultRef.current;
    if (!current?.formSnapshot || tagLoading) return;
    const { runId } = current;
    setTagLoading(true);
    setTagError("");
    try {
      // The Instagram caption (or whichever platform came back first) -
      // the tagging suggestions don't vary by platform, but reading the
      // actual caption lets them match what the post really says.
      const firstPlatform = PLATFORM_ORDER.find((p) => current.platforms?.[p]);
      const res = await fetch("/api/tag-suggestions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          idea: current.formSnapshot.idea,
          location: current.formSnapshot.location,
          storyBeat: current.formSnapshot.storyBeat,
          restaurantName: current.formSnapshot.restaurantName,
          footageContext: current.footageSceneSummary?.join("\n") || null,
          description: firstPlatform ? current.platforms[firstPlatform].description : null,
        }),
      });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Request timed out or failed before completing. Try again.");
      }
      if (!res.ok) throw new Error(data.error || "Couldn't find accounts to tag.");

      const latest = resultRef.current;
      if (latest?.runId === runId) {
        const next = { ...latest, tagSuggestions: data };
        setResult(next);
        persistResults(next);
      }
    } catch (err) {
      setTagError(err.message || "Couldn't find accounts to tag.");
    }
    setTagLoading(false);
  }

  // Only handles with real evidence behind them go into the copied list -
  // an unverified one has to be checked and typed by hand, on purpose.
  function trustedHandles(network) {
    return tagAccountsToShow(result?.tagSuggestions)
      .map((a) => a[network])
      .filter(Boolean)
      .map((c) => `@${c.handle}`);
  }

  function copyTrustedHandles(network) {
    const handles = trustedHandles(network);
    if (handles.length === 0) return;
    copy(handles.join(" "), `handles-${network}`);
  }

  // Sends one platform's current post plus her feedback to /api/refine and
  // returns the updated platform object. The research the generation
  // already did travels along in `context`, so nothing is searched again.
  async function tweakOnePlatform(snapshot, platformKey, feedback) {
    const p = snapshot.platforms[platformKey];
    const res = await fetch("/api/refine", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: platformKey,
        lengthSeconds: snapshot.formSnapshot.lengthSeconds,
        feedback,
        current: {
          description: p.description,
          hashtags: p.hashtags,
          cover_text: p.cover_text,
          titles: p.titles,
          title: p.title,
        },
        priorFeedback: (p.refinements || []).map((r) => r.feedback),
        context: {
          idea: snapshot.formSnapshot.idea,
          location: snapshot.formSnapshot.location,
          storyBeat: snapshot.formSnapshot.storyBeat,
          notes: snapshot.formSnapshot.notes,
          footageContext: snapshot.footageSceneSummary?.join("\n") || null,
          locationContext: snapshot.research?.locationContext || null,
          restaurantContext: snapshot.research?.restaurantContext || null,
        },
      }),
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Request timed out or failed before completing. Try again.");
    }
    if (!res.ok) throw new Error(data.error || "Couldn't apply that tweak.");

    return {
      updated: {
        ...p,
        description: data.description,
        hashtags: data.hashtags,
        cover_text: data.coverText,
        ...(data.titles ? { titles: data.titles } : {}),
        ...(data.hashtagRationale ? { hashtag_rationale: data.hashtagRationale } : {}),
        refinements: [
          ...(p.refinements || []),
          { feedback, summary: data.changeSummary, at: new Date().toISOString() },
        ],
      },
      lesson: data.lesson,
    };
  }

  async function applyTweak() {
    const snapshot = resultRef.current;
    const feedback = tweakText.trim();
    if (!snapshot || !feedback || tweakLoading) return;

    // A factual fix ("that's not true") is wrong on every platform, so by
    // default it goes to all of them; a platform-specific style note can
    // be kept to just the one on screen.
    const available = (snapshot.attempted || []).filter((p) => snapshot.platforms?.[p]);
    const targets = (tweakAllPlatforms ? available : [activeTab]).filter((p) => available.includes(p));
    if (targets.length === 0) return;

    setTweakLoading(true);
    setTweakError("");
    setPendingLesson(null);
    setLessonState("");

    const outcomes = await Promise.allSettled(targets.map((p) => tweakOnePlatform(snapshot, p, feedback)));

    const latest = resultRef.current;
    if (latest?.runId !== snapshot.runId) {
      setTweakLoading(false);
      return;
    }

    const platforms = { ...latest.platforms };
    const failed = [];
    let lesson = "";
    outcomes.forEach((outcome, i) => {
      const p = targets[i];
      if (outcome.status === "fulfilled") {
        platforms[p] = outcome.value.updated;
        // The on-screen platform's lesson wins if more than one came back.
        if (outcome.value.lesson && (!lesson || p === activeTab)) lesson = outcome.value.lesson;
      } else {
        failed.push(`${PLATFORM_LABELS[p]}: ${outcome.reason?.message || "failed"}`);
      }
    });

    if (failed.length < targets.length) {
      setTweakUndo((stack) => [...stack.slice(-9), latest.platforms]);
      const next = { ...latest, platforms };
      setResult(next);
      persistResults(next);
      setTweakText("");
      if (lesson) setPendingLesson(lesson);
    }
    if (failed.length) setTweakError(failed.join(" · "));
    setTweakLoading(false);
  }

  function undoTweak() {
    const latest = resultRef.current;
    if (!latest || tweakUndo.length === 0) return;
    const previous = tweakUndo[tweakUndo.length - 1];
    setTweakUndo((stack) => stack.slice(0, -1));
    setPendingLesson(null);
    const next = { ...latest, platforms: previous };
    setResult(next);
    persistResults(next);
  }

  // "Learning over time": a kept lesson becomes a normal Profile rule, which
  // every future generation already follows (buildSystemPrompt in
  // lib/voiceProfile.js) and which she can edit or delete there like any
  // other rule.
  async function rememberLesson() {
    if (!pendingLesson || lessonState === "saving") return;
    setLessonState("saving");
    try {
      const res = await fetch("/api/profile-instructions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: pendingLesson }),
      });
      if (!res.ok) throw new Error();
      setLessonState("saved");
    } catch {
      setLessonState("error");
    }
  }

  function copy(text, label) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(""), 1500);
  }

  const platform = result?.platforms?.[activeTab];
  // YouTube comes back with 3 title options to choose between. Older saved
  // results predate that and have a single `title` string, so they're
  // normalised to a one-item list here rather than special-cased in the
  // markup - a saved idea from before this change still renders, it just
  // has nothing to pick between.
  const platformTitles = Array.isArray(platform?.titles)
    ? platform.titles.filter((t) => typeof t === "string" && t.trim())
    : platform?.title
    ? [platform.title]
    : [];
  // Clamped rather than reset in an effect: switching to a platform or a
  // saved idea with fewer titles than the last pick would otherwise leave
  // the index pointing past the end, and "Copy title" would copy
  // undefined. Falling back to 0 lands on the model's own best-first pick.
  const titleIndex = chosenTitleIndex < platformTitles.length ? chosenTitleIndex : 0;
  // The idea currently on screen, if it's actually been saved - source of
  // truth for its planned date (see updatePlannedDate) rather than
  // stashing a copy of it on `result` itself, so it always reflects
  // savedIdeas' current state.
  const savedIdeaForResult = result?.savedId ? savedIdeas.find((s) => s.id === result.savedId) : null;
  const tagAccounts = tagAccountsToShow(result?.tagSuggestions);

  return (
    <>
      {calendarOpen && (
        <PlanningCalendar
          items={[
            ...savedIdeas.map((s) => ({ ...s, name: s.idea })),
            ...calendarNotes.map((n) => ({ ...n, name: n.title, kind: "note" })),
          ]}
          year={calendarDate.year}
          month={calendarDate.month}
          onPrevMonth={calendarPrevMonth}
          onNextMonth={calendarNextMonth}
          onSelectItem={(id) => {
            const saved = savedIdeas.find((s) => s.id === id);
            if (saved) loadSavedIdea(saved);
          }}
          onDropItem={(item, newDate) => {
            // Notes stay read-only here (see calendarNotes above) - only a
            // saved idea's own date is draggable from this tab, through
            // the same updatePlannedDate the "Planned date" field below
            // already uses.
            if (item.kind === "note") return;
            updatePlannedDate(item.id, newDate);
          }}
          onHide={() => setCalendarOpen(false)}
        />
      )}
      <div className="layout">
      <div className="main">
      <form onSubmit={onSubmit} className="card">
        <div className="planning-heading-row">
          <h3 style={{ margin: 0 }}>Content</h3>
          {/* Open-only - hiding it again is done from the top of the
              calendar itself (see PlanningCalendar.js). */}
          {!calendarOpen && (
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                // Refetched on open, not just on mount: both tabs stay
                // mounted all session, so a note added on the Calendar
                // tab would otherwise never appear here.
                loadCalendarNotes();
                setCalendarOpen(true);
              }}
            >
              📅 Calendar
            </button>
          )}
        </div>
        <div className="field">
          <label htmlFor="idea">Idea</label>
          <input
            id="idea"
            required
            placeholder="Goat yoga at a working farm"
            value={form.idea}
            onChange={(e) => update("idea", e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="location">Location</label>
          <input
            id="location"
            required
            placeholder="Cricket Creek Farm, Williamstown, MA"
            value={form.location}
            onChange={(e) => update("location", e.target.value)}
          />
        </div>

        {/* Sits with Location rather than down in the result, because
            scheduling is part of thinking about the post, not part of
            reading its output. Only renders for an idea that's actually
            been saved - there's no saved_ideas row to hang a date on
            until then, so a brand-new idea simply doesn't show it. */}
        {savedIdeaForResult && (
          <div className="field">
            <label htmlFor="plannedDate">Planned date (optional)</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                id="plannedDate"
                type="date"
                value={savedIdeaForResult.planned_date || ""}
                onChange={(e) => updatePlannedDate(savedIdeaForResult.id, e.target.value || null)}
                style={{ flex: 1 }}
              />
              {savedIdeaForResult.planned_date && (
                <button
                  type="button"
                  className="btn-ghost"
                  style={{ flexShrink: 0 }}
                  onClick={() => updatePlannedDate(savedIdeaForResult.id, null)}
                >
                  Clear
                </button>
              )}
            </div>
            <p className="hint" style={{ marginTop: 6 }}>
              Set a date to have this show up on the calendar above.
            </p>
          </div>
        )}

        <div className="field">
          <label htmlFor="storyBeat">Story beat / detail (optional)</label>
          <textarea
            id="storyBeat"
            rows={2}
            placeholder="Baby goats climb on you mid-pose; class ends with a cheese tasting"
            value={form.storyBeat}
            onChange={(e) => update("storyBeat", e.target.value)}
          />
        </div>

        <div className="field">
          <label>Platforms to generate</label>
          <div className="platform-toggle">
            {PLATFORM_ORDER.map((p) => (
              <button
                key={p}
                type="button"
                className={`goal-option ${selectedPlatforms[p] ? "active" : ""}`}
                onClick={() => togglePlatform(p)}
                aria-pressed={selectedPlatforms[p]}
              >
                <span className="goal-title">{PLATFORM_LABELS[p]}</span>
              </button>
            ))}
          </div>
          {platformsToGenerate.length === 0 && (
            <p className="hint" style={{ marginTop: 6 }}>Pick at least one platform.</p>
          )}
        </div>

        <div className="field">
          <label>Filming extras (optional)</label>
          <div className="platform-toggle">
            <button
              type="button"
              className={`goal-option ${extras.music ? "active" : ""}`}
              onClick={() => toggleExtra("music")}
              aria-pressed={extras.music}
            >
              <span className="goal-title">Music suggestion</span>
            </button>
            <button
              type="button"
              className={`goal-option ${extras.styling ? "active" : ""}`}
              onClick={() => toggleExtra("styling")}
              aria-pressed={extras.styling}
            >
              <span className="goal-title">Styling tips</span>
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="reelVideo">Already filmed it? Upload the finished reel (optional)</label>
          <input id="reelVideo" type="file" accept="video/*" onChange={handleReelVideoChange} />
          {reelVideoFileError && (
            <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>{reelVideoFileError}</p>
          )}
          {reelVideoUrl && (
            <video src={reelVideoUrl} controls style={{ width: "100%", borderRadius: 8, maxHeight: 300, marginTop: 10 }} />
          )}
        </div>

        <div className="field">
          <label>Restaurant / bar (optional)</label>
          <button
            type="button"
            className={`goal-option ${isRestaurant ? "active" : ""}`}
            onClick={() => setIsRestaurant((v) => !v)}
            aria-pressed={isRestaurant}
            style={{ width: "100%" }}
          >
            <span className="goal-title">This post is about a restaurant/bar</span>
            <span className="goal-sub">Pulls a real menu item and restaurant-specific research into the post</span>
          </button>
        </div>

        {isRestaurant && (
          <>
            <div className="field">
              <label htmlFor="restaurantName">Restaurant name</label>
              <input
                id="restaurantName"
                required
                placeholder="Freeport Oyster Bar"
                value={restaurantName}
                onChange={(e) => setRestaurantName(e.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="menuLink0">Menu link{menuLinks.length > 1 ? "s" : ""} (optional)</label>
              {menuLinks.map((link, i) => (
                <div key={i} style={{ display: "flex", gap: 6, marginBottom: i < menuLinks.length - 1 ? 6 : 0 }}>
                  <input
                    id={i === 0 ? "menuLink0" : undefined}
                    placeholder="https://theirsite.com/menu"
                    value={link}
                    onChange={(e) => updateMenuLink(i, e.target.value)}
                  />
                  {menuLinks.length > 1 && (
                    <button
                      type="button"
                      className="btn-ghost"
                      style={{ flexShrink: 0 }}
                      onClick={() => removeMenuLink(i)}
                      aria-label="Remove this menu link"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {menuLinks.length < MAX_MENU_LINKS && (
                <button type="button" className="btn-ghost" style={{ marginTop: 8 }} onClick={addMenuLink}>
                  + Add another menu link
                </button>
              )}
              <p className="hint" style={{ marginTop: 6 }}>
                Separate menus (food, drinks, dessert, seasonal) — up to {MAX_MENU_LINKS}.
              </p>
            </div>

            <div className="field">
              <label htmlFor="menuFile">Or upload menu photos/PDFs (optional)</label>
              <input
                id="menuFile"
                type="file"
                accept="image/*,application/pdf"
                multiple
                onChange={handleMenuFilesChange}
              />
              {menuFiles.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {menuFiles.map((f, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <p className="hint" style={{ margin: 0, flex: 1 }}>{f.name}</p>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => removeMenuFile(i)}
                        aria-label="Remove this file"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {menuFileError && (
                <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>{menuFileError}</p>
              )}
            </div>
          </>
        )}

        <div className="field">
          <label>Video length (same target across platforms)</label>
          <div className="goal-toggle">
            <button
              type="button"
              className={`goal-option ${form.lengthSeconds === 60 ? "active" : ""}`}
              onClick={() => update("lengthSeconds", 60)}
            >
              <span className="goal-title">~60 seconds</span>
              <span className="goal-sub">Required for TikTok Creator Rewards to pay out</span>
            </button>
            <button
              type="button"
              className={`goal-option ${form.lengthSeconds === 30 ? "active" : ""}`}
              onClick={() => update("lengthSeconds", 30)}
            >
              <span className="goal-title">~30 seconds</span>
              <span className="goal-sub">Faster/punchier — won't earn</span>
            </button>
          </div>
        </div>

        <div className="field">
          <label htmlFor="notes">Anything to factor in (optional)</label>
          <input
            id="notes"
            placeholder="A trending hashtag, idea, or anything that is worth mentioning"
            value={form.notes}
            onChange={(e) => update("notes", e.target.value)}
          />
        </div>

        {error && <div className="error-banner">{error}</div>}

        <button className="btn-primary" disabled={loading || platformsToGenerate.length === 0}>
          {videoProgress
            ? `Watching your reel… (${videoProgress.done}/${videoProgress.total || "?"})`
            : loading
            ? "Writing…"
            : "Generate Content"}
        </button>
      </form>

      {result && (
        <div className="result card">
          <div className="result-head">
            <h3 style={{ fontSize: 16 }}>Result</h3>
            <button className="btn-ghost" onClick={saveCurrentResult} disabled={saving || !!result.savedId}>
              {result.savedId ? "Saved" : saving ? "Saving…" : "Save this idea"}
            </button>
          </div>

          {result.stylingTip && (
            <div className="field" style={{ marginBottom: 20 }}>
              <label>Styling tip (same for every platform)</label>
              <p className="rationale">{result.stylingTip}</p>
            </div>
          )}

          {result.footageSceneSummary?.length > 0 && (
            <div className="field" style={{ marginBottom: 20 }}>
              <label>What Claude saw in your footage</label>
              <ul className="shotlist">
                {result.footageSceneSummary.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <p className="hint" style={{ marginTop: 6 }}>
                This is what every caption below was written from — check it against your actual footage. If
                a beat here is wrong, the caption built on it will be too.
              </p>
            </div>
          )}

          <div className="tabs">
            {(result.attempted || PLATFORM_ORDER).map((p) => (
              <button
                key={p}
                type="button"
                className={`tab-btn ${activeTab === p ? "active" : ""}`}
                onClick={() => setActiveTab(p)}
              >
                {PLATFORM_LABELS[p]}
                {result.errors?.[p] && !result.platforms?.[p] && " ⚠"}
              </button>
            ))}
          </div>

          {!platform && result.errors?.[activeTab] && (
            <div className="error-banner">
              {PLATFORM_LABELS[activeTab]} generation failed: {result.errors[activeTab]}
            </div>
          )}

          {platform && (
            <>
              {platformTitles.length > 0 && (
                <div className="field">
                  <label>{platformTitles.length > 1 ? "Title (pick one)" : "Title"}</label>
                  {/* A lone title (every result saved before YouTube
                      started returning 3) is output to read, not a choice
                      to make - rendering it as a selected option would
                      dress up a result that never had alternatives. */}
                  {platformTitles.length === 1 ? (
                    <div className="description-box">{platformTitles[0]}</div>
                  ) : (
                    platformTitles.map((t, i) => (
                      <button
                        key={i}
                        type="button"
                        className={`title-option ${i === titleIndex ? "active" : ""}`}
                        onClick={() => setChosenTitleIndex(i)}
                        aria-pressed={i === titleIndex}
                      >
                        {t}
                      </button>
                    ))
                  )}
                  <button className="btn-ghost" onClick={() => copy(platformTitles[titleIndex], "title")}>
                    {copied === "title" ? "Copied" : "Copy title"}
                  </button>
                </div>
              )}

              <div className="description-box">{descriptionWithTags(platform)}</div>
              <button
                className="btn-ghost"
                onClick={() => copy(descriptionWithTags(platform), "description")}
                style={{ marginBottom: 20 }}
              >
                {copied === "description" ? "Copied" : "Copy description"}
              </button>

              <div className="tweak-box">
                <label htmlFor="tweakText">Tweak this</label>
                <p className="hint" style={{ margin: "2px 0 8px" }}>
                  Say what's off in plain words — it edits just that part, using the research it already did (no
                  new searching).
                </p>
                <textarea
                  id="tweakText"
                  rows={2}
                  placeholder="This is good, but the trail is 2 miles, not 5 — fix that"
                  value={tweakText}
                  onChange={(e) => setTweakText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      applyTweak();
                    }
                  }}
                />
                {(result.attempted || []).filter((p) => result.platforms?.[p]).length > 1 && (
                  <label className="tweak-all">
                    <input
                      type="checkbox"
                      checked={tweakAllPlatforms}
                      onChange={(e) => setTweakAllPlatforms(e.target.checked)}
                    />
                    Fix it on every platform (leave on for anything factual)
                  </label>
                )}
                <div className="tweak-actions">
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={applyTweak}
                    disabled={tweakLoading || !tweakText.trim()}
                  >
                    {tweakLoading ? "Tweaking…" : "Apply tweak"}
                  </button>
                  {tweakUndo.length > 0 && !tweakLoading && (
                    <button type="button" className="btn-ghost" onClick={undoTweak}>
                      Undo last tweak
                    </button>
                  )}
                </div>
                {tweakError && <div className="error-banner" style={{ marginTop: 10 }}>{tweakError}</div>}

                {pendingLesson && (
                  <div className="lesson-box">
                    {lessonState === "saved" ? (
                      <p>
                        ✓ Saved to your Profile rules — every future post will follow it. Edit or remove it any
                        time on the Profile tab.
                      </p>
                    ) : (
                      <>
                        <p>
                          <strong>Remember this for future posts?</strong>
                          <br />“{pendingLesson}”
                        </p>
                        <div className="tweak-actions">
                          <button
                            type="button"
                            className="btn-ghost"
                            onClick={rememberLesson}
                            disabled={lessonState === "saving"}
                          >
                            {lessonState === "saving" ? "Saving…" : "Remember"}
                          </button>
                          <button type="button" className="btn-ghost" onClick={() => setPendingLesson(null)}>
                            No, just this post
                          </button>
                        </div>
                        {lessonState === "error" && (
                          <p className="hint" style={{ color: "var(--bad)" }}>
                            Couldn't save it — add it by hand on the Profile tab.
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}

                {platform.refinements?.length > 0 && (
                  <ul className="tweak-log">
                    {platform.refinements.map((r, i) => (
                      <li key={i}>
                        <span className="tweak-log-ask">“{r.feedback}”</span>
                        {r.summary && <span className="tweak-log-change">{r.summary}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {platform.hashtag_rationale && (
                <div className="field" style={{ marginTop: 16 }}>
                  <label>Hashtags</label>
                  <p className="rationale">{platform.hashtag_rationale}</p>
                </div>
              )}

              {platform.video_length && (
                <div className="field" style={{ marginTop: 24 }}>
                  <label>Video length</label>
                  <div className="video-meta">
                    <span className="video-length-pill">{platform.video_length.target_seconds}</span>
                  </div>
                  {platform.video_length.why && (
                    <p className="rationale" style={{ marginTop: 10 }}>{platform.video_length.why}</p>
                  )}
                  {activeTab === "tiktok" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      {platform.lengthSeconds < 60
                        ? "At ~30s this won't earn from TikTok Creator Rewards (60s minimum), regardless of performance — a deliberate reach tradeoff, not an oversight."
                        : "Meets TikTok Creator Rewards' 60s minimum, so this one is monetization-eligible."}
                    </p>
                  )}
                  {activeTab === "instagram" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      Instagram Reels has no minimum length for its own monetization (Gifts on Reels) — this target is purely for completion rate.
                    </p>
                  )}
                  {activeTab === "youtube" && (
                    <p className="hint" style={{ marginTop: 8 }}>
                      YouTube Shorts has no fixed monetization floor tied to this video's length like TikTok does — Partner Program eligibility runs off overall channel watch hours and subscribers, not this individual short.
                    </p>
                  )}
                </div>
              )}

              {platform.shot_notes?.length > 0 && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Filming notes</label>
                  <ul className="shotlist">
                    {platform.shot_notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                </div>
              )}

              {platform.cover_text && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Cover / thumbnail text</label>
                  <div className="cover-suggestion">"{platform.cover_text}"</div>
                </div>
              )}

              {platform.location_tag && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Suggested location tag</label>
                  <div className="cover-suggestion">📍 {platform.location_tag}</div>
                  {platform.location_tag_why && (
                    <p className="rationale" style={{ marginTop: 10 }}>{platform.location_tag_why}</p>
                  )}
                </div>
              )}

              {platform.voiceover_script && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Voiceover script</label>
                  <div className="description-box">{platform.voiceover_script}</div>
                  <button className="btn-ghost" onClick={() => copy(platform.voiceover_script, "voiceover")}>
                    {copied === "voiceover" ? "Copied" : "Copy voiceover script"}
                  </button>
                </div>
              )}

              {platform.music_suggestion && (
                <div className="field" style={{ marginTop: 20 }}>
                  <label>Music suggestion</label>
                  <ul className="shotlist">
                    {platform.music_suggestion
                      .split("\n")
                      .map((line) => line.trim())
                      .filter(Boolean)
                      .map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div className="field" style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid var(--line)" }}>
            <label>Who to tag</label>
            <p className="hint" style={{ marginBottom: 10 }}>
              The 3–5 accounts most likely to reshare this — the place itself, whoever really owns it, the
              local tourism board, feature accounts — best first.
            </p>
            <button type="button" className="btn-ghost" onClick={findWhoToTag} disabled={tagLoading}>
              {tagLoading ? "Finding accounts…" : result.tagSuggestions ? "Check again" : "🏷️ Who to tag in this post"}
            </button>
            {tagError && <div className="error-banner" style={{ marginTop: 12 }}>{tagError}</div>}

            {result.tagSuggestions && (
              <div style={{ marginTop: 16 }}>
                {result.tagSuggestions.ownershipNote && (
                  <p className="rationale" style={{ marginBottom: 14 }}>{result.tagSuggestions.ownershipNote}</p>
                )}
                {tagAccounts.length === 0 && (
                  <p className="hint">Couldn't confirm any accounts for this one.</p>
                )}
                <div className="tag-list">
                  {tagAccounts.map((a, i) => (
                    <div className="tag-account" key={i}>
                      <div className="tag-account-head">
                        <strong>
                          {i + 1}. {a.name}
                        </strong>
                      </div>
                      {[
                        ["instagram", "Instagram", (h) => `https://www.instagram.com/${h}/`],
                        ["tiktok", "TikTok", (h) => `https://www.tiktok.com/@${h}`],
                      ].map(([key, label, profileUrl]) =>
                        a[key] ? (
                          <div className="tag-handle-row" key={key}>
                            <span className="tag-network">{label}</span>
                            <a href={profileUrl(a[key].handle)} target="_blank" rel="noopener noreferrer" className="place-link">
                              @{a[key].handle}
                            </a>
                          </div>
                        ) : null
                      )}
                      {a.why && <p className="tag-why">{a.why}</p>}
                      <p className="hint" style={{ margin: 0 }}>
                        How: {TAG_HOW_LABELS[a.how]}
                        {a.featureHashtag ? ` · they feature posts using ${a.featureHashtag}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
                <div className="tweak-actions" style={{ marginTop: 12 }}>
                  {[
                    ["instagram", "Instagram"],
                    ["tiktok", "TikTok"],
                  ]
                    .filter(([network]) => trustedHandles(network).length > 0)
                    .map(([network, label]) => (
                      <button key={network} type="button" className="btn-ghost" onClick={() => copyTrustedHandles(network)}>
                        {copied === `handles-${network}` ? "Copied" : `Copy ${label} handles`}
                      </button>
                    ))}
                </div>
                <p className="hint" style={{ marginTop: 8 }}>
                  Only accounts whose handle could be confirmed are listed.
                </p>
              </div>
            )}
          </div>

          <div
            className="field"
            style={{ marginTop: 28, paddingTop: 24, borderTop: "1px solid var(--line)" }}
          >
            <label>Nearby filming ideas (same trip, ~10 miles)</label>
            <p className="hint" style={{ marginBottom: 10 }}>
              Find other real places worth filming near {result.formSnapshot.location} so this can
              be a multi-post day instead of a single stop.
            </p>
            <div className="platform-toggle" style={{ marginBottom: 10 }}>
              <button
                type="button"
                className={`goal-option ${nearbyCategories.includes("all") ? "active" : ""}`}
                onClick={() => toggleNearbyCategory("all")}
                aria-pressed={nearbyCategories.includes("all")}
              >
                <span className="goal-title">All categories</span>
              </button>
              {CATEGORY_OPTIONS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  className={`goal-option ${nearbyCategories.includes(c.key) ? "active" : ""}`}
                  onClick={() => toggleNearbyCategory(c.key)}
                  aria-pressed={nearbyCategories.includes(c.key)}
                >
                  <span className="goal-title">{c.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="btn-ghost" onClick={findNearbyIdeas} disabled={nearbyLoading}>
              {nearbyLoading ? "Searching…" : nearbyResult ? "Search again" : "Find nearby ideas"}
            </button>

            {nearbyError && (
              <div className="error-banner" style={{ marginTop: 12 }}>
                {nearbyError}
              </div>
            )}

            {nearbyResult && (
              <div style={{ marginTop: 16 }}>
                <div style={{ marginBottom: 20 }}>
                  <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                    🔥 Already popular / proven potential
                  </p>
                  {nearbyResult.viral.length === 0 && (
                    <p className="hint">
                      Nothing with real proof of popularity turned up nearby for this category — try
                      "All categories" or check back later.
                    </p>
                  )}
                  <ul className="shotlist">
                    {nearbyResult.viral.map((place, i) => (
                      <li key={i}>
                        <a href={mapsSearchUrl(place.name)} target="_blank" rel="noopener noreferrer" className="place-link"><strong>{place.name}</strong></a>
                        {place.category ? ` — ${place.category}` : ""}
                        {place.distance ? ` (${place.distance})` : ""}
                        <br />
                        {place.why}
                        {place.angle && (
                          <>
                            <br />
                            <em>Angle: {place.angle}</em>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <p className="hint" style={{ marginBottom: 8, fontWeight: 600 }}>
                    💎 Hidden gems / overlooked
                  </p>
                  {nearbyResult.hidden.length === 0 && (
                    <p className="hint">Nothing overlooked genuinely stood out nearby for this category right now.</p>
                  )}
                  <ul className="shotlist">
                    {nearbyResult.hidden.map((place, i) => (
                      <li key={i}>
                        <a href={mapsSearchUrl(place.name)} target="_blank" rel="noopener noreferrer" className="place-link"><strong>{place.name}</strong></a>
                        {place.category ? ` — ${place.category}` : ""}
                        {place.distance ? ` (${place.distance})` : ""}
                        <br />
                        {place.why}
                        {place.angle && (
                          <>
                            <br />
                            <em>Angle: {place.angle}</em>
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <p className="hint" style={{ marginTop: 8 }}>
                  Distances are estimates pulled from search results, not GPS-verified — sanity-check
                  drive time before building the day around one.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
      </div>

      <aside className="sidebar">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Saved ideas</h3>

        <CategoryFilterRow allCategories={allCategories} categoryFilter={categoryFilter} onFilter={setCategoryFilter} />

        {savedIdeasLoading && <p className="hint">Loading…</p>}
        {!savedIdeasLoading && savedIdeas.length === 0 && (
          <p className="hint">Nothing saved yet. Generate something and hit "Save this idea" to plan ahead for the week.</p>
        )}
        {!savedIdeasLoading && savedIdeas.length > 0 && filteredSavedIdeas.length === 0 && (
          <p className="hint">Nothing saved under "{categoryFilter}" yet.</p>
        )}
        <div className="saved-list">
          {filteredSavedIdeas.map((s) => (
            <div key={s.id} className={`saved-item ${result?.savedId === s.id ? "active" : ""}`}>
              <div className="saved-item-row">
                <button type="button" className="saved-item-main" onClick={() => loadSavedIdea(s)}>
                  <div className="saved-item-idea">{s.idea}</div>
                  <div className="saved-item-chips">
                    {s.category && <span className="saved-chip category-chip">{s.category}</span>}
                    {s.planned_date && <span className="saved-chip date-chip">📅 {formatShortDate(s.planned_date)}</span>}
                    {s.platforms.map((p) => (
                      <span className="saved-chip" key={p}>{PLATFORM_LABELS[p]}</span>
                    ))}
                  </div>
                </button>
                <div className="saved-item-actions">
                  <button
                    type="button"
                    className="saved-item-categorize"
                    onClick={() => toggleCategorize(s.id)}
                  >
                    Categorize
                  </button>
                  <button
                    type="button"
                    className="saved-item-delete"
                    onClick={() => deleteSavedIdea(s.id)}
                    aria-label="Delete saved idea"
                  >
                    ×
                  </button>
                </div>
              </div>

              {categorizingId === s.id && (
                <CategorizePanel
                  item={s}
                  allCategories={allCategories}
                  newCategoryDraft={newCategoryDraft}
                  onDraftChange={setNewCategoryDraft}
                  onApply={applyCategory}
                  onSubmitNew={submitNewCategory}
                />
              )}
            </div>
          ))}
        </div>
      </aside>
      </div>
    </>
  );
}
