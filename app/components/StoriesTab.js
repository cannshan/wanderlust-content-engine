"use client";

import { useState, useRef, useEffect } from "react";
import { extractVideoFrames } from "../../lib/videoFrames";
import { drawStoryOverlay, ensureStoryFontLoaded, renderStoryClips } from "../../lib/storyClips";
import { MAX_VIDEO_FILE_BYTES } from "../../lib/constants";
import { useDraftAutosave, useWarnBeforeLeaving, confirmClear } from "../../lib/useDraftAutosave";
import { useCategorizedItems } from "../../lib/useCategorizedItems";
import { CategoryFilterRow, CategorizePanel } from "./CategoryUI";

// More (and smaller) frames than the Content tab's footage read - this
// call decides where to CUT, so it needs to see scene changes, not fine
// detail. 24 frames at 360px keeps the request small while landing a
// sample every ~2.5s across a 60s reel. The 16-frame floor matters for
// short reels: at the default spacing a 12s test reel got only 8 frames
// (1.5s apart) and every cut landed about a second late.
const STORY_FRAME_OPTIONS = { maxFrames: 24, minFrames: 16, frameWidth: 360, jpegQuality: 0.6 };

// Browser-only autosave (see useDraftAutosave below). Bump the version if
// the saved shape ever changes in a way an older draft can't be read into.
const STORIES_DRAFT_STORAGE_KEY = "wwwStoriesDraft";
const STORIES_DRAFT_VERSION = 1;

// The same reel, as far as a re-picked file can be recognized - a browser
// never hands back the original file after a refresh, so the plan records
// which file it was made from and a re-pick of that same file keeps it.
function sameSourceFile(plan, file) {
  return !!(plan?.sourceFile && file && plan.sourceFile.name === file.name && plan.sourceFile.size === file.size);
}

const POSITIONS = [
  { key: "top", label: "Top" },
  { key: "center", label: "Middle" },
  { key: "bottom", label: "Bottom" },
];

// A small copy of a slide's preview frame for the saved story - ~180px wide
// instead of the 360px planning frame, so a saved story stays a few KB per
// slide rather than carrying every sampled frame.
const THUMB_WIDTH = 180;
function makeThumb(frame) {
  if (!frame?.base64) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = THUMB_WIDTH;
      canvas.height = Math.round(THUMB_WIDTH * (img.naturalHeight / img.naturalWidth || 16 / 9));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve({ base64: canvas.toDataURL("image/jpeg", 0.6).split(",")[1], mediaType: "image/jpeg" });
    };
    img.onerror = () => resolve(null);
    img.src = `data:${frame.mediaType || "image/jpeg"};base64,${frame.base64}`;
  });
}

function formatSavedDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTime(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The sampled frame closest to the middle of a slide's segment - used as
// its preview still, so the text can be judged against what's actually
// behind it. A reopened saved story has no sampled frames (they're too big
// to store), so it falls back to the small thumbnail saved on each slide.
function frameForSlide(frames, slide) {
  if (!frames?.length) return slide.thumb || null;
  const mid = (slide.startSeconds + slide.endSeconds) / 2;
  return frames.reduce((best, f) =>
    Math.abs(f.timestampSeconds - mid) < Math.abs(best.timestampSeconds - mid) ? f : best
  );
}

// Drawn with the same function that burns the text into the final clip
// (lib/storyClips.js), at a smaller size - what shows here is what gets
// rendered.
function SlidePreview({ frame, text, position }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    ensureStoryFontLoaded().then(() => {
      if (!cancelled && canvasRef.current) drawStoryOverlay(canvasRef.current, text, position);
    });
    return () => {
      cancelled = true;
    };
  }, [text, position]);

  return (
    <div className="story-preview">
      {frame && <img src={`data:${frame.mediaType};base64,${frame.base64}`} alt="" />}
      <canvas ref={canvasRef} width={360} height={640} />
    </div>
  );
}

export default function StoriesTab() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [idea, setIdea] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");

  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [plan, setPlan] = useState(null);

  const [renderProgress, setRenderProgress] = useState(null);
  const [renderError, setRenderError] = useState("");
  const [clips, setClips] = useState(null);
  const [canShareFiles, setCanShareFiles] = useState(false);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef(null);

  // "Saved stories" sidebar - same pattern as the Content tab's saved
  // ideas: a planned set of slides, kept so it can be reopened without
  // paying to plan it again. plan.savedId marks the plan on screen as the
  // saved one.
  const [savedStories, setSavedStories] = useState([]);
  const [savedStoriesLoading, setSavedStoriesLoading] = useState(true);
  const [savedStoriesError, setSavedStoriesError] = useState("");
  const [savingStory, setSavingStory] = useState(false);
  const storiesHook = useCategorizedItems(savedStories, setSavedStories, "/api/saved-stories");
  // The slides as last written to the saved copy, so edits to a reopened
  // story are pushed back to it - and reopening it doesn't count as an edit.
  const lastSyncedSlidesRef = useRef(null);

  useEffect(() => {
    loadSavedStories();
  }, []);

  async function loadSavedStories() {
    setSavedStoriesLoading(true);
    try {
      const res = await fetch("/api/saved-stories");
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const stories = data.stories || [];
        setSavedStories(stories);
        setSavedStoriesError("");
        // An autosaved plan can point at a saved story that's since been
        // deleted - un-stick its "Saved" state if so.
        setPlan((p) => (p?.savedId && !stories.some((st) => st.id === p.savedId) ? { ...p, savedId: null } : p));
      } else {
        setSavedStoriesError(data.error || "Couldn't load saved stories.");
      }
    } catch {
      setSavedStoriesError("Couldn't load saved stories.");
    }
    setSavedStoriesLoading(false);
  }

  async function saveStories() {
    if (!plan?.slides?.length || savingStory || plan.savedId) return;
    setSavingStory(true);
    try {
      const slides = await Promise.all(
        plan.slides.map(async (sl) => ({ ...sl, thumb: sl.thumb || (await makeThumb(frameForSlide(plan.frames, sl))) }))
      );
      const input = plan.input || { idea, location, notes };
      const title =
        input.idea?.trim() ||
        plan.sourceFile?.name?.replace(/\.[^.]+$/, "") ||
        slides[0].text?.slice(0, 60) ||
        "Stories";
      const res = await fetch("/api/saved-stories", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          idea: input.idea,
          location: input.location,
          notes: input.notes,
          sourceFile: plan.sourceFile || null,
          durationSeconds: plan.durationSeconds,
          sceneSummary: plan.sceneSummary,
          slides,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Couldn't save these stories.");
      lastSyncedSlidesRef.current = JSON.stringify(slides);
      setSavedStories((list) => [data.story, ...list]);
      setPlan((p) => ({ ...p, slides, savedId: data.story.id }));
    } catch (err) {
      setRenderError(err.message || "Couldn't save these stories.");
    }
    setSavingStory(false);
  }

  // Reopens a saved story. Its reel isn't stored anywhere, so unless the
  // reel already picked is the same one, the picker is cleared and the
  // story shows the "re-select the same reel" prompt before clips can be
  // made.
  function loadSavedStory(st) {
    clearClips();
    setError("");
    setRenderError("");
    setIdea(st.idea || "");
    setLocation(st.location || "");
    setNotes(st.notes || "");
    const restored = {
      sceneSummary: st.scene_summary || [],
      slides: st.slides || [],
      frames: [],
      durationSeconds: Number(st.duration_seconds) || null,
      sourceFile: st.source_file || null,
      input: { idea: st.idea || "", location: st.location || "", notes: st.notes || "" },
      savedId: st.id,
    };
    lastSyncedSlidesRef.current = JSON.stringify(restored.slides);
    if (!sameSourceFile(restored, videoFile)) {
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      setVideoFile(null);
      setVideoUrl("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
    setPlan(restored);
  }

  async function deleteSavedStory(id) {
    setSavedStories((list) => list.filter((st) => st.id !== id));
    setPlan((p) => (p?.savedId === id ? { ...p, savedId: null } : p));
    try {
      await fetch(`/api/saved-stories/${id}`, { method: "DELETE" });
    } catch {
      // Already gone from the list; a failed delete just reappears on reload.
    }
  }

  // Edits to a saved story's lines/positions (or a removed slide) are
  // written back to the saved copy, debounced so typing a line doesn't
  // send a request per keystroke.
  useEffect(() => {
    if (!plan?.savedId || !plan.slides) return;
    const json = JSON.stringify(plan.slides);
    if (json === lastSyncedSlidesRef.current) return;
    const id = plan.savedId;
    const slides = plan.slides;
    const timer = setTimeout(async () => {
      lastSyncedSlidesRef.current = json;
      setSavedStories((list) => list.map((st) => (st.id === id ? { ...st, slides } : st)));
      try {
        await fetch(`/api/saved-stories/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slides }),
        });
      } catch {
        // The on-screen version is still right; only the saved copy lags.
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [plan?.slides, plan?.savedId]);

  // Detected after mount, not during render - navigator doesn't exist on
  // the server, and a phone's native share sheet ("Save Video" straight to
  // Photos) is the whole point of offering it over a plain download.
  useEffect(() => {
    try {
      const probe = new File([""], "probe.mp4", { type: "video/mp4" });
      setCanShareFiles(!!navigator.canShare?.({ files: [probe] }));
    } catch {
      setCanShareFiles(false);
    }
  }, []);

  // Autosave (lib/useDraftAutosave.js): the plan is the paid part - the
  // cuts, the lines (including any edits) and the preview frames - so it
  // survives a refresh or a closed tab. The reel itself can't be kept (a
  // browser never restores a picked file), so after a restore she re-picks
  // the same reel to make the clips; cutting them is on-device and free.
  // The rendered clips aren't kept either, for the same reason.
  useDraftAutosave(
    STORIES_DRAFT_STORAGE_KEY,
    { version: STORIES_DRAFT_VERSION, idea, location, notes, plan },
    (draft) => {
      if (draft.version !== STORIES_DRAFT_VERSION) return;
      setIdea(draft.idea || "");
      setLocation(draft.location || "");
      setNotes(draft.notes || "");
      if (draft.plan?.slides) setPlan(draft.plan);
    }
  );
  useWarnBeforeLeaving(loading || !!renderProgress);

  function clearClips() {
    setClips((current) => {
      current?.forEach((c) => URL.revokeObjectURL(c.url));
      return null;
    });
  }

  // Back to a blank form - the autosave then saves the blank page too.
  function clearPage() {
    if (!confirmClear(plan && !plan.savedId)) return;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setVideoFile(null);
    setVideoUrl("");
    setFileError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    setIdea("");
    setLocation("");
    setNotes("");
    setError("");
    setPlan(null);
    lastSyncedSlidesRef.current = null;
    clearClips();
    setRenderError("");
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0] || null;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    // Re-picking the reel a restored plan was made from keeps that plan
    // (and any edited lines); any other file starts over.
    if (!sameSourceFile(plan, file)) setPlan(null);
    setError("");
    clearClips();
    if (!file) {
      setVideoFile(null);
      setVideoUrl("");
      return;
    }
    if (file.size > MAX_VIDEO_FILE_BYTES) {
      setFileError("That file's too big - please use something under 300MB.");
      setVideoFile(null);
      setVideoUrl("");
      e.target.value = "";
      return;
    }
    setFileError("");
    setVideoFile(file);
    setVideoUrl(URL.createObjectURL(file));
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!videoFile || loading) return;

    setLoading(true);
    setError("");
    setPlan(null);
    clearClips();
    setRenderError("");
    setProgress({ phase: "frames", done: 0, total: 0 });

    try {
      const { frames, durationSeconds } = await extractVideoFrames(
        videoFile,
        (done, total) => setProgress({ phase: "frames", done, total }),
        STORY_FRAME_OPTIONS
      );
      setProgress({ phase: "plan" });

      const res = await fetch("/api/stories-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frames,
          durationSeconds,
          idea: idea.trim(),
          location: location.trim(),
          notes: notes.trim(),
        }),
      });
      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error("Request timed out or failed before completing. Try again.");
      }
      if (!res.ok) throw new Error(data.error || "Couldn't plan stories for this reel.");
      setPlan({
        ...data,
        frames,
        durationSeconds,
        sourceFile: { name: videoFile.name, size: videoFile.size },
        // What was actually asked, for "Save these stories" - the form stays
        // editable after planning.
        input: { idea: idea.trim(), location: location.trim(), notes: notes.trim() },
      });
    } catch (err) {
      setError(err.message || "Couldn't plan stories for this reel.");
    }
    setProgress(null);
    setLoading(false);
  }

  // Any edit to the plan makes already-rendered clips stale, so they're
  // dropped rather than left looking like they match.
  function updateSlide(index, changes) {
    clearClips();
    setPlan((p) => ({ ...p, slides: p.slides.map((s, i) => (i === index ? { ...s, ...changes } : s)) }));
  }

  function removeSlide(index) {
    clearClips();
    setPlan((p) => ({ ...p, slides: p.slides.filter((_, i) => i !== index) }));
  }

  async function makeClips() {
    if (!plan?.slides?.length || !videoFile || renderProgress) return;
    clearClips();
    setRenderError("");
    setRenderProgress({ done: 0, total: plan.slides.length });
    try {
      const blobs = await renderStoryClips(videoFile, plan.slides, (done, total) => setRenderProgress({ done, total }));
      const base = (videoFile.name || "reel").replace(/\.[^.]+$/, "");
      setClips(
        blobs.map((blob, i) => {
          const filename = `${base}-story-${i + 1}.mp4`;
          return { blob, filename, url: URL.createObjectURL(blob) };
        })
      );
    } catch (err) {
      setRenderError(err.message || "Couldn't make the story clips.");
    }
    setRenderProgress(null);
  }

  async function shareClips(list) {
    try {
      await navigator.share({
        files: list.map((c) => new File([c.blob], c.filename, { type: "video/mp4" })),
      });
    } catch (err) {
      // Closing the share sheet is a normal "never mind", not an error.
      if (err?.name !== "AbortError") setRenderError("Couldn't open the share sheet - use Download instead.");
    }
  }

  function copyLines() {
    navigator.clipboard.writeText(plan.slides.map((s, i) => `${i + 1}. ${s.text}`).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const buttonLabel =
    progress?.phase === "frames"
      ? `Watching your reel… (${progress.done}/${progress.total || "?"})`
      : progress?.phase === "plan"
      ? "Planning your stories…"
      : plan
      ? "Plan again"
      : "Plan stories from this reel";

  return (
    <div className="layout">
      <div className="main">
        <form onSubmit={onSubmit} className="card">
          <h3 style={{ marginTop: 0 }}>Stories</h3>
          <div className="field">
            <label htmlFor="storyReel">Upload the finished reel</label>
            <input id="storyReel" ref={fileInputRef} type="file" accept="video/*" onChange={handleFileChange} />
            <p className="hint" style={{ marginTop: 6 }}>
              It gets split into a few short Instagram Story clips, each with one short line of text on it.
              Everything happens in your browser — only a handful of still frames are sent to plan the cuts.
            </p>
            {fileError && <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>{fileError}</p>}
            {videoUrl && (
              <video src={videoUrl} controls style={{ width: "100%", borderRadius: 8, maxHeight: 360, marginTop: 10 }} />
            )}
          </div>

          <div className="field">
            <label htmlFor="storyIdea">What this is about (optional)</label>
            <input
              id="storyIdea"
              placeholder="Goat yoga at a working farm"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="storyLocation">Location (optional)</label>
            <input
              id="storyLocation"
              placeholder="Cricket Creek Farm, Williamstown, MA"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="storyNotes">Anything the stories should say (optional)</label>
            <textarea
              id="storyNotes"
              rows={2}
              placeholder="Mention it's only open weekends; end with 'full reel on my page'"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <div className="form-actions">
            <button className="btn-primary" disabled={!videoFile || loading}>
              {buttonLabel}
            </button>
            <button
              type="button"
              className="btn-ghost btn-clear"
              onClick={clearPage}
              disabled={loading || !!renderProgress || savingStory}
            >
              Clear
            </button>
          </div>
        </form>

        {plan && (
          <div className="result card">
            <div className="result-head">
              <h3 style={{ fontSize: 16 }}>
                {plan.slides.length} {plan.slides.length === 1 ? "story" : "stories"}
              </h3>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button type="button" className="btn-ghost" onClick={copyLines}>
                  {copied ? "Copied" : "Copy all lines"}
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={saveStories}
                  disabled={savingStory || !!plan.savedId || plan.slides.length === 0}
                >
                  {plan.savedId ? "Saved" : savingStory ? "Saving…" : "Save these stories"}
                </button>
              </div>
            </div>
            <p className="hint" style={{ marginBottom: 14 }}>
              Edit any line or move it off the subject, then make the clips. Clear a line completely to get
              that clip with no text (e.g. to add your own in Instagram).
            </p>

            <div className="story-grid">
              {plan.slides.map((slide, i) => (
                <div className="story-slide" key={`${slide.startSeconds}-${i}`}>
                  <div className="story-slide-head">
                    <strong>Story {i + 1}</strong>
                    <span className="hint">
                      {formatTime(slide.startSeconds)}–{formatTime(slide.endSeconds)} ·{" "}
                      {Math.round(slide.endSeconds - slide.startSeconds)}s
                    </span>
                    <button
                      type="button"
                      className="saved-item-delete"
                      onClick={() => removeSlide(i)}
                      aria-label={`Remove story ${i + 1}`}
                    >
                      ×
                    </button>
                  </div>
                  <SlidePreview frame={frameForSlide(plan.frames, slide)} text={slide.text} position={slide.textPosition} />
                  <textarea
                    rows={2}
                    value={slide.text}
                    onChange={(e) => updateSlide(i, { text: e.target.value })}
                    aria-label={`Text for story ${i + 1}`}
                    style={{ marginTop: 8 }}
                  />
                  <div className="story-position-row">
                    {POSITIONS.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={`category-filter-btn ${slide.textPosition === p.key ? "active" : ""}`}
                        onClick={() => updateSlide(i, { textPosition: p.key })}
                        aria-pressed={slide.textPosition === p.key}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  {clips?.[i] && (
                    <div className="story-clip-actions">
                      <a className="btn-ghost" href={clips[i].url} download={clips[i].filename}>
                        Download
                      </a>
                      {canShareFiles && (
                        <button type="button" className="btn-ghost" onClick={() => shareClips([clips[i]])}>
                          Save / share
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {plan.slides.length === 0 && <p className="hint">Every story was removed — plan again to start over.</p>}

            {renderError && <div className="error-banner" style={{ marginTop: 14 }}>{renderError}</div>}

            {plan.slides.length > 0 && (
              <div style={{ marginTop: 16 }}>
                {!videoFile ? (
                  <p className="hint" style={{ margin: 0 }}>
                    Your stories and any edits were kept. Re-select the same reel above
                    {plan.sourceFile?.name ? ` (${plan.sourceFile.name})` : ""} to make the clips.
                  </p>
                ) : !clips ? (
                  <button type="button" className="btn-primary" onClick={makeClips} disabled={!!renderProgress}>
                    {renderProgress
                      ? renderProgress.done === 0
                        ? "Loading the video tools…"
                        : `Making clip ${Math.min(renderProgress.done + 1, renderProgress.total)} of ${renderProgress.total}…`
                      : "Make story clips"}
                  </button>
                ) : (
                  canShareFiles && (
                    <button type="button" className="btn-primary" onClick={() => shareClips(clips)}>
                      Save all {clips.length} to Photos / share
                    </button>
                  )
                )}
                {videoFile && (
                  <p className="hint" style={{ marginTop: 8 }}>
                    {clips
                      ? "Post them to your story in order. The clips are 1080×1920 with the text burned in."
                      : "This runs on your device, so it can take a minute or two — keep this tab open until it finishes."}
                  </p>
                )}
              </div>
            )}

            {plan.sceneSummary?.length > 0 && (
              <div className="field" style={{ marginTop: 24 }}>
                <label>What Claude saw in your reel</label>
                <ul className="shotlist">
                  {plan.sceneSummary.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>

      <aside className="sidebar">
        <h3 style={{ fontSize: 14, marginBottom: 12 }}>Saved stories</h3>

        <CategoryFilterRow
          allCategories={storiesHook.allCategories}
          categoryFilter={storiesHook.categoryFilter}
          onFilter={storiesHook.setCategoryFilter}
        />

        {savedStoriesLoading && <p className="hint">Loading…</p>}
        {!savedStoriesLoading && savedStoriesError && <p className="hint">{savedStoriesError}</p>}
        {!savedStoriesLoading && !savedStoriesError && savedStories.length === 0 && (
          <p className="hint">Nothing saved yet. Plan stories from a reel and hit "Save these stories" to keep them.</p>
        )}
        {!savedStoriesLoading && savedStories.length > 0 && storiesHook.filteredItems.length === 0 && (
          <p className="hint">Nothing saved under "{storiesHook.categoryFilter}" yet.</p>
        )}
        <div className="saved-list">
          {storiesHook.filteredItems.map((st) => (
            <div key={st.id} className={`saved-item ${plan?.savedId === st.id ? "active" : ""}`}>
              <div className="saved-item-row">
                <button type="button" className="saved-item-main" onClick={() => loadSavedStory(st)}>
                  <div className="saved-item-idea">{st.title}</div>
                  <div className="saved-item-chips">
                    {st.category && <span className="saved-chip category-chip">{st.category}</span>}
                    <span className="saved-chip">
                      {st.slides?.length || 0} {st.slides?.length === 1 ? "story" : "stories"}
                    </span>
                    <span className="saved-chip">{formatSavedDate(st.created_at)}</span>
                  </div>
                </button>
                <div className="saved-item-actions">
                  <button type="button" className="saved-item-categorize" onClick={() => storiesHook.toggleCategorize(st.id)}>
                    Categorize
                  </button>
                  <button
                    type="button"
                    className="saved-item-delete"
                    onClick={() => deleteSavedStory(st.id)}
                    aria-label="Delete saved stories"
                  >
                    ×
                  </button>
                </div>
              </div>

              {storiesHook.categorizingId === st.id && (
                <CategorizePanel
                  item={st}
                  allCategories={storiesHook.allCategories}
                  newCategoryDraft={storiesHook.newCategoryDraft}
                  onDraftChange={storiesHook.setNewCategoryDraft}
                  onApply={storiesHook.applyCategory}
                  onSubmitNew={storiesHook.submitNewCategory}
                />
              )}
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
