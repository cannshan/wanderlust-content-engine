// Client-only: pulls evenly-spaced frames out of a video file entirely in
// the browser, using a hidden <video> element seeked to specific
// timestamps and drawn to a <canvas>. The original file never has to be
// uploaded anywhere - only these small JPEG frames get sent to the API -
// so there's no need for ffmpeg or any server-side video processing, and
// the request payload stays tiny (a handful of ~20-40KB frames, well
// under Vercel's request body limit) no matter how large the source file
// actually is.

export const MAX_FRAMES = 16;
const MIN_FRAMES = 6;
const FRAME_INTERVAL_TARGET_SECONDS = 2;
const FRAME_WIDTH = 480;
const JPEG_QUALITY = 0.6;

function seekTo(video, time) {
  return new Promise((resolve) => {
    function onSeeked() {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    }
    video.addEventListener("seeked", onSeeked);
    video.currentTime = time;
  });
}

// Some containers (mostly WebM without a duration header) report duration
// as Infinity until the browser has actually scanned the file - seeking
// near the end and back forces that scan. A known browser quirk, not
// specific to this app.
async function resolveDuration(video) {
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  await seekTo(video, 1e7);
  await seekTo(video, 0);
  if (isFinite(video.duration) && video.duration > 0) return video.duration;
  throw new Error("Couldn't determine this video's length - try a different file (MP4 works best).");
}

// onProgress(done, total) is called after each frame is captured, so the
// caller can show "Watching your reel... (4/12)" while this runs.
//
// options lets a caller handling MANY clips at once (the "raw clips -
// assemble for me" mode) shrink frame count/size per clip so the total
// request payload across all of them stays well under Vercel's request
// body limit - the single-reel voiceover mode never needs this and just
// gets the defaults below.
export async function extractVideoFrames(file, onProgress, options = {}) {
  const {
    maxFrames = MAX_FRAMES,
    minFrames = MIN_FRAMES,
    frameWidth = FRAME_WIDTH,
    jpegQuality = JPEG_QUALITY,
  } = options;

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("Couldn't read this video file - try a different format (MP4 works best)."));
    });

    const duration = await resolveDuration(video);
    const frameCount = Math.min(
      maxFrames,
      Math.max(minFrames, Math.ceil(duration / FRAME_INTERVAL_TARGET_SECONDS))
    );

    const canvas = document.createElement("canvas");
    canvas.width = frameWidth;
    canvas.height = Math.round(frameWidth * ((video.videoHeight || 16) / (video.videoWidth || 9)));
    const ctx = canvas.getContext("2d");

    const frames = [];
    for (let i = 0; i < frameCount; i++) {
      // Midpoint sampling, not segment edges - avoids landing right on a
      // cut/transition frame at a boundary.
      const t = (duration * (i + 0.5)) / frameCount;
      await seekTo(video, t);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", jpegQuality);
      frames.push({
        base64: dataUrl.split(",")[1] || "",
        mediaType: "image/jpeg",
        timestampSeconds: Math.round(t * 10) / 10,
      });
      onProgress?.(i + 1, frameCount);
    }

    return { frames, durationSeconds: duration };
  } finally {
    URL.revokeObjectURL(url);
  }
}
