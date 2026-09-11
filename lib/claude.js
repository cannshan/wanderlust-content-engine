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

// Splits a "---VIRAL---" / "---HIDDEN---" delimited response into the two
// lists findNearbyFilmingIdeas() returns.
//
// This started as a pipe-delimited "one line per place" format (same
// approach as pickHashtags()'s "---TAGS---" marker), but live testing
// broke it twice: the model doesn't reliably keep a place on one physical
// line once it's quoting a real review or citation - long WHY text
// wraps, and a stray "|" or reordered fragment then corrupts the
// positional split entirely (a quoted phrase like `"Maine's most popular
// mountain" | Film a golden-hour summit hike` got sliced apart on its own
// internal punctuation). Labeled fields (NAME:/CATEGORY:/etc.) are
// immune to that - a field's value can wrap across as many lines as it
// needs, and stray punctuation anywhere in it can't be mistaken for a
// field boundary the way a bare "|" could.
const NEARBY_FIELD_LABELS = {
  "NAME:": "name",
  "CATEGORY:": "category",
  "DISTANCE:": "distance",
  "WHY:": "why",
  "ANGLE:": "angle",
};

function parseNearbyIdeasSection(sectionText) {
  if (!sectionText) return [];
  const lines = sectionText.split(/\n/).map((line) => line.trim());

  const places = [];
  let current = null;
  let currentField = null;

  for (const line of lines) {
    if (!line) continue;
    const label = Object.keys(NEARBY_FIELD_LABELS).find((l) => line.toUpperCase().startsWith(l));
    if (label) {
      const field = NEARBY_FIELD_LABELS[label];
      const value = line.slice(label.length).trim();
      if (field === "name") {
        if (current?.name) places.push(current);
        current = { name: value, category: "", distance: "distance not confirmed", why: "", angle: "" };
      } else if (current) {
        current[field] = value;
      }
      currentField = field;
    } else if (current && currentField) {
      // A wrapped continuation of whatever field was last labeled.
      current[currentField] = current[currentField] ? `${current[currentField]} ${line}` : line;
    }
  }
  if (current?.name) places.push(current);
  return places;
}

function parseNearbyIdeas(text) {
  const hiddenIndex = text.search(/---HIDDEN---/i);
  const viralPart = hiddenIndex === -1 ? text : text.slice(0, hiddenIndex);
  const hiddenPart = hiddenIndex === -1 ? "" : text.slice(hiddenIndex);

  return {
    viral: parseNearbyIdeasSection(viralPart.replace(/---VIRAL---/i, "")),
    hidden: parseNearbyIdeasSection(hiddenPart.replace(/---HIDDEN---/i, "")),
  };
}

// A fifth optional pre-fetch, same shape as analyzeRestaurant()/
// findLocationTagOptions() above but triggered on demand from the
// finished result (see page.js) rather than run automatically on every
// "Generate" click - most generations don't need a whole day of nearby
// filming stops planned out, and this does several searches, so it isn't
// worth paying for by default.
//
// Two separate search passes (proven-popular vs. overlooked) rather than
// one combined ask - a single search tends to surface only the
// well-known results first, which would bias the "hidden gem" bucket
// toward padding with moderately-known filler. Same integrity rule as
// every other search-grounded field in this file: never invent a place,
// never force a "proven" or "hidden gem" label without real evidence,
// and an empty bucket is an honest, valid result - not something to pad.
//
// "10 miles" is necessarily an estimate, not a GPS-verified radius -
// there's no maps/geocoding API in this app, so distance here comes only
// from what search results themselves state (a stated drive time, a
// "X miles from downtown" mention, etc.); the model is told explicitly
// to say "distance not confirmed" rather than guess one.
export async function findNearbyFilmingIdeas({ idea, location, storyBeat, categories }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !location) return null;

  // "All categories" used to search generically once and often came back
  // thin compared to picking a single category like "foodie" - a single
  // broad search tends to lock onto whichever category the model reaches
  // for first rather than genuinely covering all of them. Telling it
  // explicitly to spread searches across a few different types, and
  // giving it more search budget/output room to do so, is what actually
  // fixes that (not just asking nicer for "more results").
  const isAllCategories = !categories || categories.length === 0 || categories.includes("all");
  const categoryLine = isAllCategories
    ? "Any category - foodie/quick bites, restaurants/sit-down dining, hiking/outdoors, speakeasies/bars, museums/indoor culture, or anything else genuinely worth filming. Since no specific category was chosen, deliberately spread your searches across a few different types (don't just search one narrow angle and stop) so the results end up varied, not narrow."
    : `Specifically: ${categories.join(", ")}.`;

  const prompt = `
You're helping plan a single filming day around a primary idea that's already chosen, so multiple things can be filmed nearby without a second trip out.

Primary idea already chosen: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}
Category focus: ${categoryLine}

Find real, specific places within roughly a 10-mile / short-drive radius of ${location} worth filming alongside the primary idea above. Do this in two separate search passes:

1. Search for what's genuinely already popular/proven near this location in the requested category focus - places with real evidence of social buzz, strong reviews, being locally well-known or frequently posted about.
2. Search separately for overlooked options nearby in the same category focus - places that are newly opened, rarely covered on social media, under-the-radar, or seem to have real filming potential but haven't been discovered yet.

For every place in both passes, only include it if you have genuine search evidence backing both its category fit and its bucket (already-popular vs. overlooked) - never invent a place, never guess a distance without evidence (say "distance not confirmed" rather than making one up), and never force a "proven" or "hidden gem" label onto something the search didn't actually support. If a pass turns up nothing genuinely fitting, leave that section's list empty rather than padding it with mediocre or moderately-known filler - an honest "nothing stood out" is a valid result. That said, if the category focus is broad ("any category"), make a genuine effort across each type before giving up on a section - an empty section should mean the search really found nothing, not that only one category got checked.

Respond in EXACTLY this format and nothing else - up to 7 places per section, each place as five labeled lines in this exact order. A field's text can wrap onto more than one line if it needs to (keep wrapped lines plain, no new label on them) - just always start the NEXT field on its own line with its label:
---VIRAL---
NAME: <place name>
CATEGORY: <category>
DISTANCE: <distance or drive time if found, else "distance not confirmed">
WHY: <why it's already proven, citing real evidence - a sentence or two is fine>
ANGLE: <one line content angle for filming it here>
---HIDDEN---
NAME: <place name>
CATEGORY: <category>
DISTANCE: <distance or drive time if found, else "distance not confirmed">
WHY: <why it's overlooked/new/low-presence, citing real evidence - a sentence or two is fine>
ANGLE: <one line content angle for filming it here>

If a section has nothing genuinely fitting, leave it with no NAME: lines at all rather than forcing an entry in.

For example, a real VIRAL entry looks exactly like this:
NAME: Kettle Cove State Park
CATEGORY: hiking/coastal walk
DISTANCE: ~8 miles, 15 min drive
WHY: Consistently one of the most-photographed spots in the area per recent local coverage and reviews.
ANGLE: Open on the tide pools at low tide, then pan up to the full cove view
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
        // More search budget and output room when covering "any category"
        // - it genuinely needs to check more ground than a single-category
        // search does. Specific-category runs keep the original budget,
        // which was already reliable for those in testing.
        max_tokens: isAllCategories ? 4500 : 3000,
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: isAllCategories ? 8 : 5 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[findNearbyFilmingIdeas] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();
    const parsed = parseNearbyIdeas(text);

    if (parsed.viral.length === 0 && parsed.hidden.length === 0) {
      console.error("[findNearbyFilmingIdeas] parsed to zero places, raw text:", text.slice(0, 2000));
    }

    return parsed;
  } catch (err) {
    console.error("[findNearbyFilmingIdeas] threw:", err);
    return null;
  }
}

// Same labeled-field/section-delimiter approach as parseNearbyIdeas above
// (see the comment on NEARBY_FIELD_LABELS for why - long WHY text with a
// stray "|" or a quoted review broke an earlier pipe-delimited format),
// but with an AREA field instead of DISTANCE: this isn't "near a primary
// idea already chosen," it's a standalone search across a whole named
// location (which might be a small town or an entire state), so "which
// town/area within the search location" is the useful fact, not a drive
// time from a specific point that doesn't exist here.
const DISCOVERY_FIELD_LABELS = {
  "NAME:": "name",
  "CATEGORY:": "category",
  "AREA:": "area",
  "WHY:": "why",
  "ANGLE:": "angle",
};

function parseDiscoverySection(sectionText) {
  if (!sectionText) return [];
  const lines = sectionText.split(/\n/).map((line) => line.trim());

  const places = [];
  let current = null;
  let currentField = null;

  for (const line of lines) {
    if (!line) continue;
    const label = Object.keys(DISCOVERY_FIELD_LABELS).find((l) => line.toUpperCase().startsWith(l));
    if (label) {
      const field = DISCOVERY_FIELD_LABELS[label];
      const value = line.slice(label.length).trim();
      if (field === "name") {
        if (current?.name) places.push(current);
        current = { name: value, category: "", area: "area not specified", why: "", angle: "" };
      } else if (current) {
        current[field] = value;
      }
      currentField = field;
    } else if (current && currentField) {
      current[currentField] = current[currentField] ? `${current[currentField]} ${line}` : line;
    }
  }
  if (current?.name) places.push(current);
  return places;
}

function parseDiscoveryIdeas(text) {
  const interestingIndex = text.search(/---INTERESTING---/i);
  const hiddenIndex = text.search(/---HIDDEN---/i);

  const popularPart = interestingIndex === -1 ? text : text.slice(0, interestingIndex);
  const interestingPart =
    interestingIndex === -1
      ? ""
      : hiddenIndex === -1
      ? text.slice(interestingIndex)
      : text.slice(interestingIndex, hiddenIndex);
  const hiddenPart = hiddenIndex === -1 ? "" : text.slice(hiddenIndex);

  return {
    popular: parseDiscoverySection(popularPart.replace(/---POPULAR---/i, "")),
    interesting: parseDiscoverySection(interestingPart.replace(/---INTERESTING---/i, "")),
    hidden: parseDiscoverySection(hiddenPart.replace(/---HIDDEN---/i, "")),
  };
}

// Powers the standalone Discovery tab - unlike findNearbyFilmingIdeas
// above, this isn't anchored to a primary idea already chosen; it's a
// direct "what's worth doing/filming in this location" search, and the
// location itself might be as broad as a whole state (e.g. "Maine"), not
// just one venue's immediate area. Three search passes instead of two -
// popular/proven, genuinely interesting-but-not-mainstream, and hidden
// gems - since collapsing "interesting" and "hidden gem" into one bucket
// tends to bias toward whichever the model finds first. Same integrity
// rule as every other search-grounded feature in this file: never invent
// a place, never force a bucket label without real evidence, an empty
// section is an honest result.
export async function findDiscoveryIdeas({ location, categories }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !location) return null;

  const isAllCategories = !categories || categories.length === 0 || categories.includes("all");
  const categoryLine = isAllCategories
    ? "Any category - foodie/quick bites, restaurants/sit-down dining, hiking/outdoors, speakeasies/bars, museums/indoor culture, or anything else genuinely worth doing/filming. Since no specific category was chosen, deliberately spread your searches across a few different types (don't just search one narrow angle and stop) so results end up varied, not narrow."
    : `Specifically: ${categories.join(", ")}.`;

  const prompt = `
You're helping a travel content creator discover real things to do in a location - not tied to any specific idea already chosen, just genuinely worth visiting/filming there.

Location: ${location}
Category focus: ${categoryLine}

Find real, specific places or experiences in and around ${location} - if this is a broad area (a whole state or region, not one town), spread results across different towns/areas within it rather than clustering on just one spot. Do this in THREE separate search passes:

1. Search for what's genuinely already popular there - well-known draws with real evidence of tourism traffic, strong reviews, or being a well-known must-visit.
2. Search separately for things that are genuinely interesting or unique but not necessarily top-tourist-list material - a distinctive experience, an unusual activity, something with a real "huh, I didn't know that was here" quality, backed by real evidence it exists and is worth it.
3. Search separately for hidden gems - places that are new, under-the-radar, rarely covered, or seem to have real potential but haven't been widely discovered, with real evidence for that too.

For every place in all three passes, only include it if you have genuine search evidence backing both its category fit and which bucket it belongs in - never invent a place, never guess at an area/town without evidence (say "area not specified" rather than making one up), and never force a "popular," "interesting," or "hidden gem" label onto something the search didn't actually support. If a pass turns up nothing genuinely fitting, leave that section's list empty rather than padding it with mediocre filler - an honest "nothing stood out" is a valid result.

Respond in EXACTLY this format and nothing else - up to 7 places per section, each place as five labeled lines in this exact order. A field's text can wrap onto more than one line if it needs to (keep wrapped lines plain, no new label on them) - just always start the NEXT field on its own line with its label:
---POPULAR---
NAME: <place name>
CATEGORY: <category>
AREA: <town/neighborhood within ${location}, or "area not specified">
WHY: <why it's genuinely popular, citing real evidence - a sentence or two is fine>
ANGLE: <one line content/filming angle>
---INTERESTING---
NAME: <place name>
CATEGORY: <category>
AREA: <town/neighborhood, or "area not specified">
WHY: <why it's a genuinely interesting/unique find, citing real evidence>
ANGLE: <one line content/filming angle>
---HIDDEN---
NAME: <place name>
CATEGORY: <category>
AREA: <town/neighborhood, or "area not specified">
WHY: <why it's overlooked/new/low-presence, citing real evidence>
ANGLE: <one line content/filming angle>

If a section has nothing genuinely fitting, leave it with no NAME: lines at all rather than forcing an entry in.

For example, a real HIDDEN entry looks exactly like this:
NAME: Neat Speakeasy
CATEGORY: speakeasies/bars
AREA: Boothbay Harbor
WHY: A speakeasy-style bar behind an unmarked door, rarely covered outside a handful of local write-ups.
ANGLE: Film the search for the unmarked entrance, then the reveal when it opens into the bar
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
        // Three passes instead of findNearbyFilmingIdeas' two, so this
        // needs more search budget and output room to match - especially
        // for "any category," which has to spread across types on top of
        // that.
        max_tokens: isAllCategories ? 5500 : 4000,
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: isAllCategories ? 9 : 6 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[findDiscoveryIdeas] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();
    const parsed = parseDiscoveryIdeas(text);

    if (parsed.popular.length === 0 && parsed.interesting.length === 0 && parsed.hidden.length === 0) {
      console.error("[findDiscoveryIdeas] parsed to zero places, raw text:", text.slice(0, 2000));
    }

    return parsed;
  } catch (err) {
    console.error("[findDiscoveryIdeas] threw:", err);
    return null;
  }
}

// Delivers the finished voiceover for the Reel Voiceover tab. Unlike
// writeVoiceoverScript() above (which narrates an already-written caption
// for a post that doesn't exist as footage yet), this is grounded in real
// footage the user already filmed - frames sampled evenly across the
// video client-side (see lib/videoFrames.js) and sent here as image
// blocks in chronological order. A dedicated tool call, not free text,
// because accuracy matters more here than anywhere else in this file: the
// entire point is that the script matches what's actually on screen, so
// this needs the same reliability treatment buildSubmitPostTool() gets,
// not the looser free-text format pickHashtags()/writeVoiceoverScript()
// use for genuinely optional fields.
function buildReelVoiceoverTool() {
  return {
    name: "submit_reel_voiceover",
    description: "Deliver the finished voiceover script for this reel, after reviewing all the sampled frames in order. Call exactly once, when both fields are ready.",
    input_schema: {
      type: "object",
      properties: {
        scene_summary: {
          type: "string",
          description: "A short, plain-language rundown of what actually happens in the footage, in chronological order, as one string with each beat on its own line separated by a newline character (\\n) - not numbered, not a JSON array. This is shown to the user so they can sanity-check the voiceover actually matches their footage, so be concrete about what's shown and in what order, not a vague vibe summary.",
        },
        voiceover_script: {
          type: "string",
          description: "The actual words to speak over this exact footage, following the real order of events shown in the sampled frames - do not invent a beat, location detail, or moment that isn't actually visible in them. Spoken language, not a caption read aloud: short sentences, natural pauses, contractions, real conversational rhythm - something a person would actually say on camera, timed to roughly match how the footage's beats are paced across its real length. If idea/location/notes context was given, use it only for names and facts (a restaurant name, a city), never to add a scene that isn't actually shown. Aim for what the given duration needs at a natural speaking pace (~2.5 words/second is a rough guide - don't pad or rush just to hit it exactly). No hashtags, no emoji, no location-pin line - just the spoken words, ready to read straight off the screen.",
        },
      },
      required: ["scene_summary", "voiceover_script"],
    },
  };
}

// frames: [{ base64, mediaType, timestampSeconds }], already extracted
// client-side (see lib/videoFrames.js) so the original video file never
// has to be uploaded anywhere - only these small JPEG frames make the
// trip, keeping the request well under Vercel's body size limit.
export async function writeVoiceoverFromReel({ frames, durationSeconds, idea, location, notes, platform }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md).");
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("No video frames were provided.");
  }

  const resolvedPlatform = ["instagram", "youtube"].includes(platform) ? platform : "tiktok";
  // Unlike the main generator, the length here isn't a user-picked target
  // - it's however long the actual uploaded footage runs, rounded to the
  // nearest second and floored at 5s so buildSystemPrompt's length rules
  // (written assuming a real ~15-90s short-form video) don't see 0/negative.
  const roundedDuration = Math.max(5, Math.round(durationSeconds || 0));
  const systemPrompt = buildSystemPrompt(roundedDuration, resolvedPlatform);

  const introText = `
You're watching real footage a creator has already filmed, sampled as ${frames.length} frames spread evenly across the full ~${roundedDuration}-second video, in chronological order (each one labeled with its approximate timestamp). Your job is to write a voiceover script that's ACCURATE to this specific footage - not a generic travel voiceover, one that actually matches what happens on screen, in the order it happens.
${idea ? `\nWhat this is about (context for names/facts only - defer to what you actually see if it conflicts): ${idea}` : ""}
${location ? `Location: ${location}` : ""}
${notes ? `Extra context not necessarily visible on camera (names, booking details, anything worth mentioning): ${notes}` : ""}

Review the frames below in order, then call submit_reel_voiceover.
`.trim();

  const content = [{ type: "text", text: introText }];
  frames.forEach((frame, i) => {
    content.push({ type: "text", text: `Frame ${i + 1} of ${frames.length}, ~${frame.timestampSeconds}s in:` });
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: frame.mediaType || "image/jpeg",
        data: frame.base64,
      },
    });
  });

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: cachedSystemBlock(systemPrompt),
      tools: [buildReelVoiceoverTool()],
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];
  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_reel_voiceover");

  if (!submitBlock) {
    const textBlocks = blocks.filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n");
    console.error("[writeVoiceoverFromReel] no submit_reel_voiceover tool call:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude didn't return a voiceover script (stop_reason: ${data?.stop_reason}).${text ? ` It said instead: ${text.slice(0, 300)}` : ""}`
    );
  }

  const input = submitBlock.input || {};
  if (!input.voiceover_script) {
    throw new Error("Claude's response was missing the voiceover script.");
  }

  return {
    sceneSummary: parseShotNotes(input.scene_summary),
    voiceoverScript: input.voiceover_script.trim(),
  };
}

// Powers "raw clips - assemble for me" mode in the Reel Voiceover tab.
// Unlike writeVoiceoverFromReel above (one already-edited video, voiceover
// only), this takes several separate raw clips and asks Claude to actually
// EDIT them: decide which segments of which clips belong in the final cut,
// in what order, then write the voiceover for that assembled sequence -
// not the original upload order. The actual cutting/stitching happens
// client-side afterward via ffmpeg.wasm (lib/assembleReel.js); this call
// only produces the plan, never touches video bytes itself.
function buildReelEditPlanTool() {
  return {
    name: "submit_reel_edit_plan",
    description: "Deliver the finished edit plan, scene summary, and voiceover script for this reel, after reviewing every clip's sampled frames. Call exactly once, when all three fields are ready.",
    input_schema: {
      type: "object",
      properties: {
        scene_summary: {
          type: "string",
          description: "A short, plain-language rundown of the finished edit, as one string with each beat on its own line separated by a newline character (\\n) - not numbered, not a JSON array. Cover what each used clip/segment shows and why it earned a place, in final order, and briefly note anything left out and why (a blurry take, a near-duplicate of a better clip). Concrete, not a vague vibe summary - this is shown to the user to sanity-check the edit.",
        },
        edit_plan: {
          type: "array",
          description: "The finished edit, as a list of segments in final playback order. Only include a segment if it genuinely earns a place in the cut - it's completely fine, and often correct, to skip a clip entirely (a blurry take, a duplicate of a better one, dead time with nothing happening) rather than force every uploaded clip into the result. A single clip can also be split into more than one segment if two different parts of it are both worth using at different points in the edit.",
          items: {
            type: "object",
            properties: {
              clip_index: {
                type: "integer",
                description: "0-based index into the uploaded clips, in the order they're listed below (clip 0 is the first one shown).",
              },
              start_seconds: {
                type: "number",
                description: "Where this segment starts within that clip's OWN footage, in seconds, measured from that clip's own beginning (0 = the very start of that clip) - not a position in the final assembled video.",
              },
              end_seconds: {
                type: "number",
                description: "Where this segment ends within that clip's own footage, in seconds. Must be greater than start_seconds and no more than that clip's real length, given with its frames below.",
              },
            },
            required: ["clip_index", "start_seconds", "end_seconds"],
          },
        },
        voiceover_script: {
          type: "string",
          description: "The actual words to speak over the ASSEMBLED edit above - follow the real order and pacing of the final cut (not the original upload order), covering only what's actually kept in edit_plan. Spoken language, not a caption read aloud: short sentences, natural pauses, contractions, real conversational rhythm. Aim for what the edit's total length needs at a natural speaking pace (~2.5 words/second is a rough guide). If idea/location/notes context was given, use it only for names/facts the footage itself can't show - never to invent a scene that isn't actually in the kept segments. No hashtags, no emoji, no location-pin line - just the spoken words.",
        },
      },
      required: ["scene_summary", "edit_plan", "voiceover_script"],
    },
  };
}

// clips: [{ frames: [{base64, mediaType, timestampSeconds}], durationSeconds }, ...],
// already extracted client-side per clip (lib/videoFrames.js) in upload
// order - that order is only a label for Claude to reference back to
// (clip_index); it carries no creative authority over the final order.
export async function writeReelEditPlan({ clips, idea, location, notes, platform }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md).");
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new Error("No clips were provided.");
  }

  const resolvedPlatform = ["instagram", "youtube"].includes(platform) ? platform : "tiktok";
  // There's no fixed target length here the way generatePost() has one -
  // the assembled edit's length is whatever the kept segments add up to,
  // decided by the edit itself. buildSystemPrompt still needs a number for
  // its length-rule text, so this is a reasonable planning midpoint
  // (roughly a 60s TikTok Creator Rewards-eligible length) rather than a
  // real constraint on how long the final cut has to be.
  const systemPrompt = buildSystemPrompt(60, resolvedPlatform);

  const totalClipsDuration = clips.reduce((sum, c) => sum + (c.durationSeconds || 0), 0);

  const introText = `
You're editing a real reel from ${clips.length} separate raw clip${clips.length === 1 ? "" : "s"} a creator has already filmed (about ${Math.round(totalClipsDuration)}s of raw footage total), each sampled as frames spread evenly across that clip, in chronological order within the clip, and labeled with its own approximate timestamp. Your job is to act as the editor: decide which parts of which clips actually belong in a finished reel, in what order, then write the voiceover for that assembled result - not a script for the raw, unedited footage.
${idea ? `\nWhat this is about (context for names/facts only - defer to what you actually see if it conflicts): ${idea}` : ""}
${location ? `Location: ${location}` : ""}
${notes ? `Extra context not necessarily visible on camera (names, booking details, anything worth mentioning): ${notes}` : ""}

Review every clip's frames below, then call submit_reel_edit_plan with the finished edit.
`.trim();

  const content = [{ type: "text", text: introText }];
  clips.forEach((clip, clipIndex) => {
    content.push({
      type: "text",
      text: `--- Clip ${clipIndex} (${clip.frames.length} sampled frames, clip is ~${Math.round(clip.durationSeconds)}s long total) ---`,
    });
    clip.frames.forEach((frame, i) => {
      content.push({ type: "text", text: `Clip ${clipIndex}, frame ${i + 1} of ${clip.frames.length}, ~${frame.timestampSeconds}s into this clip:` });
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: frame.mediaType || "image/jpeg",
          data: frame.base64,
        },
      });
    });
  });

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2500,
      system: cachedSystemBlock(systemPrompt),
      tools: [buildReelEditPlanTool()],
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];
  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_reel_edit_plan");

  if (!submitBlock) {
    const textBlocks = blocks.filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n");
    console.error("[writeReelEditPlan] no submit_reel_edit_plan tool call:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude didn't return an edit plan (stop_reason: ${data?.stop_reason}).${text ? ` It said instead: ${text.slice(0, 300)}` : ""}`
    );
  }

  const input = submitBlock.input || {};
  if (!input.voiceover_script) {
    throw new Error("Claude's response was missing the voiceover script.");
  }

  // Guard the plan before it ever reaches ffmpeg - a bad clip_index or an
  // inverted/out-of-range time range would otherwise fail deep inside the
  // video assembly step with a much less useful error, or silently produce
  // a broken cut. Segments are clamped/dropped rather than the whole
  // request failing outright, since one malformed segment out of several
  // genuinely good ones shouldn't waste the entire edit.
  const rawPlan = Array.isArray(input.edit_plan) ? input.edit_plan : [];
  const editPlan = rawPlan
    .map((seg) => {
      const clipIndex = Number(seg?.clip_index);
      const clip = clips[clipIndex];
      if (!clip || !Number.isInteger(clipIndex)) return null;
      const clipDuration = clip.durationSeconds || 0;
      const startSeconds = Math.max(0, Number(seg?.start_seconds) || 0);
      const endSeconds = Math.min(clipDuration, Number(seg?.end_seconds) || 0);
      if (!(endSeconds > startSeconds)) return null;
      return { clipIndex, startSeconds, endSeconds };
    })
    .filter(Boolean);

  if (editPlan.length === 0) {
    console.error("[writeReelEditPlan] edit plan had no usable segments, raw:", JSON.stringify(rawPlan).slice(0, 1500));
    throw new Error("Claude couldn't find a usable cut from these clips - try different or additional footage.");
  }

  const totalDurationSeconds = editPlan.reduce((sum, seg) => sum + (seg.endSeconds - seg.startSeconds), 0);

  return {
    sceneSummary: parseShotNotes(input.scene_summary),
    editPlan,
    voiceoverScript: input.voiceover_script.trim(),
    totalDurationSeconds,
  };
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
