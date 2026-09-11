"use client";

import { useState, useRef } from "react";
import { extractVideoFrames } from "../../lib/videoFrames";
import { PLATFORM_LABELS, PLATFORM_ORDER } from "../../lib/constants";

// Raw file size cap on the upload itself - the file never leaves the
// browser (only extracted frames are sent, see lib/videoFrames.js), so
// this is purely a guard against a huge file being slow/heavy for the
// browser to decode and seek through, not a request-size concern.
const MAX_VIDEO_FILE_BYTES = 300 * 1024 * 1024;

export default function ReelVoiceoverTab() {
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [fileError, setFileError] = useState("");
  const [idea, setIdea] = useState("");
  const [location, setLocation] = useState("");
  const [notes, setNotes] = useState("");
  const [platform, setPlatform] = useState("tiktok");
  const [progress, setProgress] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [copied, setCopied] = useState(false);
  const objectUrlRef = useRef("");

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

  return (
    <div className="layout">
      <div className="main">
        <form onSubmit={onSubmit} className="card">
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

          {error && <div className="error-banner">{error}</div>}

          <button className="btn-primary" disabled={!videoFile || loading}>
            {progress
              ? `Watching your reel… (${progress.done}/${progress.total || "?"})`
              : loading
              ? "Writing voiceover…"
              : "Write voiceover from this reel"}
          </button>
        </form>

        {result && (
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
      </div>
    </div>
  );
}
