// Client-only: actually cuts and stitches the user's own uploaded clips
// into one finished video, entirely in the browser via ffmpeg.wasm - no
// server-side video processing, no upload of the raw footage anywhere
// beyond this tab. Driven by the edit plan Claude already wrote (see
// writeReelEditPlan in lib/claude.js) after watching each clip's sampled
// frames; this module only executes that plan, it never decides it.
//
// @ffmpeg/ffmpeg and @ffmpeg/util are dynamically imported inside
// assembleReel() rather than at module scope, so their JS wrapper never
// loads into the bundle for people who only use the single-video
// voiceover mode - the ~30MB wasm core itself is always fetched lazily
// from a CDN regardless, only once per browser tab (cached on the
// singleton below for a possible "assemble again" retry in the same
// session).
const CORE_BASE_URL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";

let ffmpegPromise = null;

// Shared with lib/storyClips.js (Stories tab), so both features reuse one
// loaded ffmpeg core per browser tab instead of downloading it twice.
export async function getFFmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
        import("@ffmpeg/ffmpeg"),
        import("@ffmpeg/util"),
      ]);
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({
        coreURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${CORE_BASE_URL}/ffmpeg-core.wasm`, "application/wasm"),
      });
      return ffmpeg;
    })();
  }
  return ffmpegPromise;
}

// clipFiles: the original File objects, in upload order (clip_index in
// editPlan refers back into this array). editPlan: [{clipIndex,
// startSeconds, endSeconds}, ...] in final playback order, already
// validated server-side. onProgress(phase, done, total) reports two
// phases: "trimming" (per segment) and "combining" (the final concat).
export async function assembleReel(clipFiles, editPlan, onProgress) {
  const { fetchFile } = await import("@ffmpeg/util");
  const ffmpeg = await getFFmpeg();

  const segmentNames = [];

  for (let i = 0; i < editPlan.length; i++) {
    const { clipIndex, startSeconds, endSeconds } = editPlan[i];
    const file = clipFiles[clipIndex];
    if (!file) continue;

    const inputName = `in${i}.mp4`;
    const outputName = `seg${i}.mp4`;
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    // Re-encoded (not stream-copied) for two reasons: -ss/-to trimming
    // needs a real decode to cut on an exact frame rather than the
    // nearest keyframe, and normalizing every segment to the same
    // resolution/frame rate/codec is what lets the plain concat demuxer
    // below just stitch them - phone clips from different takes aren't
    // guaranteed to share a resolution or frame rate even when they're
    // all "the same video". "ultrafast" trades file size for the fastest
    // possible single-threaded WASM encode - there's no hardware
    // acceleration available in-browser, so this matters a lot here.
    await ffmpeg.exec([
      "-ss", String(startSeconds),
      "-to", String(endSeconds),
      "-i", inputName,
      "-vf", "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1",
      "-r", "30",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-c:a", "aac",
      "-ar", "44100",
      outputName,
    ]);

    await ffmpeg.deleteFile(inputName);
    segmentNames.push(outputName);
    onProgress?.("trimming", i + 1, editPlan.length);
  }

  if (segmentNames.length === 0) {
    throw new Error("No usable segments to assemble.");
  }

  onProgress?.("combining", 0, 1);

  // Every segment now shares the same codec/resolution/frame rate (all
  // re-encoded identically above), so a plain stream-copy concat is safe
  // and fast here - no second re-encode pass needed for the final file.
  const listContent = segmentNames.map((name) => `file '${name}'`).join("\n");
  await ffmpeg.writeFile("concat_list.txt", listContent);
  await ffmpeg.exec(["-f", "concat", "-safe", "0", "-i", "concat_list.txt", "-c", "copy", "output.mp4"]);

  const data = await ffmpeg.readFile("output.mp4");

  for (const name of segmentNames) await ffmpeg.deleteFile(name).catch(() => {});
  await ffmpeg.deleteFile("concat_list.txt").catch(() => {});
  await ffmpeg.deleteFile("output.mp4").catch(() => {});

  onProgress?.("combining", 1, 1);

  return new Blob([data.buffer], { type: "video/mp4" });
}
