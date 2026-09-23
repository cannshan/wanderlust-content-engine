"use client";

import { useState, useRef, useEffect } from "react";
import { extractVideoFrames } from "../../lib/videoFrames";
import { drawStoryOverlay, ensureStoryFontLoaded, renderStoryClips } from "../../lib/storyClips";
import { MAX_VIDEO_FILE_BYTES } from "../../lib/constants";

// More (and smaller) frames than the Content tab's footage read - this
// call decides where to CUT, so it needs to see scene changes, not fine
// detail. 24 frames at 360px keeps the request small while landing a
// sample every ~2.5s across a 60s reel. The 16-frame floor matters for
// short reels: at the default spacing a 12s test reel got only 8 frames
// (1.5s apart) and every cut landed about a second late.
const STORY_FRAME_OPTIONS = { maxFrames: 24, minFrames: 16, frameWidth: 360, jpegQuality: 0.6 };

const POSITIONS = [
  { key: "top", label: "Top" },
  { key: "center", label: "Middle" },
  { key: "bottom", label: "Bottom" },
];

function formatTime(seconds) {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The sampled frame closest to the middle of a slide's segment - used as
// its preview still, so the text can be judged against what's actually
// behind it.
function frameForSlide(frames, slide) {
  if (!frames?.length) return null;
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

  function clearClips() {
    setClips((current) => {
      current?.forEach((c) => URL.revokeObjectURL(c.url));
      return null;
    });
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0] || null;
    if (videoUrl) URL.revokeObjectURL(videoUrl);
    setPlan(null);
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
      setPlan({ ...data, frames, durationSeconds });
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
            <input id="storyReel" type="file" accept="video/*" onChange={handleFileChange} />
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

          <button className="btn-primary" disabled={!videoFile || loading}>
            {buttonLabel}
          </button>
        </form>

        {plan && (
          <div className="result card">
            <div className="result-head">
              <h3 style={{ fontSize: 16 }}>
                {plan.slides.length} {plan.slides.length === 1 ? "story" : "stories"}
              </h3>
              <button type="button" className="btn-ghost" onClick={copyLines}>
                {copied ? "Copied" : "Copy all lines"}
              </button>
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
                {!clips ? (
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
                <p className="hint" style={{ marginTop: 8 }}>
                  {clips
                    ? "Post them to your story in order. The clips are 1080×1920 with the text burned in."
                    : "This runs on your device, so it can take a minute or two — keep this tab open until it finishes."}
                </p>
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
    </div>
  );
}
