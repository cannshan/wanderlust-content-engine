// Client-only: turns a finished reel into Instagram Story clips, entirely
// in the browser - each planned slide is cut out of the reel and has its
// one line of text burned onto it, via the same ffmpeg.wasm core the Reel
// Voiceover tab's assembler uses (see lib/assembleReel.js). The plan
// itself (where to cut, what each slide says) comes from
// planStoriesFromReel in lib/claude.js; this module only executes it.
//
// The text is drawn with a <canvas> into a transparent 1080x1920 PNG and
// laid over the video with ffmpeg's overlay filter, rather than ffmpeg's
// own drawtext - drawtext needs a font file shipped into the wasm
// filesystem, while a canvas can use whatever the browser already has
// (including color emoji), and the exact same drawing function renders the
// on-screen preview, so what she sees while editing is what gets burned in.
import { getFFmpeg } from "./assembleReel";

export const STORY_WIDTH = 1080;
export const STORY_HEIGHT = 1920;

const FONT_SIZE = 58;
const FONT_FAMILY = '"Work Sans", "Helvetica Neue", Helvetica, Arial, sans-serif';
const FONT_WEIGHT = 600;
const MAX_TEXT_WIDTH = STORY_WIDTH * 0.78;
const PAD_X = 28;
const PAD_Y = 16;
const RADIUS = 18;

// Instagram's own UI covers roughly the top ~250px (progress bar, profile
// row) and bottom ~340px (reply bar) of a 1920px story, so text is kept
// clear of both.
const TOP_Y = 300;
const BOTTOM_MARGIN = 440;

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundedRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Draws the slide's text onto `canvas` (any size with a 9:16 shape - the
// 1080x1920 layout is scaled to fit), in the look a lot of creators use in
// Stories: each line on its own rounded white highlight, dark text,
// centered. Clears the canvas first; empty text leaves it transparent.
export function drawStoryOverlay(canvas, text, position = "center") {
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  const scale = canvas.width / STORY_WIDTH;
  ctx.scale(scale, scale);
  ctx.font = `${FONT_WEIGHT} ${FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const lines = wrapLines(ctx, trimmed, MAX_TEXT_WIDTH);
  const boxH = FONT_SIZE + PAD_Y * 2;
  // Lines' highlight boxes touch slightly, so a wrapped sentence reads as
  // one block rather than separate stickers.
  const step = boxH - 6;
  const blockH = step * (lines.length - 1) + boxH;

  let y;
  if (position === "top") y = TOP_Y;
  else if (position === "bottom") y = STORY_HEIGHT - BOTTOM_MARGIN - blockH;
  else y = (STORY_HEIGHT - blockH) / 2;

  const cx = STORY_WIDTH / 2;
  lines.forEach((line, i) => {
    const w = ctx.measureText(line).width + PAD_X * 2;
    const top = y + i * step;
    ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
    roundedRect(ctx, cx - w / 2, top, w, boxH, RADIUS);
    ctx.fill();
  });
  ctx.fillStyle = "#16181b";
  lines.forEach((line, i) => {
    ctx.fillText(line, cx, y + i * step + boxH / 2 + 2);
  });
}

// Web fonts only load when something on the page uses them, and a canvas
// drawn before then silently falls back to a system font - so the exact
// face is requested up front before the final render.
export async function ensureStoryFontLoaded() {
  try {
    await document.fonts?.load(`${FONT_WEIGHT} ${FONT_SIZE}px ${FONT_FAMILY}`);
  } catch {
    // Falls back to the next font in the stack - still readable.
  }
}

async function overlayPng(text, position) {
  const canvas = document.createElement("canvas");
  canvas.width = STORY_WIDTH;
  canvas.height = STORY_HEIGHT;
  drawStoryOverlay(canvas, text, position);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

// Every clip is re-encoded to the same 1080x1920/30fps shape - padded
// rather than cropped, same as the Reel Voiceover assembler, so nothing in
// frame is ever cut off.
const SCALE_FILTER = `scale=${STORY_WIDTH}:${STORY_HEIGHT}:force_original_aspect_ratio=decrease,pad=${STORY_WIDTH}:${STORY_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

// file: the original reel. slides: [{startSeconds, endSeconds, text,
// textPosition}] in posting order. onProgress(done, total) after each clip.
// Returns one mp4 Blob per slide, same order.
export async function renderStoryClips(file, slides, onProgress) {
  const { fetchFile } = await import("@ffmpeg/util");
  const ffmpeg = await getFFmpeg();
  await ensureStoryFontLoaded();

  // Written into the wasm filesystem once and cut from repeatedly, rather
  // than re-copied per slide - a finished reel can be a big file, and
  // copying it N times is the slowest part on a phone.
  const ext = (file.name?.match(/\.[a-z0-9]+$/i)?.[0] || ".mp4").toLowerCase();
  const inputName = `story_source${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  const clips = [];
  try {
    for (let i = 0; i < slides.length; i++) {
      const { startSeconds, endSeconds, text, textPosition } = slides[i];
      const outputName = `story_${i}.mp4`;
      const overlayName = `story_overlay_${i}.png`;
      const hasText = !!(text || "").trim();

      // -ss/-t before -i so they apply only to the reel input, not the PNG.
      const args = ["-ss", String(startSeconds), "-t", String(endSeconds - startSeconds), "-i", inputName];
      if (hasText) {
        await ffmpeg.writeFile(overlayName, await overlayPng(text, textPosition));
        args.push(
          "-i", overlayName,
          "-filter_complex", `[0:v]${SCALE_FILTER}[bg];[bg][1:v]overlay=0:0[v]`,
          "-map", "[v]"
        );
      } else {
        args.push("-vf", SCALE_FILTER, "-map", "0:v:0");
      }
      args.push(
        // Optional audio map - a reel exported without sound still works.
        "-map", "0:a?",
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        // yuv420p explicitly: the overlay step can otherwise hand back a
        // pixel format iPhones won't play.
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "44100",
        "-movflags", "+faststart",
        outputName
      );

      const code = await ffmpeg.exec(args);
      if (code !== 0) {
        throw new Error(`Couldn't cut story ${i + 1} out of this video - try an MP4 export of the reel.`);
      }

      const data = await ffmpeg.readFile(outputName);
      clips.push(new Blob([data], { type: "video/mp4" }));
      await ffmpeg.deleteFile(outputName).catch(() => {});
      if (hasText) await ffmpeg.deleteFile(overlayName).catch(() => {});
      onProgress?.(i + 1, slides.length);
    }
  } finally {
    await ffmpeg.deleteFile(inputName).catch(() => {});
  }

  return clips;
}
