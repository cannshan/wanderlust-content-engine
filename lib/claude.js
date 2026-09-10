import { buildSystemPrompt, platformLabelFor } from "./voiceProfile";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// Claude's built-in web search tool - $0.01/search, billed to the same
// Anthropic API key already required, no separate account or login wall
// (unlike scraping TikTok's own Creative Center, which now gates keyword
// search behind a login). This is the primary "automated trend lookup" -
// Apify (lib/trends.js) is kept as an optional pre-fetch on top of it, not
// a requirement.
//
// max_uses capped at 1: the instructions only ever ask for a single search.
const WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 1,
};

// Fetches a specific URL already present in the conversation - used only
// for reading a restaurant's own menu link the user provides, not for
// open-ended search (that's WEB_SEARCH_TOOL's job). Current tool version
// (Sonnet 5 supports it); capped at 1 use for the same reason every other
// tool in this file is - one fetch is all the prompt ever asks for.
const WEB_FETCH_TOOL = {
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: 1,
};

// Generation is split into two calls instead of one big tool call with
// every field. Live testing across many runs found a consistent pattern:
// every PLAIN STRING field here (description, hook_strategy, shot_notes as
// a delimited string, etc.) was reliable every single time. The one field
// that kept coming back missing or malformed - even after several attempted
// fixes (flattening a nested object, switching arrays to delimited strings)
// - was specifically the 5-item hashtag list. So instead of patching that
// after the fact with a conditional "repair" call, hashtags is no longer
// part of this tool at all - it's handled by a second, always-run,
// dedicated step (pickHashtags(), below) that has nothing else to do. This
// call keeps the web_search tool and produces everything BUT the final tag
// list and its rationale.
//
// hashtag_rationale itself moved out of this schema too, later, for the
// same reason: once location_tag/location_tag_why were added on top of
// everything else here, live testing caught hashtag_rationale specifically
// coming back as lazy placeholder text ("na", "placeholder") - a rushed
// model shortcutting the most "optional-feeling" field once the schema got
// crowded enough, even though it was fine before. Rather than trim other
// real content to make room, the rationale moved to live alongside the tag
// picking it's actually paired with - pickHashtags() now writes both,
// reasoning fresh from the finished description and trend data rather than
// depending on a field from this call at all.
//
// video_length_seconds is left out for the same reason, but simpler: it's
// not generated at all, since it's pure arithmetic on the length the user
// already picked (resolvedLength +/- 3s - see lengthBlock() in
// voiceProfile.js, which computes the identical range for the system
// prompt text). A live log caught it coming back undefined even though
// every field around it in the schema was fine - since the model was never
// actually free to choose a different value, asking it to regenerate a
// fixed number was a pure reliability liability with no upside. Only
// video_length_why (the actual one-sentence rationale) is real generated
// content, so that's all that stays in this schema.
//
// A function of platform, not a static object, because YouTube needs one
// extra required field (title) that TikTok/Instagram don't have at all -
// title only exists in the schema for a youtube call, rather than being an
// always-present-but-sometimes-empty field on every platform.
function buildSubmitPostTool(platform) {
  const isYouTube = platform === "youtube";

  return {
    name: "submit_post",
    description: "Deliver the finished post for this platform (everything except the final hashtag list, which is handled separately). This is the only way to submit a result - call it exactly once, when every field is ready.",
    input_schema: {
      type: "object",
      properties: {
        ...(isYouTube
          ? {
              title: {
                type: "string",
                description: "The YouTube Short's title - front-load the one concrete, specific hook detail as real searchable language (a person could plausibly type it), not just a vibe or pun. This is indexed/searchable metadata on YouTube, unlike a TikTok/Instagram caption, so treat it accordingly. Roughly 40-60 characters so it doesn't get truncated.",
              },
            }
          : {}),
        description: {
          type: "string",
          description: isYouTube
            ? "The full YouTube description. Open with 1-2 lines that work as a compelling preview (what shows before a viewer taps '...more'), then expand into the fuller story/detail like her real posts, then a location/booking mention, formatted with line breaks like her real posts."
            : "The full caption, formatted with line breaks like her real posts.",
        },
        pattern_used: {
          type: "string",
          enum: ["animal-content", "pop-culture-tie-in", "insider-access", "standard"],
          description: "Whichever proven pattern this post leans on, or 'standard' if none genuinely fit.",
        },
        hook_strategy: {
          type: "string",
          description: "1-2 sentences summarizing why this hook/description was written this way - which pattern (if any) it leans on and which algorithm mechanic is doing the real work. If research (live search or platform data) turned up something that could genuinely help this post specifically, name it here. No 'her/she' pronouns, and never the literal words 'Source A' or 'Source B' - describe them plainly instead (e.g. 'TikTok algorithm research' rather than 'Source A', 'patterns from past high-performing posts' rather than naming a specific past post).",
        },
        video_length_why: {
          type: "string",
          description: "One sentence on how this specific topic fills that fixed length well (what beats/detail it takes), and if this doesn't meet this platform's own monetization length requirement (see the length rules in the system prompt - TikTok has one, Instagram and YouTube don't), a reminder that it won't be eligible there. Neutral summary tone, no 'her/she' pronouns.",
        },
        shot_notes: {
          type: "string",
          description: "3-5 short, topic-specific filming tips (what to shoot, when to hold a shot, what belongs in the opening 3 seconds to match the hook), as ONE string with each tip on its own line separated by a newline character (\\n). Not a JSON array, not numbered, not bulleted - just plain lines of text separated by newlines.",
        },
        cover_text: {
          type: "string",
          description: "Short bold cover/thumbnail text built around the hook's specific detail, under 8 words.",
        },
        location_tag: {
          type: "string",
          description: `The real place name to select in ${platformLabelFor(
            platform
          )}'s own location-tag field at upload time - a separate, structured field from the 📍 line in the description, which always stays the literal exact venue. Must be a REAL place, genuinely close to the actual venue, and an honest fit for what the video is actually about - never invented, never chosen just because it trends higher. Follow this platform's specific location-tag guidance in the system prompt for whether that means the exact venue or a well-known nearby landmark.`,
        },
        location_tag_why: {
          type: "string",
          description: "One sentence on why this specific real place was chosen as the location tag for this platform. Neutral summary tone, no 'her/she' pronouns.",
        },
      },
      required: [
        ...(isYouTube ? ["title"] : []),
        "description",
        "pattern_used",
        "hook_strategy",
        "video_length_why",
        "shot_notes",
        "cover_text",
        "location_tag",
        "location_tag_why",
      ],
    },
  };
}

const MAX_ATTEMPTS = 3;

// Wraps the (large, ~5000-token) system prompt with a cache breakpoint.
// Doesn't change what the model sees - same text, same behavior - only
// what it costs to re-send. Anthropic's cache is a prefix match keyed on
// the exact request shape (tools + system), not scoped to one call, so
// this helps whenever the identical platform+length request repeats within
// the ~5min TTL: a retry after a malformed response (generatePost()'s own
// retry loop re-sends the same call shape), or two people generating the
// same platform/length close together. It does NOT let the hashtag step
// reuse the main call's cache within a single generation, since that call
// has a different tools array (none) - a genuinely different prefix.
function cachedSystemBlock(systemPrompt) {
  return [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }];
}

function parseDelimitedList(value, delimiterRegex) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value
    .split(delimiterRegex)
    .map((v) => v.trim())
    .filter(Boolean);
}

function parseHashtags(value) {
  let tags = parseDelimitedList(value, /,/);
  // Fallback: if no commas were used (e.g. newline or space-separated
  // instead), try splitting on whitespace before individual #tokens.
  if (tags.length < 2 && typeof value === "string") {
    const spaced = value.split(/\s+/).map((v) => v.trim()).filter(Boolean);
    if (spaced.length > tags.length) tags = spaced;
  }
  return tags.map((t) => (t.startsWith("#") ? t : `#${t}`));
}

function parseShotNotes(value) {
  let notes = parseDelimitedList(value, /\n+/);
  // Fallback seen in testing: notes run together as one paragraph
  // separated by ". " between sentences instead of actual newlines.
  if (notes.length < 3 && typeof value === "string") {
    const bySentence = value
      .split(/\.\s+(?=[A-Z])/)
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => (v.endsWith(".") ? v : `${v}.`));
    if (bySentence.length > notes.length) notes = bySentence;
  }
  return notes;
}

// The dedicated, always-run hashtag step - not a conditional repair. No
// tools, no schema, two small jobs: write the hashtag strategy rationale
// and pick 5 tags, both from the finished caption (the caller parses the
// two apart - see the ---TAGS--- delimiter in attemptGeneration's
// hashtagPrompt). Reuses the same system prompt as the main call (voice
// formula, algorithm research, virality-pattern rules) so both are
// grounded in the same rules, not generic.
async function pickHashtags(apiKey, systemPrompt, prompt) {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 500,
      system: cachedSystemBlock(systemPrompt),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Hashtag step returned ${res.status}: ${detail.slice(0, 300)}`);
    err.nonRetryable = res.status !== 429 && res.status < 500;
    throw err;
  }

  const data = await res.json();
  const textBlock = (data?.content || []).find((b) => b.type === "text");
  return textBlock?.text?.trim() || "";
}

// Two optional, per-platform extras - only run when the user explicitly
// asks for them (separate opt-in toggles, not a default), and each its
// own small call for the same reason hashtag_rationale moved out of the
// main schema: these are exactly the kind of "nice to have" field that
// gets shortcut once a schema is crowded, so they never touch
// buildSubmitPostTool at all. Both degrade to null on any failure -
// they're genuinely optional, so a failure here should never block or
// retry the actual post generation the way a missing required field does.
async function writeVoiceoverScript(apiKey, systemPrompt, description, hookStrategy, resolvedLength, platformLabel) {
  const prompt = `
The ${platformLabel} caption for this post has already been written:

${description}

Hook strategy behind it: ${hookStrategy}

Write a voiceover script version of this same post - the actual words to speak into a mic while filming, not the on-screen caption read aloud. Spoken language is different from written: shorter sentences, natural pauses, contractions, a real conversational rhythm - something a person would actually say, not something that sounds like a caption being narrated. Cover the same story beats in the same order, rephrased for speech. Aim for roughly what a ${resolvedLength}-second video needs at a natural speaking pace (~2.5 words/second is a rough guide - don't pad or rush just to hit it exactly). No hashtags, no emoji, no location-pin line - just the spoken words, ready to read straight off the screen while filming.

Respond with ONLY the voiceover script text, nothing else.
`.trim();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: cachedSystemBlock(systemPrompt),
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data?.content || []).find((b) => b.type === "text");
    return textBlock?.text?.trim() || null;
  } catch {
    return null;
  }
}

// Unlike suggestStyling below, this DOES search - trending audio is
// genuinely time-sensitive (a "trending sound" is a live, weekly-shifting
// fact, not general knowledge the model can reliably know), and for
// TikTok/Reels specifically, riding an actual trending sound is arguably
// as real a reach lever as the hashtag search already gets. Same
// integrity rule as hashtags/location tags applies: the trending pick is
// only offered if the search actually found something that genuinely
// fits - never a forced/irrelevant trend just because it's popular. The
// evergreen picks stay as a fallback/complement either way, so a topic
// with no good trending match still gets a real recommendation.
async function suggestMusic(apiKey, description, hookStrategy, patternUsed, platformLabel) {
  const prompt = `
The ${platformLabel} post this music is for:

${description}

Hook strategy: ${hookStrategy}
Pattern used: ${patternUsed}

Do ONE web search for currently trending ${platformLabel} sounds/audio that could genuinely fit this specific content's mood or topic (e.g. "trending ${platformLabel} sounds [topic/mood] 2026") to check what's live right now.

If this video were cut to music instead of a voiceover, recommend audio for it:
1. If the search found a real sound that's genuinely trending on ${platformLabel} right now AND actually fits this content's mood/topic - not just popular in general - name it first and end that line with "(trending now)". Only include this if it's a genuine fit; never force an irrelevant trending sound onto this topic just because it's popular. If nothing trending genuinely fits, skip this and say so isn't needed - just don't include a trending pick.
2. Then name 2-3 SPECIFIC real evergreen songs or artists (not necessarily trending) that also fit the mood, as a backup/alternative - actual titles and artist names, not a mood/instrumentation/tempo description.
Only name something you're confident is real - never invent a song, artist, or trend. A few words per pick on why it fits is plenty (3-6 words) - not a sentence, and never a paragraph explaining the reasoning.

Respond with ONLY a short list, one pick per line, nothing else - no intro, no closing line. Format each line exactly like this:
Artist - "Song Title" - three to six words on why
Artist - "Song Title" - three to six words on why (trending now)
`.trim();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();
    return text || null;
  } catch {
    return null;
  }
}

// A third optional extra, but platform-agnostic (what to wear doesn't
// change based on which app the video goes to) - so unlike the two
// above, this is exported and called once per "Generate" click from
// route.js/page.js, same pre-fetch pattern as analyzeRestaurant() and
// findLocationTagOptions(). No system prompt reused here (no voice/tone
// needed for wardrobe advice) and no web search - general styling
// judgment is low-stakes enough not to need live verification the way a
// menu or a popularity claim does.
export async function suggestStyling(idea, location, storyBeat) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `
Idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}

Suggest what to wear while filming this content - focus on colors, accessories, or seasonal choices that would work well on camera for this specific location/activity, not a full outfit prescription. Consider: contrast against the setting often reads better on camera than matching it (e.g. a cool color against a warm-toned venue, or vice versa), practicality for the actual activity (a hike vs. a spa visit vs. a restaurant), and the season/setting's natural aesthetic. Keep it concrete and specific to this exact topic, not generic "wear something comfortable" advice. 2-4 sentences.

Respond with ONLY the styling suggestion, nothing else.
`.trim();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const textBlock = (data?.content || []).find((b) => b.type === "text");
    return textBlock?.text?.trim() || null;
  } catch {
    return null;
  }
}

// Replaces the old auto-detect-and-search approach (the model used to
// guess from idea/location/notes whether a post was about a restaurant,
// then hope a web search found an accurate current menu). That's gone -
// the user now says so explicitly (the Restaurant checkbox in the UI)
// and provides the real current source directly: a menu link (read via
// WEB_FETCH_TOOL) and/or an uploaded photo/PDF of the menu (read inline
// as a content block, no tool needed for that part). Only called at all
// when the checkbox is on - unlike the old version, non-restaurant posts
// now pay nothing for this step, not even a quick detection probe.
// Also searches the restaurant's name specifically for anything beyond
// the menu itself - buzz, reputation, a dish people talk about online -
// since the menu only tells you what's served, not what's worth talking
// about. Same integrity rule as hashtags/location tags: a "viral" menu
// item only gets surfaced if something genuinely stands out - never
// forced onto an unremarkable item just to have something to say.
// Degrades to null on any failure, same as every other pre-fetch here.
export async function analyzeRestaurant({
  restaurantName,
  location,
  idea,
  storyBeat,
  menuLink,
  menuFileBase64,
  menuFileMediaType,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !restaurantName) return null;

  const hasMenuSource = !!(menuLink || menuFileBase64);

  const promptText = `
You're helping prepare a content post about a specific restaurant/bar. Here's the topic:
Restaurant name: ${restaurantName}
Location: ${location}
Idea: ${idea}
Story beat / detail: ${storyBeat || "(none given)"}
${menuLink ? `Current menu link (fetch this directly with the web_fetch tool): ${menuLink}\n` : ""}${
    menuFileBase64 ? "The current menu is also attached below as an image/document - read it directly.\n" : ""
  }
Do both of these:
1. ${
    hasMenuSource
      ? "Read the current menu from the link and/or attachment above."
      : "No menu source was provided, so skip this part."
  } Identify ONE menu item, if any, that's genuinely distinctive enough to be a real hook for a viral post - an unusual combination, a dramatic presentation, a memorable name, something a typical menu at a similar place wouldn't have. Only name one if it's GENUINELY unique - if nothing on the menu stands out, say so plainly rather than forcing an unremarkable item to sound exciting. Never invent a menu item that isn't actually there.
2. Do ONE web search for "${restaurantName}${location ? ` ${location}` : ""}" to check for anything else that could genuinely help this post - recent buzz, a distinctive reputation, an award, a specific dish or detail people are talking about online. If nothing useful turns up, say so plainly rather than inventing a finding.

Respond with a short plain-text summary (under 150 words) covering both, clearly noting whenever something wasn't found rather than guessing.
`.trim();

  const content = [{ type: "text", text: promptText }];
  if (menuFileBase64 && menuFileMediaType) {
    content.push({
      type: menuFileMediaType.startsWith("image/") ? "image" : "document",
      source: {
        type: "base64",
        media_type: menuFileMediaType,
        data: menuFileBase64,
      },
    });
  }

  const tools = [WEB_SEARCH_TOOL];
  if (menuLink) tools.push(WEB_FETCH_TOOL);

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        tools,
        messages: [{ role: "user", content }],
      }),
    });

    if (!res.ok) {
      console.error("[analyzeRestaurant] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();

    return text || null;
  } catch (err) {
    console.error("[analyzeRestaurant] threw:", err);
    return null;
  }
}

// A second dedicated pre-fetch, same shape and same reasoning as
// analyzeRestaurant() above - one focused web_search-backed call, run
// once per request rather than asked of the model mid-generation. Added
// after a live test showed the location_tag field's "which nearby place
// is more well-known" judgment, made from the model's general knowledge
// alone, isn't reliable - the same topic picked Acadia National Park in
// one run and Bar Harbor in another, and a real check confirmed Acadia
// (America's most-visited national park, ~4M visitors/year) clearly beats
// Bar Harbor specifically, which the guess-based answer got wrong once.
// Unlike the menu check, this isn't conditional on topic type - almost
// every post has a real-world location worth checking, so it always runs.
// Degrades silently to null on any failure, same as the menu check - a
// missing result just means location_tag falls back to the model's own
// judgment, not a blocked generation.
export async function findLocationTagOptions(idea, location, storyBeat) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const prompt = `
You're helping choose a location tag for a social post. Here's the topic:
Idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}

Do ONE web search to check real search/tourism popularity for the exact venue above versus well-known nearby real places (a national park, a well-known town or city, a notable landmark) that could honestly describe or be near this location. Look for concrete evidence of relative popularity - visitor numbers, "most visited" rankings, search interest - not just a guess.

Respond with a short plain-text summary (under 120 words): name the real nearby options you found, and say which one (if any) clearly has more search/tourism interest than the exact venue, citing whatever concrete detail you found (a visitor count, a ranking, etc.) if available. If the exact venue is already the most well-known option, or no genuinely bigger nearby alternative exists, say that plainly instead of forcing one.

No other text.
`.trim();

  try {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        tools: [WEB_SEARCH_TOOL],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();

    return text || null;
  } catch {
    return null;
  }
}

export async function generatePost(params) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md)."
    );
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await attemptGeneration(params, apiKey, attempt);
      return result;
    } catch (err) {
      lastError = err;
      console.error(
        `[claude] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${params.platform}: ${err.message}`
      );
      // Account/auth/billing failures (bad key, no credit, rate limit) will
      // fail identically every time - retrying just wastes attempts and
      // time. Only a malformed-response failure (a probabilistic glitch,
      // thrown without this flag) is worth retrying.
      if (err.nonRetryable) break;
    }
  }

  throw new Error(`${lastError.message}${lastError.nonRetryable ? "" : ` (failed after ${MAX_ATTEMPTS} attempts)`}`);
}

// One full generation attempt: the main submit_post call (description, hook,
// length, shot notes, cover text, hashtag strategy), then the always-run
// hashtag step. If either half comes back malformed, this throws and
// generatePost()'s retry loop redoes the whole attempt fresh - simpler and
// more honest than patching a broken response after the fact.
async function attemptGeneration(
  {
    idea,
    location,
    storyBeat,
    notes,
    liveTrends,
    restaurantContext,
    locationContext,
    lengthSeconds,
    platform,
    includeVoiceover,
    includeMusic,
  },
  apiKey,
  attemptNumber
) {
  const platformLabel = platformLabelFor(platform);
  const resolvedLength = lengthSeconds === 30 ? 30 : 60;

  const trendLines = (liveTrends || [])
    .map((h) => `${h.tag}${h.posts ? ` (${h.posts} posts)` : ""}`)
    .join(", ");

  const systemPrompt = buildSystemPrompt(resolvedLength, platform);

  const userPrompt = `
Platform for this package: ${platformLabel}
Topic / idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given - use your judgment based on the topic)"}
Target length: ~${resolvedLength} seconds (fixed, applies the same across platforms - see length rules in the system prompt for what this means for TikTok monetization eligibility)
Anything else to factor in (optional free text from the user - a trending hashtag/sound they spotted, an idea, a detail, anything): ${notes || "(none)"}
Pre-fetched trending hashtags for this topic (optional, use only what genuinely fits): ${
    trendLines || "(none available)"
  }
${
  restaurantContext
    ? `\nRestaurant context (already verified before this call - the current menu, read directly from what the user provided, plus a live search for anything else genuinely useful about this specific restaurant): ${restaurantContext}\nOnly name a specific dish or drink if it's confirmed above - if you're not sure something's still on the menu, describe generally (e.g. "their seafood dishes," "a specialty cocktail") instead of naming an unconfirmed item.\n`
    : ""
}${
  locationContext
    ? `\nLocation tag research (already verified via a live search before this call, so you don't need to guess at relative popularity): ${locationContext}\nUse this to inform location_tag - still following this platform's specific location-tag rules above and the integrity rule (must be real, close, and honest about what the content is about).\n`
    : ""
}
Before writing, do ONE web search for currently trending ${platformLabel} hashtags or sounds relevant to this specific topic/location (e.g. "trending ${platformLabel.toLowerCase()} hashtags [topic] 2026" or "[location] ${platformLabel.toLowerCase()} trend") to check what's live right now - unless pre-fetched trending hashtags were already given above, in which case skip the search and use those. If the user gave free-text notes above, fold whatever's relevant into the search query too (e.g. a hashtag or sound they mentioned) and weigh it heavily if it's genuinely usable. If anything from that search is worth carrying forward, mention it in hook_strategy if it shaped the hook, or just let it inform the finished caption - the hashtag strategy and final 5 tags are handled entirely in a separate step after this one, so don't write anything hashtag-specific here.

Write the ${platformLabel} post now, following the system instructions exactly, then call submit_post with the complete result.
`.trim();

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      // A ceiling, not a target - only billed for what's actually
      // generated. Generous headroom against truncation, not a cost driver.
      max_tokens: 10000,
      system: cachedSystemBlock(systemPrompt),
      tools: [WEB_SEARCH_TOOL, buildSubmitPostTool(platform)],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const err = new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
    // 429 (rate limit) and 5xx (transient server issues) are worth
    // retrying; everything else (400 bad request/billing, 401/403
    // auth/key problems) will fail identically every time.
    err.nonRetryable = res.status !== 429 && res.status < 500;
    throw err;
  }

  const data = await res.json();
  const blocks = data?.content || [];

  const usedWebSearch = blocks.some(
    (b) => b.type === "server_tool_use" && b.name === "web_search"
  );

  const submitBlock = blocks.find(
    (b) => b.type === "tool_use" && b.name === "submit_post"
  );

  console.log(
    `[claude] platform=${platform} attempt=${attemptNumber} stop_reason=${data?.stop_reason} content_blocks=${blocks.length} used_web_search=${usedWebSearch} got_submit_post=${!!submitBlock} ` +
      `input_tok=${data?.usage?.input_tokens} output_tok=${data?.usage?.output_tokens} cache_read=${data?.usage?.cache_read_input_tokens ?? 0} cache_write=${data?.usage?.cache_creation_input_tokens ?? 0}`
  );

  if (!submitBlock) {
    const textBlocks = blocks.filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n");
    console.error("[claude] no submit_post tool call in response:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude did not call submit_post for ${platformLabel} (stop_reason: ${data?.stop_reason}). ${
        text ? `It said instead: ${text.slice(0, 500)}` : "No text content either - see server logs."
      }`
    );
  }

  const input = submitBlock.input || {};
  const shotNotes = parseShotNotes(input.shot_notes);

  const problems = [];
  if (platform === "youtube" && !input.title) problems.push("title is missing");
  if (!input.description) problems.push("description is missing");
  if (shotNotes.length < 3) {
    problems.push(`shot_notes did not parse to at least 3 (got ${shotNotes.length} from: ${JSON.stringify(input.shot_notes)})`);
  }
  if (typeof input.video_length_why !== "string" || !input.video_length_why) {
    problems.push(`video_length_why is missing or malformed (got: ${JSON.stringify(input.video_length_why)})`);
  }
  if (!input.location_tag) problems.push("location_tag is missing");
  if (!input.location_tag_why) problems.push("location_tag_why is missing");

  if (problems.length > 0) {
    console.error(`[claude] malformed submit_post input for ${platformLabel} (attempt ${attemptNumber}):`, JSON.stringify(input).slice(0, 1500));
    throw new Error(`Claude's ${platformLabel} response was incomplete: ${problems.join("; ")}`);
  }

  // Always run - not conditional on the main call failing. This is now the
  // standard second step of every generation, since the 5-tag list (and,
  // once the schema got crowded enough, the rationale that used to travel
  // with it) was what kept breaking inside the bigger call. This call
  // reasons about hashtag strategy fresh, from the finished caption and
  // trend data directly, rather than depending on a field the main call
  // wrote - one less thing that can go missing there.
  const hashtagPrompt = `
Topic: ${idea} at ${location}${storyBeat ? `. Story beat: ${storyBeat}` : ""}.
Pre-fetched/live trending hashtags for this topic, if any (use only what genuinely fits): ${trendLines || "(none available)"}
Anything else the user wanted factored in: ${notes || "(none)"}

The ${platformLabel} caption has already been written:

${input.description}

Do not call submit_post. Instead, following the hashtag rules in the system prompt above (the 5-tag broad/niche/community structure, this platform's own tag conventions - never another platform's naming style) and the trend data above, do two things:

1. Write a short (1-3 sentence) neutral, plain-language rationale for the hashtag strategy - same tone/rules as the system prompt's other reasoning fields (no "her/she", never the literal words "Source A" or "Source B", no naming a specific past post). If the trend data above surfaced something genuinely usable, say so; if not, say that plainly rather than inventing a finding.
2. Exactly 5 hashtags, lowercase, each starting with #, following THIS platform's own tag conventions specifically. If the trend data above already gives you a real, correctly-formatted tag, use it exactly as found - do not re-derive or append to it (e.g. a found tag "foodtok" stays "#foodtok", never "#foodtoktok").

Respond in EXACTLY this format and nothing else - the rationale, then a line with just ---TAGS---, then the 5 comma-separated hashtags:
<rationale>
---TAGS---
#tag1, #tag2, #tag3, #tag4, #tag5
`.trim();

  const hashtagStepRaw = await pickHashtags(apiKey, systemPrompt, hashtagPrompt);
  const [rationalePart, tagsPart] = hashtagStepRaw.split(/---TAGS---/i);
  const hashtagRationale = (rationalePart || "").trim();
  const hashtags = parseHashtags((tagsPart || "").trim());

  if (!hashtagRationale || hashtags.length !== 5) {
    console.error(`[claude] hashtag step for ${platformLabel} (attempt ${attemptNumber}) malformed. Got:`, JSON.stringify(hashtagStepRaw).slice(0, 800));
    throw new Error(
      `Claude's ${platformLabel} hashtag step was malformed (rationale ${hashtagRationale ? "present" : "missing"}, got ${hashtags.length}/5 tags)`
    );
  }

  // Both optional, both opt-in (separate toggles, not bundled - some days
  // it's a voiceover, some days a music-set reel, not necessarily both),
  // and both run in parallel since neither depends on the other. Skipped
  // entirely (not even called) when not requested, so the common case
  // (neither toggle on) pays zero extra latency or cost for this step.
  const [voiceoverScript, musicSuggestion] = await Promise.all([
    includeVoiceover
      ? writeVoiceoverScript(apiKey, systemPrompt, input.description, input.hook_strategy, resolvedLength, platformLabel)
      : Promise.resolve(null),
    includeMusic
      ? suggestMusic(apiKey, input.description, input.hook_strategy, input.pattern_used, platformLabel)
      : Promise.resolve(null),
  ]);

  // Reshape video_length_why back into the nested video_length shape (paired
  // with the computed range, never model-generated - see buildSubmitPostTool()
  // above), and the delimited-string shot_notes back into an array, so the
  // rest of the app is unaffected by how these are represented in the tool
  // schema.
  const { video_length_why, shot_notes, ...rest } = input;

  return {
    ...rest,
    hashtags,
    hashtag_rationale: hashtagRationale,
    shot_notes: shotNotes.slice(0, 5),
    video_length: {
      target_seconds: `${resolvedLength - 3}-${resolvedLength + 3}s`,
      why: video_length_why,
    },
    voiceover_script: voiceoverScript,
    music_suggestion: musicSuggestion,
    usedWebSearch,
  };
}
