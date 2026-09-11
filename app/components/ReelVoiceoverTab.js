"use client";

import { useState, useRef } from "react";
import { extractVideoFrames, MAX_FRAMES } from "../../lib/videoFrames";
import { assembleReel } from "../../lib/assembleReel";
import { PLATFORM_LABELS, PLATFORM_ORDER, MAX_VIDEO_FILE_BYTES } from "../../lib/constants";

const MAX_CLIPS = 20;

// Frame sampling per clip scales DOWN as clip count goes up, so the total
// image payload sent to Claude for the edit plan stays roughly constant
// (and safely under Vercel's request body limit) no matter how many clips
// are uploaded - sending up to MAX_FRAMES per clip unscaled would mean up
// to MAX_CLIPS * MAX_FRAMES images in one request at the cap, which is far
// more than needed and risks the request itself failing outright, not
// just running expensive. Smaller/more-compressed frames than the
// single-video mode too, for the same reason - editorial "does this
// moment belong in the cut" judgment doesn't need full detail across many
// samples the way a single close read of one video does.
const ASSEMBLE_TOTAL_FRAME_BUDGET = 80;
const ASSEMBLE_FRAME_WIDTH = 360;
const ASSEMBLE_JPEG_QUALITY = 0.5;

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function assembleButtonLabel(progress, loading) {
  if (progress) {
    if (progress.phase === "frames") return `Watching clip ${progress.done}/${progress.total}…`;
    if (progress.phase === "plan") return "Planning the edit…";
    if (progress.phase === "trimming") return `Trimming clip ${progress.done}/${progress.total}…`;
    if (progress.phase === "combining") return "Assembling final reel…";
  }
  if (loading) return "Working…";
  return "Assemble reel + write voiceover";
}

export default function ReelVoiceoverTab() {
  const [mode, setMode] = useState("single"); // "single" | "assemble"

  // Shared across both modes.
  const [idea, setIdea] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [platform, setPlatform] = useState("tiktok");

  // "Already edited - just write a voiceover" mode.
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const objectUrlRef = useRef("");

  // "Raw clips - assemble for me" mode.
  const [clips, setClips] = useState([]);
  const [clipsError, setClipsError] = useState("");
  const [assembleProgress, setAssembleProgress] = useState(null);
  const [assembleLoading, setAssembleLoading] = useState(false);
  const [assembleError, setAssembleError] = useState("");
  const [assembleResult, setAssembleResult] = useState(null);
  const [assembleCopied, setAssembleCopied] = useState(false);
  const assembleVideoUrlRef = useRef("");

  function handleFileChange(e) {
    const file = e.target.files?.[0] || null;
    setResult(null);
    setError("");
    if (!file) {
      setVideoFile(null);
      return;
    }
    if (file.size > MAX_VIDEO_FILE_BYTES) {
      setFileError("That file's too big - please use something under 300MB.");
      setVideoFile(null);
      e.target.value = "";
      return;
    }
    setFileError("");
    setVideoFile(file);
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setVideoUrl(url);
  }

  async function onSubmit(e) {
    e.preventDefault();
    if (!videoFile || loading) return;

    setLoading(true);
    setError("");
    setResult(null);
    setProgress({ done: 0, total: 0 });

    try {
      const { frames, durationSeconds } = await extractVideoFrames(videoFile, (done, total) =>
        setProgress({ done, total })
      );

      setProgress(null);

      const res = await fetch("/api/reel-voiceover", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frames,
          durationSeconds,
          idea: idea.trim(),
          location: location.trim(),
          notes: notes.trim(),
          platform,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't write a voiceover for this reel.");
      setResult(data);
    } catch (err) {
      setError(err.message || "Couldn't write a voiceover for this reel.");
    }
    setProgress(null);
    setLoading(false);
  }

  function copy(text) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function handleClipsChange(e) {
    const incoming = Array.from(e.target.files || []);
    e.target.value = ""; // lets the same file be re-picked later if removed
    if (incoming.length === 0) return;

    const oversized = incoming.some((f) => f.size > MAX_VIDEO_FILE_BYTES);
    const accepted = incoming.filter((f) => f.size <= MAX_VIDEO_FILE_BYTES);
    const wouldExceed = clips.length + accepted.length > MAX_CLIPS;

    setClips((current) => {
      const room = MAX_CLIPS - current.length;
      return room > 0 ? [...current, ...accepted.slice(0, room)] : current;
    });

    if (oversized && wouldExceed) {
      setClipsError(`Some of those were skipped - clips must be under 300MB each, and only ${MAX_CLIPS} clips fit per reel.`);
    } else if (oversized) {
      setClipsError("One or more of those files were too big - please use clips under 300MB each.");
    } else if (wouldExceed) {
      setClipsError(`Only ${MAX_CLIPS} clips fit per reel - the extra ones were skipped.`);
    } else {
      setClipsError("");
    }
  }

  function removeClip(index) {
    setClips((current) => current.filter((_, i) => i !== index));
  }

  async function onAssembleSubmit(e) {
    e.preventDefault();
    if (clips.length === 0 || assembleLoading) return;

    setAssembleLoading(true);
    setAssembleError("");
    setAssembleResult(null);
    setAssembleProgress({ phase: "frames", done: 0, total: clips.length });

    try {
      const perClipMaxFrames = Math.min(
        MAX_FRAMES,
        Math.max(3, Math.floor(ASSEMBLE_TOTAL_FRAME_BUDGET / clips.length))
      );
      const clipData = [];
      for (let i = 0; i < clips.length; i++) {
        const { frames, durationSeconds } = await extractVideoFrames(clips[i], undefined, {
          maxFrames: perClipMaxFrames,
          minFrames: Math.min(perClipMaxFrames, 3),
          frameWidth: ASSEMBLE_FRAME_WIDTH,
          jpegQuality: ASSEMBLE_JPEG_QUALITY,
        });
        clipData.push({ frames, durationSeconds });
        setAssembleProgress({ phase: "frames", done: i + 1, total: clips.length });
      }

      setAssembleProgress({ phase: "plan", done: 0, total: 1 });
      const planRes = await fetch("/api/reel-edit-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clips: clipData,
          idea: idea.trim(),
          location: location.trim(),
          notes: notes.trim(),
          platform,
        }),
      });
      const planData = await planRes.json();
      if (!planRes.ok) throw new Error(planData.error || "Couldn't put together an edit from these clips.");

      setAssembleProgress({ phase: "trimming", done: 0, total: planData.editPlan.length });
      const videoBlob = await assembleReel(clips, planData.editPlan, (phase, done, total) =>
        setAssembleProgress({ phase, done, total })
      );

      if (assembleVideoUrlRef.current) URL.revokeObjectURL(assembleVideoUrlRef.current);
      const videoUrl = URL.createObjectURL(videoBlob);
      assembleVideoUrlRef.current = videoUrl;

      setAssembleResult({
        sceneSummary: planData.sceneSummary,
        voiceoverScript: planData.voiceoverScript,
        totalDurationSeconds: planData.totalDurationSeconds,
        videoUrl,
      });
    } catch (err) {
      setAssembleError(err.message || "Couldn't put together an edit from these clips.");
    }
    setAssembleProgress(null);
    setAssembleLoading(false);
  }

  function copyAssembleScript(text) {
    navigator.clipboard.writeText(text);
    setAssembleCopied(true);
    setTimeout(() => setAssembleCopied(false), 1500);
  }

  return (
    <div className="layout">
      <div className="main">
        <form onSubmit={mode === "single" ? onSubmit : onAssembleSubmit} className="card">
          <div className="field">
            <label>Footage</label>
            <div className="goal-toggle">
              <button
                type="button"
                className={`goal-option ${mode === "single" ? "active" : ""}`}
                onClick={() => setMode("single")}
              >
                <span className="goal-title">Already edited</span>
                <span className="goal-sub">Just write a voiceover for a finished reel</span>
              </button>
              <button
                type="button"
                className={`goal-option ${mode === "assemble" ? "active" : ""}`}
                onClick={() => setMode("assemble")}
              >
                <span className="goal-title">Raw clips</span>
                <span className="goal-sub">Put the reel together from my takes, then write a voiceover</span>
              </button>
            </div>
          </div>

          {mode === "single" && (
            <>
              <div className="field">
                <label htmlFor="reelFile">Upload the reel</label>
                <input id="reelFile" type="file" accept="video/*" onChange={handleFileChange} />
                <p className="hint" style={{ marginTop: 6 }}>
                  Processed entirely in your browser — the video file itself is never uploaded, only a handful of
                  still frames pulled from it.
                </p>
                {fileError && <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>{fileError}</p>}
              </div>

              {videoUrl && (
                <div className="field">
                  <video src={videoUrl} controls style={{ width: "100%", borderRadius: 8, maxHeight: 400 }} />
                </div>
              )}
            </>
          )}

          {mode === "assemble" && (
            <div className="field">
              <label htmlFor="reelClips">Upload your clips/takes</label>
              <input id="reelClips" type="file" accept="video/*" multiple onChange={handleClipsChange} />
              <p className="hint" style={{ marginTop: 6 }}>
                Everything stays in your browser — Claude decides which parts of which clips make the cut and in
                what order, then the video is trimmed and stitched together locally, never uploaded anywhere.
                Up to {MAX_CLIPS} clips. Processing time depends on your device and how much footage you give it —
                with a lot of clips (or long ones), this can take several minutes.
              </p>
              {clipsError && <p className="hint" style={{ marginTop: 6, color: "var(--bad)" }}>{clipsError}</p>}

              {clips.length > 0 && (
                <ul className="shotlist" style={{ marginTop: 10 }}>
                  {clips.map((f, i) => (
                    <li key={`${f.name}-${i}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                      <span>{f.name} <span className="hint">({formatBytes(f.size)})</span></span>
                      <button
                        type="button"
                        className="saved-item-delete"
                        onClick={() => removeClip(i)}
                        aria-label={`Remove ${f.name}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="field">
            <label htmlFor="reelIdea">What this is about (optional)</label>
            <input
              id="reelIdea"
              placeholder="Goat yoga at a working farm"
              value={idea}
              onChange={(e) => setIdea(e.target.value)}
            />
            <p className="hint">
              Helps with names/facts the footage alone can't show — the voiceover still follows what's actually
              on screen, not this description.
            </p>
          </div>

          <div className="field">
            <label htmlFor="reelLocation">Location (optional)</label>
            <input
              id="reelLocation"
              placeholder="Cricket Creek Farm, Williamstown, MA"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="reelNotes">Anything not visible on camera worth mentioning (optional)</label>
            <input
              id="reelNotes"
              placeholder="Restaurant name, booking link, a detail the footage doesn't show"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Platform (shapes tone/pacing)</label>
            <div className="platform-toggle">
              {PLATFORM_ORDER.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`goal-option ${platform === p ? "active" : ""}`}
                  onClick={() => setPlatform(p)}
                  aria-pressed={platform === p}
                >
                  <span className="goal-title">{PLATFORM_LABELS[p]}</span>
                </button>
              ))}
            </div>
          </div>

          {mode === "single" && error && <div className="error-banner">{error}</div>}
          {mode === "assemble" && assembleError && <div className="error-banner">{assembleError}</div>}

          {mode === "single" ? (
            <button className="btn-primary" disabled={!videoFile || loading}>
              {progress
                ? `Watching your reel… (${progress.done}/${progress.total || "?"})`
                : loading
                ? "Writing voiceover…"
                : "Write voiceover from this reel"}
            </button>
          ) : (
            <button className="btn-primary" disabled={clips.length === 0 || assembleLoading}>
              {assembleButtonLabel(assembleProgress, assembleLoading)}
            </button>
          )}
        </form>

        {mode === "single" && result && (
          <div className="result card">
            <div className="result-head">
              <h3 style={{ fontSize: 16 }}>Result</h3>
            </div>

            {result.sceneSummary?.length > 0 && (
              <div className="field" style={{ marginBottom: 20 }}>
                <label>What Claude saw in your footage</label>
                <ul className="shotlist">
                  {result.sceneSummary.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
                <p className="hint" style={{ marginTop: 6 }}>
                  Sanity-check this against your actual footage — the voiceover below is written to match it.
                </p>
              </div>
            )}

            <div className="field">
              <label>Voiceover script</label>
              <div className="description-box">{result.voiceoverScript}</div>
              <button className="btn-ghost" onClick={() => copy(result.voiceoverScript)}>
                {copied ? "Copied" : "Copy voiceover script"}
              </button>
            </div>
          </div>
        )}

        {mode === "assemble" && assembleResult && (
          <div className="result card">
            <div className="result-head">
              <h3 style={{ fontSize: 16 }}>Result</h3>
            </div>

            <div className="field" style={{ marginBottom: 20 }}>
              <label>Assembled reel (~{Math.round(assembleResult.totalDurationSeconds)}s)</label>
              <video src={assembleResult.videoUrl} controls style={{ width: "100%", borderRadius: 8, maxHeight: 400 }} />
              <a className="btn-ghost" href={assembleResult.videoUrl} download="reel.mp4" style={{ display: "inline-block", marginTop: 10, textDecoration: "none" }}>
                Download video
              </a>
              <p className="hint" style={{ marginTop: 8 }}>
                Not right? There's no in-place editor here — just tweak the clips above (remove one, add another)
                and assemble again.
              </p>
            </div>

            {assembleResult.sceneSummary?.length > 0 && (
              <div className="field" style={{ marginBottom: 20 }}>
                <label>What Claude used, and why</label>
                <ul className="shotlist">
                  {assembleResult.sceneSummary.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="field">
              <label>Voiceover script</label>
              <div className="description-box">{assembleResult.voiceoverScript}</div>
              <button className="btn-ghost" onClick={() => copyAssembleScript(assembleResult.voiceoverScript)}>
                {assembleCopied ? "Copied" : "Copy voiceover script"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
