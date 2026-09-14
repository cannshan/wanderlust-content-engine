import { buildSystemPrompt, platformLabelFor, getCustomInstructions } from "./voiceProfile";
import { fetchOgImage } from "./ogImage";
import { getSupabase } from "./supabase";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-5";

// Same custom-instructions injection buildSystemPrompt() does for Content
// tab captions (see lib/voiceProfile.js), reused here so Profile tab rules
// also reach Discovery tab search/suggestion prompts - findDiscoveryIdeas,
// findNearbyFilmingIdeas, and suggestForPlace previously built their
// prompts independently of voiceProfile.js entirely, so a rule like "look
// for animal content" or "favor pop-culture tie-ins" only ever applied to
// caption writing, never to what actually got surfaced as a place/style/
// food suggestion in the first place - even though that's exactly the
// kind of rule someone would type in expecting it to shape search results
// too, not just how the caption for an already-chosen place gets written.
function customInstructionsBlock(customInstructions) {
  if (!customInstructions || customInstructions.length === 0) return "";
  return `\nLEAH'S OWN RULES (from the Profile tab) - follow these exactly, they win over anything else above if they ever conflict:\n${customInstructions
    .map((i) => `- ${i.text}`)
    .join("\n")}\n`;
}
// Tested switching every call in this file to Haiku 4.5 (see git history)
// and measured real, confirmed problems on the calls that require actual
// research/writing judgment, not just lower "polish": the Discovery search
// (findDiscoveryIdeas) came back with noticeably fewer real places, and
// once returned zero for a query Sonnet 5 handled fine; the food/style
// suggestion text (suggestForPlace) twice leaked raw `<cite>` markup into
// what would be user-facing text, never observed on Sonnet 5. So MODEL
// stays Sonnet 5 for every call that writes real content or does
// open-ended research. HAIKU_MODEL below is used only for the calls
// proven safe on Haiku - narrow, mechanical tasks with no real judgment
// in them - where the same test showed no quality loss at roughly half
// the cost.
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// Anthropic's published per-token rates (confirmed against
// platform.claude.com/docs/en/pricing, Sept 2026) - cache writes/reads are
// priced as multiples of the same model's input rate (1.25x / 0.1x), not
// their own flat number. Update these two lines if Anthropic repriced
// either model since.
const SONNET_INPUT_PER_TOKEN = 2 / 1_000_000;
const SONNET_OUTPUT_PER_TOKEN = 10 / 1_000_000;
const HAIKU_INPUT_PER_TOKEN = 1 / 1_000_000;
const HAIKU_OUTPUT_PER_TOKEN = 5 / 1_000_000;
const WEB_SEARCH_COST_PER_USE = 0.01; // $10/1,000 searches, flat per use regardless of result count

// Every real API call in this file was going out with zero cost
// visibility except attemptGeneration()'s own hand-rolled log line -
// there was no way to answer "what does clicking X actually cost" without
// guessing from max_tokens ceilings. This gives every call site the same
// one-line, real-dollar answer from the response Anthropic actually
// billed, not an estimate - both to the console (same as every other log
// in this file) and, when Supabase is configured, to api_cost_logs so
// spend by feature can be reviewed later instead of scrolled past in
// server logs. Awaited (not fire-and-forget) at every call site so the
// insert actually completes before a serverless function's response ends
// and the runtime freezes it - a background promise left un-awaited here
// would be a coin flip on Vercel. Same degrade-gracefully rule as every
// other Supabase-optional feature: no config means console-only, not a
// broken request.
async function logUsage(label, data, { model = MODEL, durationMs = null } = {}) {
  const usage = data?.usage;
  if (!usage) return;
  const inRate = model === HAIKU_MODEL ? HAIKU_INPUT_PER_TOKEN : SONNET_INPUT_PER_TOKEN;
  const outRate = model === HAIKU_MODEL ? HAIKU_OUTPUT_PER_TOKEN : SONNET_OUTPUT_PER_TOKEN;
  const searches = usage.server_tool_use?.web_search_requests || 0;
  const cost =
    (usage.input_tokens || 0) * inRate +
    (usage.output_tokens || 0) * outRate +
    (usage.cache_creation_input_tokens || 0) * inRate * 1.25 +
    (usage.cache_read_input_tokens || 0) * inRate * 0.1 +
    searches * WEB_SEARCH_COST_PER_USE;
  console.log(
    `[cost] ${label} $${cost.toFixed(4)} in=${usage.input_tokens || 0} out=${usage.output_tokens || 0} cache_read=${
      usage.cache_read_input_tokens || 0
    } cache_write=${usage.cache_creation_input_tokens || 0} searches=${searches}${
      durationMs !== null ? ` duration_ms=${durationMs}` : ""
    }`
  );

  const supabase = getSupabase();
  if (!supabase) return;
  try {
    const { error } = await supabase.from("api_cost_logs").insert({
      feature: label,
      model,
      cost_usd: cost,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      cache_write_tokens: usage.cache_creation_input_tokens || 0,
      searches,
      duration_ms: durationMs,
    });
    if (error) console.error("[logUsage] failed to persist cost log:", error.message);
  } catch (err) {
    console.error("[logUsage] threw persisting cost log:", err);
  }
}

// Sites confirmed live, repeatedly, to never yield a usable style-link
// image - not a one-off miss but a systemic one, so steering the search
// away from them entirely beats spending a candidate slot only to lose
// it every time. jcrew.com serves the exact same generic placeholder
// (jc-default.jpg) as its og:image on every product page, confirmed
// identical 3 separate times; anthropologie.com/bhldn.com and stories.com
// (& Other Stories) block non-browser fetches outright (DataDome/Akamai,
// confirmed via direct curl testing this session). Kept short and
// evidence-based on purpose - only domains actually proven dead, not a
// speculative blocklist, since an overly broad list would just rule out
// sites that would have worked.
const UNRELIABLE_STYLE_DOMAINS = ["jcrew.com", "anthropologie.com", "bhldn.com", "stories.com"];

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
//
// max_content_tokens: measured live that a single uncapped fetch of a real
// restaurant site can run ~50,000+ input tokens - mostly nav/footer/script
// boilerplate, not menu content, since a fetch pulls the WHOLE page, not
// just the relevant section. 8000 is enough room for a genuinely long menu
// page's actual text while cutting off the bloat around it; if it ever
// turns out to truncate before reaching the menu section on some page,
// this is the number to raise.
//
// allowed_callers: ["direct"] - this tool version's smarter content-
// filtering mode requires "programmatic" tool calling, which not every
// model supports (caught live testing Haiku 4.5 on this tool: 400 "does
// not support programmatic tool calling"). Forcing "direct" opts into the
// plain fetch-and-truncate behavior max_content_tokens describes above
// instead, which every model supports. Left in place even though both
// call sites below are pinned to Sonnet 5 (which does support the fancier
// mode) - simple and already proven correct live; only worth revisiting if
// truncation ever turns out to be a real problem worth trading for that
// added complexity.
const WEB_FETCH_TOOL = {
  type: "web_fetch_20260209",
  name: "web_fetch",
  max_uses: 1,
  max_content_tokens: 8000,
  allowed_callers: ["direct"],
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

// Wraps buildSystemPrompt()'s two parts as separate content blocks, with
// the cache breakpoint on only the shared one (see buildSystemPrompt in
// voiceProfile.js for why it's split). Doesn't change what the model
// sees - concatenated, it's the same text in the same order as before -
// only what it costs to re-send.
//
// Anthropic's cache is a prefix match keyed on the exact request shape
// (tools render before system, so they're part of the prefix too - see
// platform-caching.md docs), not scoped to one call. That means:
// - pickHashtags() and writeVoiceoverScript() below send no `tools` at
//   all, for any platform - so with the shared block now byte-identical
//   across platforms, their cache CAN be shared across all three
//   platforms generated from one click, not just retries of one platform.
// - attemptGeneration()'s own main call still can't share its cache
//   across platforms even with this split, because buildSubmitPostTool()
//   (its `tools` entry) genuinely differs by platform (YouTube's `title`
//   field, platform-specific field descriptions) - that's real,
//   worthwhile guidance, not left in by oversight, so this isn't "fixed"
//   by unifying the tool schema. What this split still buys the main
//   call: reuse across different `lengthSeconds` for the SAME platform
//   (identical tools there), and it stops paying to re-send the
//   platform-specific tail as part of the cached region on every retry.
function cachedSystemBlock({ shared, platformSpecific }) {
  return [
    { type: "text", text: shared, cache_control: { type: "ephemeral" } },
    { type: "text", text: platformSpecific },
  ];
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
  const t0 = Date.now();
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
  await logUsage("pickHashtags", data, { durationMs: Date.now() - t0 });
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
    const t0 = Date.now();
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
    await logUsage("writeVoiceoverScript", data, { durationMs: Date.now() - t0 });
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
    const t0 = Date.now();
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
    await logUsage("suggestMusic", data, { durationMs: Date.now() - t0 });
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

  const customInstructions = await getCustomInstructions();

  const prompt = `
Idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}

Suggest what to wear while filming this content - focus on colors, accessories, or seasonal choices that would work well on camera for this specific location/activity, not a full outfit prescription. Consider: contrast against the setting often reads better on camera than matching it (e.g. a cool color against a warm-toned venue, or vice versa), practicality for the actual activity (a hike vs. a spa visit vs. a restaurant), and the season/setting's natural aesthetic. Keep it concrete and specific to this exact topic, not generic "wear something comfortable" advice. 2-4 sentences.
${customInstructionsBlock(customInstructions)}
Respond with ONLY the styling suggestion, nothing else.
`.trim();

  try {
    const t0 = Date.now();
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
    await logUsage("suggestStyling", data, { durationMs: Date.now() - t0 });
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
  menuLinks,
  menuFiles,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !restaurantName) return null;

  // Up to 5 menu links - a place with separate food/drink/dessert menus
  // (or a seasonal one alongside the regular one) needs more than one URL
  // to cover, unlike the single-link version this replaced.
  const links = (Array.isArray(menuLinks) ? menuLinks : menuLinks ? [menuLinks] : [])
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  // Up to 3 uploaded files (front/back of a paper menu, or separate food/
  // drink photos) - same shape as the links above, {base64, mediaType} per
  // file, capped client-side (ContentTab.js/PlanningTab.js) by combined size.
  const files = (Array.isArray(menuFiles) ? menuFiles : []).filter((f) => f?.base64 && f?.mediaType).slice(0, 3);
  const hasMenuSource = !!(links.length > 0 || files.length > 0);
  const customInstructions = await getCustomInstructions();

  const promptText = `
You're helping prepare a content post about a specific restaurant/bar. Here's the topic:
Restaurant name: ${restaurantName}
Location: ${location}
Idea: ${idea}
Story beat / detail: ${storyBeat || "(none given)"}
${
    links.length > 0
      ? `Current menu link${links.length > 1 ? "s" : ""} (fetch each of these directly with the web_fetch tool):\n${links
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n")}\n`
      : ""
  }${
    files.length > 0
      ? `The current menu is also attached below as ${files.length > 1 ? `${files.length} images/documents` : "an image/document"} - read ${files.length > 1 ? "them" : "it"} directly.\n`
      : ""
  }Do both of these:
1. ${
    hasMenuSource
      ? "Read the current menu from the link(s) and/or attachment above."
      : "No menu source was provided, so skip this part."
  } Identify ONE menu item, if any, that's genuinely distinctive enough to be a real hook for a viral post - an unusual combination, a dramatic presentation, a memorable name, something a typical menu at a similar place wouldn't have. Only name one if it's GENUINELY unique - if nothing on the menu stands out, say so plainly rather than forcing an unremarkable item to sound exciting. Never invent a menu item that isn't actually there.
2. Do ONE web search for "${restaurantName}${location ? ` ${location}` : ""}" to check for anything else that could genuinely help this post - recent buzz, a distinctive reputation, an award, a specific dish or detail people are talking about online. If nothing useful turns up, say so plainly rather than inventing a finding.
${customInstructionsBlock(customInstructions)}
Respond with a short plain-text summary (under 150 words) covering both, clearly noting whenever something wasn't found rather than guessing.
`.trim();

  const content = [{ type: "text", text: promptText }];
  for (const file of files) {
    content.push({
      type: file.mediaType.startsWith("image/") ? "image" : "document",
      source: {
        type: "base64",
        media_type: file.mediaType,
        data: file.base64,
      },
    });
  }

  const tools = [WEB_SEARCH_TOOL];
  if (links.length > 0) tools.push({ ...WEB_FETCH_TOOL, max_uses: links.length });

  try {
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // Bumped from 700 - reading up to 5 menu pages instead of 1 gives
        // the model more to synthesize, and (per the lesson from the
        // nearby-ideas/reel-edit-plan truncation fixes) Sonnet 5's default
        // adaptive thinking draws from this same ceiling regardless of how
        // short the actual visible summary ends up being.
        max_tokens: 1200,
        tools,
        messages: [{ role: "user", content }],
      }),
    });

    if (!res.ok) {
      console.error("[analyzeRestaurant] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    await logUsage("analyzeRestaurant", data, { durationMs: Date.now() - t0 });
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();

    // Confirms every given link actually got fetched, not just allowed to
    // - max_uses is a ceiling, not a guarantee the model uses all of it.
    const fetchCalls = (data?.content || []).filter((b) => b.type === "server_tool_use" && b.name === "web_fetch");
    if (links.length > 0 && fetchCalls.length < links.length) {
      console.error(
        `[analyzeRestaurant] fetched ${fetchCalls.length}/${links.length} given menu links:`,
        JSON.stringify(fetchCalls.map((b) => b.input?.url))
      );
    }

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

  const customInstructions = await getCustomInstructions();

  const prompt = `
You're helping choose a location tag for a social post. Here's the topic:
Idea: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}

Do ONE web search to check real search/tourism popularity for the exact venue above versus well-known nearby real places (a national park, a well-known town or city, a notable landmark) that could honestly describe or be near this location. Look for concrete evidence of relative popularity - visitor numbers, "most visited" rankings, search interest - not just a guess.
${customInstructionsBlock(customInstructions)}
Respond with a short plain-text summary (under 120 words): name the real nearby options you found, and say which one (if any) clearly has more search/tourism interest than the exact venue, citing whatever concrete detail you found (a visitor count, a ranking, etc.) if available. If the exact venue is already the most well-known option, or no genuinely bigger nearby alternative exists, say that plainly instead of forcing one.

No other text.
`.trim();

  try {
    const t0 = Date.now();
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
    await logUsage("findLocationTagOptions", data, { durationMs: Date.now() - t0 });
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
// Maps a CATEGORY_OPTIONS key (lib/constants.js) to the fuller phrase used
// in search-per-category prompts below - shared between this function and
// findDiscoveryIdeas further down, so "all categories" and a specific
// selection describe the same category the same way in both.
const CATEGORY_SEARCH_PHRASES = {
  foodie: "foodie/quick bites",
  restaurants: "restaurants/sit-down dining",
  hiking: "hiking/outdoors",
  speakeasies: "speakeasies & bars",
  museums: "museums/indoor culture",
  experiences: "bookable experiences - wildlife/boat cruises, guided tours, scenic landmarks like lighthouses, botanical gardens, and other bucket-list activities worth planning a trip around",
  "weird-finds": "weird/offbeat finds - odd roadside attractions, quirky curiosities, bizarre oddities",
  "cinematic-areas": "cinematic/visually striking areas - scenic viewpoints, dramatic landscapes, photogenic backdrops worth filming",
};

// Same fix as findDiscoveryIdeas below: "any category" used to run two
// broad, location-wide passes (proven/overlooked) with only a soft
// "spread your searches around" nudge - which, under a shared search
// budget, could silently never run a search actually targeted at a given
// category (a speakeasy findable via a dedicated "speakeasies near X"
// search never turning up under "any category" because no search that
// specific ever ran). Restructured around one required, combined
// proven+overlooked search per category instead, so a category can't be
// silently skipped - the two-bucket split happens afterward, sorting
// whatever each category's search actually turned up.
const NEARBY_ALL_CATEGORIES = [
  ...Object.values(CATEGORY_SEARCH_PHRASES),
  "anything else genuinely worth filming here",
];

export async function findNearbyFilmingIdeas({ idea, location, storyBeat, categories }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !location) return null;

  const isAllCategories = !categories || categories.length === 0 || categories.includes("all");
  const categoryList = isAllCategories
    ? NEARBY_ALL_CATEGORIES
    : categories.map((c) => CATEGORY_SEARCH_PHRASES[c] || c);
  const categorySearchLines = categoryList.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const customInstructions = await getCustomInstructions();

  const prompt = `
You're helping plan a single filming day around a primary idea that's already chosen, so multiple things can be filmed nearby without a second trip out.

Primary idea already chosen: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}

Find real, specific places within roughly a 10-mile / short-drive radius of ${location} worth filming alongside the primary idea above.

Do ONE search for EACH of these categories - do not skip any of them, even if you already feel confident about a category from general knowledge:
${categorySearchLines}

Phrase each category's search to surface BOTH already-popular/proven spots AND overlooked ones together (e.g. "best and hidden gem speakeasy bars near Boothbay Harbor Maine reviews"), so one search per category can genuinely turn up candidates for either bucket - don't run a separate search per bucket, that's what silently drops whole categories under a shared search budget.

Once every category has been searched, sort every place you found with genuine evidence into one of two buckets, based on what the evidence for that specific place actually shows:
- VIRAL - places with real evidence of social buzz, strong reviews, being locally well-known or frequently posted about.
- HIDDEN - newly opened, rarely covered on social media, under-the-radar, or seeming to have real filming potential but not yet discovered.

Only include a place if you have genuine search evidence backing both its category fit and its bucket - never invent a place, never guess a distance without evidence (say "distance not confirmed" rather than making one up), and never force a "proven" or "hidden gem" label onto something the search didn't actually support. If a bucket ends up with nothing genuinely fitting, leave that section's list empty rather than padding it with mediocre or moderately-known filler - an honest "nothing stood out" is a valid result, but a place any category's search actually turned up with real evidence should never be dropped just because it doesn't fit one bucket cleanly - put it in whichever bucket the evidence best supports.
${customInstructionsBlock(customInstructions)}
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
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // One required search per category (categoryList.length) plus
        // headroom for a follow-up/verification search on an ambiguous
        // find - see the comment above categoryList in findDiscoveryIdeas
        // for why this replaced a fixed budget. Generously sized (not just
        // scaled to visible output): Sonnet 5 runs adaptive thinking by
        // default even though this call never sets `thinking` itself, and
        // thinking tokens draw from this same max_tokens ceiling - a
        // budget sized only for the visible formatted text hit
        // stop_reason "max_tokens" mid-response in testing once the
        // category fix above started genuinely finding more evidence to
        // write up than the old (buggy, under-searching) version ever did.
        max_tokens: 4000 + categoryList.length * 900,
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: categoryList.length + 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[findNearbyFilmingIdeas] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    await logUsage("findNearbyFilmingIdeas", data, { durationMs: Date.now() - t0 });
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();
    const parsed = parseNearbyIdeas(text);

    if (data?.stop_reason === "max_tokens") {
      console.error(`[findNearbyFilmingIdeas] hit max_tokens (output_tokens=${data?.usage?.output_tokens}) - response likely truncated mid-place.`);
    }
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

// Three search-result buckets (not just two) for whatever the standalone
// Discovery tab's searches turn up - popular/proven, genuinely
// interesting-but-not-mainstream, and hidden gems - since collapsing
// "interesting" and "hidden gem" into one bucket tends to bias toward
// whichever the model finds first. Same integrity rule as every other
// search-grounded feature in this file: never invent a place, never force
// a bucket label without real evidence, an empty section is an honest
// result. The category list "all categories" spans - kept as one place so
// the prompt's per-category search requirement and the max_uses budget
// below can't drift out of sync with each other.
const DISCOVERY_ALL_CATEGORIES = [
  ...Object.values(CATEGORY_SEARCH_PHRASES),
  "anything else notably unique to this specific location",
];

// Tried splitting this into several concurrent Claude calls (one per
// small group of categories, merged afterward) to cut wall-clock time the
// way the Content tab parallelizes TikTok/Instagram. Reverted after live
// testing showed two real problems: (1) it didn't actually deliver the
// expected speedup - instrumented timing showed the 3 concurrent calls
// finishing staggered (+49s, +59s, +87s) rather than together, meaning
// something (likely account-level rate limiting on concurrent/tokens-per-
// minute) was serializing them behind the scenes anyway, so total time
// barely improved over the single sequential call; and (2) real
// duplicates started showing up - each group only sees its own slice of
// categories, so a place two groups' searches both happened to surface
// (or two close-but-not-identical name spellings) could both survive the
// merge's dedupe. One call that sees every category's results together
// before sorting into buckets avoids that category entirely, at the cost
// of the wall-clock time scaling with category count.
export async function findDiscoveryIdeas({ location, categories, focus }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !location) return null;

  const trimmedFocus = typeof focus === "string" ? focus.trim() : "";
  const isAllCategories = !categories || categories.length === 0 || categories.includes("all");

  // Searching had been organized around the three BUCKETS (popular/
  // interesting/hidden), each running one broad, location-wide query - so
  // "all categories" only ever got a soft "spread your searches around"
  // nudge, easy to deprioritize under a shared search budget. In testing,
  // that silently dropped whole categories (a real venue - a speakeasy
  // found reliably when "speakeasies/bars" was picked directly - never
  // turned up under "all categories", because no search ever specifically
  // targeted that category; a generic "hidden gems near X" query doesn't
  // reliably surface something deliberately unmarked/low-profile the way
  // a category-specific query does). Restructured around CATEGORIES
  // instead: one required, combined popular+overlooked search per
  // category, so a category can no longer be silently skipped - the
  // popular/interesting/hidden bucketing happens afterward, sorting
  // whatever each category's search actually turned up.
  const categoryList = isAllCategories
    ? DISCOVERY_ALL_CATEGORIES
    : categories.map((c) => CATEGORY_SEARCH_PHRASES[c] || c);

  const categorySearchLines = categoryList
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const customInstructions = await getCustomInstructions();

  const prompt = `
You're helping a travel content creator discover real things to do in a location - not tied to any specific idea already chosen, just genuinely worth visiting/filming there.

Location: ${location}

Find real, specific places or experiences in and around ${location}. If this is a broad area (a whole state or region, not one town), spread results across different towns/areas within it rather than clustering on just one spot. If it's a specific city/town instead, stay within it or a short drive of it (roughly 30-45 minutes) - a search turning up a genuinely well-known day-trip destination further out doesn't mean it belongs here; only include it if you clearly label it as a day trip (say so plainly in AREA and WHY) rather than presenting it as if it's in ${location} itself.
${
    trimmedFocus
      ? `\nShe's specifically looking for: "${trimmedFocus}" - fold this into EVERY category search below (e.g. for a focus of "christmas things," the "hiking/outdoors" category becomes something like "christmas lights walk hiking trail near ${location}", not a generic hiking search with no connection to the focus). A category is only worth including in the results at all if what it turned up genuinely connects to this focus - a generic result for that category with no real tie to it should be left out rather than padded in just to fill the category.\n`
      : ""
  }
Do ONE search for EACH of these categories - do not skip any of them, even if you already feel confident about a category from general knowledge:
${categorySearchLines}

Phrase each category's search to surface BOTH well-known/popular spots AND lesser-known/overlooked ones together (e.g. "best and hidden gem speakeasy bars near Boothbay Harbor Maine reviews"), so one search per category can genuinely turn up candidates for more than one bucket - don't run a separate search per bucket, that's what silently drops whole categories under a shared search budget.

Once every category has been searched, sort every place you found with genuine evidence into exactly one of three buckets, based on what the evidence for that specific place actually shows:
- POPULAR - well-known draws with real evidence of tourism traffic, strong reviews, or being a well-known must-visit.
- INTERESTING - genuinely interesting or unique but not necessarily top-tourist-list material - a distinctive experience, an unusual activity, something with a real "huh, I didn't know that was here" quality, backed by real evidence it exists and is worth it.
- HIDDEN - new, under-the-radar, rarely covered, or seeming to have real potential but not yet widely discovered, with real evidence for that too.

Only include a place if you have genuine search evidence backing both its category fit and which bucket it belongs in - never invent a place, never guess at an area/town without evidence (say "area not specified" rather than making one up), and never force a "popular," "interesting," or "hidden gem" label onto something the search didn't actually support. If a bucket ends up with nothing genuinely fitting, leave that section's list empty rather than padding it with mediocre filler - an honest "nothing stood out" is a valid result, but a place any category's search actually turned up with real evidence should never be dropped just because it doesn't fit one specific bucket cleanly - put it in whichever bucket the evidence best supports.
${customInstructionsBlock(customInstructions)}
Respond in EXACTLY this format and nothing else - up to 7 places per section, each place as five labeled lines in this exact order. A field's text can wrap onto more than one line if it needs to (keep wrapped lines plain, no new label on them) - just always start the NEXT field on its own line with its label. NAME is ONLY the place's name - never a sentence, clause, or dash-appended description tacked onto it, no matter how short or true. WRONG (never do this): "Coastal Maine Botanical Gardens—the largest botanical garden in New England with 295 acres." RIGHT: "Coastal Maine Botanical Gardens" as NAME, with every one of those extra facts moved into WHY instead, where they belong:
---POPULAR---
NAME: <place name, and ONLY the name>
CATEGORY: <category>
AREA: <town/neighborhood within ${location}, or "area not specified">
WHY: <why it's genuinely popular, citing real evidence - a sentence or two is fine>
ANGLE: <one line content/filming angle>
---INTERESTING---
NAME: <place name, and ONLY the name>
CATEGORY: <category>
AREA: <town/neighborhood, or "area not specified">
WHY: <why it's a genuinely interesting/unique find, citing real evidence>
ANGLE: <one line content/filming angle>
---HIDDEN---
NAME: <place name, and ONLY the name>
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
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Tried Haiku 4.5 here for speed (roughly half the wall-clock time
        // live-tested) and it also needed a tightened NAME-field
        // instruction to stop stuffing description text into the name -
        // both fixed. Reverted anyway: this exact function was already
        // tested on Haiku once before (see the "Model choice, tested live"
        // note in README.md) and came back with noticeably fewer real
        // places, once returning zero for a query Sonnet 5 handled fine -
        // an intermittent failure that 2 clean live retests here don't
        // outweigh, especially since the dominant cost of this call is the
        // web_search tool fees either way (same regardless of model), not
        // the model's own token price - so Sonnet 5's few extra cents buys
        // back a documented reliability gap.
        model: MODEL,
        // One required search per category (categoryList.length) plus
        // headroom for a follow-up/verification search on an ambiguous
        // find - scales with how many categories are actually in play,
        // so "all categories" gets real budget to search every one of
        // them, not a fixed number that happened to work for a single
        // category. Generously sized, not just scaled to visible output:
        // thinking tokens draw from this same max_tokens ceiling - see the
        // identical note in findNearbyFilmingIdeas above, where a
        // narrower budget hit stop_reason "max_tokens" mid-response once
        // the category fix started genuinely finding more to write up.
        // Base bumped 5000 -> 9000 after a live failure: a SINGLE category
        // ("Experiences") for Portland, ME - a real city with far more
        // candidates to search through and weigh than the small towns this
        // was originally tuned against (Boothbay Harbor) - burned the
        // entire 6000-token budget on thinking and produced zero output
        // text at all (stop_reason "max_tokens", output_tokens=6766, empty
        // response), which the UI then showed as an honest "nothing turned
        // up" empty result - indistinguishable from genuinely finding
        // nothing, but actually a silent truncation bug. Location size/
        // density isn't reflected in categoryList.length at all, so the
        // safest fix is more headroom on the base, not a smarter formula.
        max_tokens: 9000 + categoryList.length * 1000,
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: categoryList.length + 3 }],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[findDiscoveryIdeas] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    await logUsage("findDiscoveryIdeas", data, { durationMs: Date.now() - t0 });
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();
    const parsed = parseDiscoveryIdeas(text);

    if (data?.stop_reason === "max_tokens") {
      console.error(`[findDiscoveryIdeas] hit max_tokens (output_tokens=${data?.usage?.output_tokens}) - response likely truncated mid-place.`);
    }
    if (parsed.popular.length === 0 && parsed.interesting.length === 0 && parsed.hidden.length === 0) {
      console.error("[findDiscoveryIdeas] parsed to zero places, raw text:", text.slice(0, 2000));
    }

    return parsed;
  } catch (err) {
    console.error("[findDiscoveryIdeas] threw:", err);
    return null;
  }
}

// Ad-hoc, per-place suggestions in the Discovery tab - deliberately NOT
// run automatically for every place in a result (up to 21 of them across
// three buckets), which would multiply search/generation cost by however
// many places a search returns. Instead this only ever runs when the user
// clicks one of the three buttons on a specific place, so cost scales
// with genuine interest, not with how big a search happened to come back.
//
// mode controls which field(s) the tool asks for - "both" isn't just two
// separate calls glued together, it's one call sharing the same place
// context and search budget, which is genuinely cheaper than calling this
// function twice with mode "food" then mode "style".
function buildPlaceSuggestionTool(mode) {
  const includeFood = mode === "food" || mode === "both";
  const includeStyle = mode === "style" || mode === "both";

  return {
    name: "submit_place_suggestion",
    description: "Deliver the requested suggestion(s) for this specific place, after searching for real evidence. Call exactly once, with every requested field filled in.",
    input_schema: {
      type: "object",
      properties: {
        ...(includeFood
          ? {
              food_suggestion: {
                type: "array",
                description: "If this place is primarily a food/drink venue: up to 2 genuinely distinctive real dishes, and up to 2 real cocktails/drinks if it's a bar/speakeasy/has a program specifically called out somewhere - up to 4 items total. Quality over quantity: 1 genuinely distinctive dish beats 2 where the second is a generic filler pick, so it's fine to return fewer than 2 of either kind (or none of one kind) if that's genuinely all you found - never force a second dish or drink just to fill the count. If this ISN'T primarily a food/drink venue, instead ONE item for a specific real thing to do/see there (a trail feature, exhibit, viewpoint, activity) - not a generic 'explore the area.' Never invent a dish, cocktail, or activity that isn't backed by something you actually found - if nothing genuinely distinctive turns up at all, use a name like 'Nothing distinctive found' rather than forcing an unremarkable pick.",
                items: {
                  type: "object",
                  properties: {
                    name: {
                      type: "string",
                      description: "ONLY the name - 'Caramelized Salmon', never a sentence or clause about it, no matter how short. WRONG (never do this): 'Devil's Kitchen viewpoint, a favorite photography spot for framing the beach'.",
                    },
                    price: {
                      type: "string",
                      description: "ONLY a price, e.g. '$32' - a number and a dollar sign, nothing else, ever. If you have ANY uncertainty or caveat about it (looks dated, might be for a different size/variant, base price vs. full dish) - don't include this field at all, and put that caveat in source instead. This field is all-or-nothing: a clean price, or omitted entirely, never a hedge. WRONG (never do this): '$13.95 (as of a 2022 review, likely higher now)' or '$30 (base price found; full entree may vary)'.",
                    },
                    source: {
                      type: "string",
                      description: "A short tag (a few words, not a sentence) for how current/confident this is: 'from their current menu', 'menu looks ~1yr old', 'no menu found - from reviews', or similar for a non-food activity.",
                    },
                    image_link: {
                      type: "string",
                      description: "A real URL (a review, article, blog post, or the restaurant's own page) where a photo of this SPECIFIC dish/drink/activity genuinely appears - optional, only include if you actually found or strongly expect one there from your search. Never invent a URL.",
                    },
                  },
                  required: ["name", "source"],
                },
              },
            }
          : {}),
        ...(includeStyle
          ? {
              style_suggestion: {
                type: "string",
                description: "2-4 sentences on what to wear for filming at this specific place - focus on colors/accessories/practicality that read well on camera for this exact setting (contrast against the venue often reads better than matching it), the season, and the activity. Concrete and specific to this place, not generic 'wear something comfortable' advice.",
              },
              style_links: {
                type: "array",
                description: "As many REAL outfit-inspiration photos as your search results actually contain, up to 12, that genuinely match the style_suggestion - real photos of real people actually wearing a fitting look (a fashion blog, a real Pinterest/Instagram post, a street-style roundup), not product photos to shop from - nobody needs to buy the exact item, just see how a similar look actually reads on a real person. Go wide on purpose: the app checks each one afterward for a real, verified preview image and stops once it finds 3 that work - it does NOT come back and ask you to search again, so everything happens in this one list. The more real, distinct candidates you give it here, the better its odds of finding 3 without ever needing another search. Use the individual URL of an actual photo page from your search results - not a generic site search/category/listing page (a URL containing '/search', '?query=', or a bare category page is the wrong kind of link) - and spread across DIFFERENT sources rather than several links from the same one, since a site that blocks one of its own pages likely blocks all of them. Never invent a URL - every single one must be something your search actually returned. It's fine to end up with fewer than 12, or none, if you genuinely can't find that many distinct real ones; never pad the list with a repeated or generic link just to hit a number. Don't worry about finding an image yourself - just the real link and a short label.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Short label for this look, e.g. 'Breezy coastal linen look' or 'Warm-tone evening layers'." },
                    url: { type: "string", description: "The real URL you found." },
                  },
                  required: ["label", "url"],
                },
              },
            }
          : {}),
      },
      required: [...(includeFood ? ["food_suggestion"] : []), ...(includeStyle ? ["style_suggestion", "style_links"] : [])],
    },
  };
}

// A page's og:image can be anything the site chose as its social-share
// preview - a logo, a lifestyle banner, an unrelated hero shot - so having
// a real image (fetchOgImage's job) doesn't yet prove it's an image OF the
// clothing. This is the second half of the guarantee: actually look at
// each candidate's fetched image and keep only the ones that genuinely
// show the garment/accessory itself or someone wearing it. tool_choice is
// forced so this is a pure classification call, not open-ended chat.
const IMAGE_CHECK_TOOL = {
  name: "submit_image_check",
  description: "Report whether this image genuinely shows the clothing/accessory item itself - a clear product photo of it, or a real person wearing it - as opposed to a logo, icon, storefront, unrelated banner/lifestyle shot, or anything else that isn't actually a picture of the item.",
  input_schema: {
    type: "object",
    properties: {
      is_clothing_image: {
        type: "boolean",
        description: "true only if this image is genuinely a photo of the clothing/accessory itself (a clear product shot, or a real person wearing it). false for a logo, icon, storefront, unrelated banner/lifestyle shot, or anything else that isn't actually a picture of the item.",
      },
    },
    required: ["is_clothing_image"],
  },
};

// Shared low-level primitive behind isClothingImage and isFoodImage below -
// one real HTTP call, Haiku 4.5, a forced single-field boolean tool call.
// Checked one candidate at a time (not batched) - live testing found that
// if even ONE candidate's image URL turned out to be unfetchable by
// Claude's own vision fetch (a 404, hotlink protection, a URL our own
// og:image fetch could read the page for but the image itself blocks), a
// batched request gets rejected wholesale with a 400, which would
// silently un-verify every candidate in the batch, not just the broken
// one. Returns null (not false) on any failure so callers can fail closed
// explicitly rather than this function silently deciding that for them.
async function classifyImage(imageUrl, tool, questionText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 500,
        tools: [tool],
        tool_choice: { type: "tool", name: tool.name },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: questionText },
              { type: "image", source: { type: "url", url: imageUrl } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error("[classifyImage] API error for", imageUrl, res.status, (await res.text()).slice(0, 300));
      return null;
    }

    const data = await res.json();
    await logUsage("classifyImage", data, { model: HAIKU_MODEL, durationMs: Date.now() - t0 });
    const block = (data?.content || []).find((b) => b.type === "tool_use" && b.name === tool.name);
    return block?.input ?? null;
  } catch (err) {
    console.error("[classifyImage] threw for", imageUrl, err);
    return null;
  }
}

async function isClothingImage(candidate) {
  const input = await classifyImage(
    candidate.imageUrl,
    IMAGE_CHECK_TOOL,
    `This image is a candidate for a "clothes to wear" suggestion carousel, labeled "${candidate.label}". Call submit_image_check to report whether it genuinely shows that clothing/accessory item itself.`
  );
  // Fail CLOSED (null/missing -> false) - a candidate that couldn't be
  // verified shouldn't count as verified. 5 candidates are fetched
  // specifically so losing one here still leaves real odds of a full set.
  return !!input?.is_clothing_image;
}

async function filterToClothingImages(candidates) {
  if (candidates.length === 0) return [];
  const flags = await Promise.all(candidates.map(isClothingImage));
  return candidates.filter((_, i) => flags[i]);
}

// Same idea as IMAGE_CHECK_TOOL/isClothingImage, for the food-suggestion
// photo instead - a menu-site og:image or an article's hero image can just
// as easily be the restaurant's storefront or an unrelated dish as the
// specific item being suggested.
const FOOD_IMAGE_CHECK_TOOL = {
  name: "submit_food_image_check",
  description: "Report whether this image genuinely shows the specific food/drink item itself - a real photo of that dish or drink - as opposed to the restaurant's storefront/interior, a menu board, a different dish, a logo, or anything else that isn't actually a photo of this item.",
  input_schema: {
    type: "object",
    properties: {
      is_food_image: {
        type: "boolean",
        description: "true only if this image is genuinely a photo of the specific named dish/drink. false for a storefront/interior shot, a menu board or text image, a different dish, a logo, or anything else that isn't a real photo of this specific item.",
      },
    },
    required: ["is_food_image"],
  },
};

async function isFoodImage(name, imageUrl) {
  const input = await classifyImage(
    imageUrl,
    FOOD_IMAGE_CHECK_TOOL,
    `This image is a candidate photo for "${name}", a food/drink item being suggested to a content creator. Call submit_food_image_check to report whether it genuinely shows that specific dish/drink.`
  );
  return !!input?.is_food_image;
}

// Prompt-only fixes for "no caveat in price" kept getting beaten by a new
// caveat shape each time it was live-tested (staleness, then ambiguity
// about what the number covers, then a quantity/deal qualifier) - three
// rounds of wrong-examples was three rounds too many. Enforcing it in
// code instead of prose is the actual fix: pull out the first real price
// pattern and discard everything else, so whatever creative hedge the
// model comes up with next, only a clean price ever reaches the user.
function sanitizePrice(price) {
  if (typeof price !== "string") return null;
  const match = price.match(/\$\d+(?:\.\d{2})?/);
  return match ? match[0] : null;
}

// Single-shot, not the over-fetch-and-retry treatment style links get -
// this is a "nice if it's there" addition to a suggestion that's already
// useful as text, not a carousel the whole feature hinges on, so it isn't
// worth doubling the search budget for. No image_link, no image, no
// second attempt.
async function resolveFoodItemImage(item) {
  const price = sanitizePrice(item?.price);
  if (!item?.image_link) return { ...item, price, imageUrl: null };
  const imageUrl = await fetchOgImage(item.image_link);
  if (!imageUrl) return { ...item, price, imageUrl: null };
  const verified = await isFoodImage(item.name, imageUrl);
  return { ...item, price, imageUrl: verified ? imageUrl : null };
}

// fetchOgImage + filterToClothingImages for one batch of candidate links -
// the per-batch worker findStyleLinks below calls repeatedly.
async function resolveVerifiedStyleLinks(rawLinks) {
  const withImages = await Promise.all(
    rawLinks.map(async (link) => {
      const imageUrl = await fetchOgImage(link.url);
      return imageUrl ? { label: link.label, url: link.url, imageUrl } : null;
    })
  );
  const imageBacked = withImages.filter(Boolean);
  return filterToClothingImages(imageBacked);
}

const STYLE_LINK_TARGET = 3;
// How many candidates get checked at once before deciding whether more
// are needed - small enough that a lucky pool (3 real winners near the
// front of the list) stops early without touching the rest of it, large
// enough that each round is genuinely parallel work, not one link at a
// time.
const STYLE_LINK_BATCH_SIZE = 3;

// Works through the real candidates the search already returned (see the
// style_links schema above - up to 12, from ONE search), stopping as soon
// as STYLE_LINK_TARGET verified images are found. Replaced an earlier
// design that asked Claude to search again whenever a round came up
// short - a new Sonnet 5 call, a new $0.01 web_search fee, every retry.
// Live testing found that design both more expensive AND less reliable:
// a retry-search once invented a plausible-looking but fake product URL
// (an H&M link with product ID "1234567890"), since asking a model to
// "find something different" without fresh search results in front of it
// is an easier way to end up guessing than searching. Checking a wider
// pool from the one real search instead means every candidate is
// something the search actually returned, and going further down the
// list never costs more than a free fetch plus one cheap Haiku
// classification call - it can check all 12 candidates without ever
// triggering a second Sonnet 5 call, however unlucky the pool turns out
// to be.
async function findStyleLinks(rawLinks) {
  let verified = [];
  for (let i = 0; i < rawLinks.length && verified.length < STYLE_LINK_TARGET; i += STYLE_LINK_BATCH_SIZE) {
    const batch = rawLinks.slice(i, i + STYLE_LINK_BATCH_SIZE);
    const batchVerified = await resolveVerifiedStyleLinks(batch);
    verified = verified.concat(batchVerified);
  }
  return verified.slice(0, STYLE_LINK_TARGET);
}

export async function suggestForPlace({ name, placeCategory, area, searchLocation, mode }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !name) return null;

  const resolvedMode = ["food", "style", "both"].includes(mode) ? mode : "both";
  const customInstructions = await getCustomInstructions();

  const prompt = `
You're helping a travel content creator get specific, real, on-the-ground suggestions for one place they're considering filming.

Place: ${name}
Category: ${placeCategory || "(not specified)"}
Area: ${area || searchLocation}
${
    resolvedMode !== "style"
      ? "\nDo ONE search (and fetch a promising page if you find one) to check for this place's current menu or, if it's not a food/drink venue, real evidence of what's specifically worth doing/seeing there."
      : ""
  }${
    resolvedMode !== "food"
      ? `\nDo 2-3 SEPARATE searches (not just one) for real photos of people actually wearing a fitting outfit for this specific place (its setting, vibe, season) - e.g. "what to wear [occasion/vibe] outfit inspo", "[season] [activity] outfit ideas real photos" - not a specific product to buy. Vary each search (a different vibe angle, a different specific garment type, a different season/time-of-day framing) so they surface different real pages rather than the same handful of results three times. This is specifically so style_links can list more real, distinct candidates than one search alone would turn up - a single search that happens to only return 3-5 genuinely distinct results is a real limit worth pushing past with a second and third angle, not a stopping point. Search results already contain real, specific photo page URLs (fashion blogs, Instagram/Pinterest posts, street-style roundups) - use those directly for style_links rather than a generic site search or category page. A genuinely fitting purchasable product page is fine too if that's what a search turns up, but it's not the goal - a real photo of someone actually wearing a fitting look is worth more here than a product shot on a white background. These sites are known to never yield a usable photo (blocked automated access, or the same generic placeholder image on every page) - skip them even if they show up in results, they'll just waste a slot: ${UNRELIABLE_STYLE_DOMAINS.join(", ")}.`
      : ""
  }
${customInstructionsBlock(customInstructions)}
Call submit_place_suggestion with the result.
`.trim();

  try {
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // "both" needs headroom for two independent searches worth of
        // findings plus two full fields (including up to 3 style links)
        // instead of one - same adaptive-thinking-eats-the-budget lesson
        // as every other max_tokens value in this file. Learned the hard
        // way live-testing this one specifically: an earlier, much lower
        // budget here (1400/2200) wasn't a "results look a bit thin"
        // problem like the other fixes - it hit max_tokens so hard mid-
        // thinking that the call failed outright (500, no tool call ever
        // made) after burning 4200+ output tokens without finishing a
        // single search's reasoning.
        // Bumped 10000/7000 -> 12000/9000 when style_links grew from up to
        // 5 candidates to up to 12 - going wide on the ONE search is the
        // whole point of the current findStyleLinks design (see its
        // comment above), so the output budget needs to comfortably fit
        // listing that many real links, not just 5.
        max_tokens: resolvedMode === "both" ? 12000 : 9000,
        // WEB_SEARCH_TOOL/WEB_FETCH_TOOL default to max_uses: 1 each - fine
        // for a single-topic call, but "both" asks for one search per
        // topic, so 1 wasn't enough budget for both and the model had to
        // skip one partway through (caught live in testing - the style
        // suggestion came back honestly admitting "search access was
        // exhausted" rather than inventing links, which is the right
        // failure mode, but the actual fix is giving it enough budget to
        // not need to). Style gets 3 (not 1) since it now needs to gather
        // up to 12 distinct real candidates from possibly more than one
        // search angle in this single call - there's no second "search
        // again" call anymore (see findStyleLinks above), so this one call
        // has to be thorough enough on its own. Food gets 2 (not 1) since
        // it's also asked for an optional image_link per item, a second
        // thing to look for beyond just the menu.
        tools: [
          { ...WEB_SEARCH_TOOL, max_uses: resolvedMode === "both" ? 5 : resolvedMode === "style" ? 3 : 2 },
          // Style links no longer need Claude's own fetch tool at all -
          // fetchOgImage() below finds real preview images independently
          // and far more reliably than asking the model to (confirmed
          // live: Claude once fetched the exact right product page,
          // quoted its real price, and still couldn't produce a usable
          // image URL from it). Only food/activity research still
          // benefits from a fetch, to read a menu page directly.
          ...(resolvedMode !== "style" ? [{ ...WEB_FETCH_TOOL, max_uses: resolvedMode === "both" ? 2 : 1 }] : []),
          buildPlaceSuggestionTool(resolvedMode),
        ],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[suggestForPlace] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    await logUsage(`suggestForPlace(${resolvedMode})`, data, { durationMs: Date.now() - t0 });
    const blocks = data?.content || [];
    const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_place_suggestion");

    if (data?.stop_reason === "max_tokens") {
      console.error(`[suggestForPlace] hit max_tokens (mode=${resolvedMode}, output_tokens=${data?.usage?.output_tokens})`);
    }

    if (!submitBlock) {
      console.error("[suggestForPlace] no submit_place_suggestion tool call:", JSON.stringify(blocks).slice(0, 1000));
      return null;
    }

    const input = submitBlock.input || {};

    const rawStyleLinks = Array.isArray(input.style_links)
      ? input.style_links.filter((l) => l?.label && l?.url).slice(0, 12)
      : [];

    // Each candidate has to clear two checks - a real fetched image
    // (fetchOgImage; Claude's own web_fetch tool proved unreliable at this
    // even when it read the right page) and that image actually being a
    // photo of the clothing itself, not a logo/banner/unrelated shot
    // (isClothingImage). findStyleLinks works through the pool in batches
    // until it finds 3 or runs out of candidates - see findStyleLinks
    // above for why this no longer means a second Sonnet 5 call.
    const styleLinks = await findStyleLinks(rawStyleLinks);

    const rawFoodItems = Array.isArray(input.food_suggestion)
      ? input.food_suggestion.filter((i) => i?.name && i?.source).slice(0, 4)
      : [];
    // Single-shot image lookup per item (see resolveFoodItemImage) - a
    // best-effort extra, not a guarantee, so no retry loop like style
    // links get.
    const foodItems = await Promise.all(rawFoodItems.map(resolveFoodItemImage));

    return {
      foodItems,
      styleSuggestion: input.style_suggestion || null,
      styleLinks,
    };
  } catch (err) {
    console.error("[suggestForPlace] threw:", err);
    return null;
  }
}

// Powers the Planning tab's own search bar - a direct, free-text "find
// this specific restaurant/hike/place" lookup, as opposed to Discovery's
// broad category-bucketed search across a whole location. The user
// already knows roughly what they're looking for here (a name, a specific
// ask like "a good lobster roll spot near Boothbay"), so this returns a
// short flat list of real matches rather than sorting into popular/
// interesting/hidden buckets - that three-way sort only makes sense when
// surveying everything in a location, not when the query already narrows
// it down.
const PLACE_SEARCH_TOOL = {
  name: "submit_place_search",
  description: "Deliver the real place(s) that match this search, after searching for evidence. Call exactly once.",
  input_schema: {
    type: "object",
    properties: {
      places: {
        type: "array",
        description: "Up to 3 real, specific places that genuinely match the search - if the query is specific enough to point at one clear answer, return just that one; if it's more general, return up to 3 genuinely distinct real options. Never invent a place - if nothing genuine matches, return an empty list rather than guessing or forcing a loose fit.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "ONLY the place's name - never a sentence." },
            category: { type: "string", description: "A short category tag, e.g. 'restaurants/sit-down dining' or 'hiking/outdoors'." },
            area: {
              type: "string",
              description: "ONLY a short 'Town, State' (or 'Town, Country') location - e.g. 'Providence, Rhode Island' - never a descriptive aside about exactly where on the block it sits. Use 'area not specified' if genuinely unclear. WRONG: 'Downtown Providence (docks at One Citizens Plaza, near Café Nuovo)'. RIGHT: 'Providence, Rhode Island' - any street-level/landmark detail like that belongs in why instead.",
            },
            why: { type: "string", description: "1-2 sentences on why this is a genuine match, citing real evidence (reviews, a specific dish/feature, etc.) - this is also where street-level detail (an exact dock, a nearby landmark) belongs, not in area." },
            angle: { type: "string", description: "One line content/filming angle." },
          },
          required: ["name", "category", "area", "why", "angle"],
        },
      },
    },
    required: ["places"],
  },
};

export async function searchForPlace({ query }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !query?.trim()) return null;

  const customInstructions = await getCustomInstructions();

  const prompt = `
A travel content creator is searching for a specific real place: "${query.trim()}"

Do 1-2 web searches to find the best real match(es) - a specific restaurant, hike, activity, landmark, or place that genuinely fits what they're describing. If the query already points at one clear, specific place, just confirm and return that one. If it's more general (e.g. "a good hike near Camden Maine"), return up to 3 genuinely distinct, real options with real evidence behind each.

Never invent a place, and never force a loose or generic match just to return something - an empty list is an honest result if nothing genuine turns up.
${customInstructionsBlock(customInstructions)}
Call submit_place_search with the result.
`.trim();

  try {
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 6000,
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: 3 }, PLACE_SEARCH_TOOL],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error("[searchForPlace] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    await logUsage("searchForPlace", data, { durationMs: Date.now() - t0 });
    const blocks = data?.content || [];
    const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_place_search");

    if (data?.stop_reason === "max_tokens") {
      console.error(`[searchForPlace] hit max_tokens (output_tokens=${data?.usage?.output_tokens})`);
    }

    if (!submitBlock) {
      console.error("[searchForPlace] no submit_place_search tool call:", JSON.stringify(blocks).slice(0, 1000));
      return null;
    }

    const input = submitBlock.input || {};
    return Array.isArray(input.places)
      ? input.places.filter((p) => p?.name && p?.why).slice(0, 3)
      : [];
  } catch (err) {
    console.error("[searchForPlace] threw:", err);
    return null;
  }
}

// Powers the Planning tab's "Research this place" button - a deeper,
// one-time dive on a single place a user has already decided is worth
// planning around (moved there from a Discovery result via "Add to
// Planning"), as opposed to suggestForPlace's lighter per-result buttons.
// Deliberately asks for "wild"/standout picks and insider tips rather than
// a safe menu summary - this only runs on places the user already cares
// about, so it's worth spending the search budget going for genuinely
// notable finds over a generic rundown.
const PLANNING_RESEARCH_TOOL = {
  name: "submit_planning_research",
  description: "Deliver the finished research for this one place, after searching for real evidence. Call exactly once, when every field is ready.",
  input_schema: {
    type: "object",
    properties: {
      is_food_or_drink_venue: {
        type: "boolean",
        description: "true if this place is primarily a restaurant, bar, cafe, brewery, or similar food/drink venue. false for anything else (a hike, museum, park, landmark, tour, activity, etc.) - used to label the wild_food_and_drink field correctly in the UI (\"Wild food & drink ideas\" vs. something like \"Wild things to see\"), so answer based on what the place actually is, not what wild_food_and_drink happens to contain.",
      },
      wild_food_and_drink: {
        type: "array",
        description: "Up to 4 genuinely standout, unusual, or distinctive real dishes/cocktails/drinks worth building a video around - not a safe 'popular menu item' pick. If this isn't a food/drink venue, use this for the most surprising, specific things to actually do/see there instead. Never invent one - if nothing genuinely notable turns up, it's fine to return fewer than 4, or none. IMPORTANT: if you found a specific standout dish/drink/thing-to-see worth naming ANYWHERE in your research (including something you'd otherwise only mention in passing in summary), it MUST get its own entry here - summary is a short wrap-up of what's in the other fields, never a place where a specific named find appears for the first and only time.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "ONLY the name, e.g. 'Charred Octopus with Black Garlic' - never a sentence." },
            description: {
              type: "string",
              description: "1-2 sentences on what makes this genuinely worth featuring - the specific detail that makes it wild/unusual/notable, not a generic description.",
            },
            source: {
              type: "string",
              description: "A short tag for how current/confident this is: 'from their current menu', 'menu looks ~1yr old', 'no menu found - from reviews', or similar.",
            },
          },
          required: ["name", "description", "source"],
        },
      },
      secret_tips: {
        type: "array",
        description: "Up to 5 real, specific insider tips - the kind only a local or a detailed review would mention: best time to go, how to skip a line, a booking trick, an easy-to-miss detail, a cost hack, a genuine warning. Each one concrete and specific to this exact place, never generic travel advice. Never invent one - return fewer than 5 (or none) if that's genuinely all you found.",
        items: { type: "string" },
      },
      nearby_worth_going: {
        type: "array",
        description: "Up to 3 OTHER real places genuinely worth checking out while already in the area - an honest fit for this specific trip, not a generic 'also explore the town.' Fine to leave empty if nothing genuinely fits.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            why: { type: "string", description: "1-2 sentences on why this specific place is worth the detour." },
            area: { type: "string", description: "Optional - the town/neighborhood it's in, if different from the main place." },
          },
          required: ["name", "why"],
        },
      },
      summary: {
        type: "string",
        description: "1-2 sentences tying it together - why this place is worth planning content around, based on what the searches actually found. A wrap-up of the other fields, not a substitute for them: never name a specific dish, drink, or thing-to-see here that isn't ALSO its own entry in wild_food_and_drink - if it's worth naming, it's worth its own entry there, not just a mention in this summary. WRONG: summary says 'known for its suckling pig porchetta display and caprese in an edible parmesan basket' while wild_food_and_drink is empty. RIGHT: those two dishes are each their own wild_food_and_drink entry, and summary just references the vibe (e.g. 'known for its standout appetizers and a cozy waterfront porch').",
      },
    },
    required: ["is_food_or_drink_venue", "wild_food_and_drink", "secret_tips", "nearby_worth_going", "summary"],
  },
};

export async function researchPlanningItem({
  name,
  placeCategory,
  area,
  searchLocation,
  focus,
  menuLinks,
  menuFiles,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !name) return null;

  const customInstructions = await getCustomInstructions();
  const trimmedFocus = typeof focus === "string" ? focus.trim() : "";
  // Same shape/cap as analyzeRestaurant's own menu links - a place can
  // have separate food/drink/dessert menus worth checking.
  const links = (Array.isArray(menuLinks) ? menuLinks : menuLinks ? [menuLinks] : [])
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  // Same shape/cap as analyzeRestaurant's own uploaded files.
  const files = (Array.isArray(menuFiles) ? menuFiles : []).filter((f) => f?.base64 && f?.mediaType).slice(0, 3);
  const hasMenuSource = !!(links.length > 0 || files.length > 0);

  const promptText = `
You're doing deep pre-trip planning research for a travel content creator about ONE specific place she has already decided is worth building content around.

Place: ${name}
Category: ${placeCategory || "(not specified)"}
Area: ${area || searchLocation || "(not specified)"}
${
    links.length > 0
      ? `Current menu link${links.length > 1 ? "s" : ""} (fetch each of these directly with the web_fetch tool) - this is the actual current menu, more reliable than anything a generic search turns up:\n${links
          .map((l, i) => `${i + 1}. ${l}`)
          .join("\n")}\n`
      : ""
  }${
    files.length > 0
      ? `The current menu is also attached below as ${files.length > 1 ? `${files.length} images/documents` : "an image/document"} - read ${files.length > 1 ? "them" : "it"} directly, it's the actual current menu.\n`
      : ""
  }Do up to ${trimmedFocus ? 4 : 3} web searches (and fetch a promising page if you find one) to find:
1. Wild, unusual, or genuinely standout food/drink items here${
    hasMenuSource ? " - check the real menu given above FIRST, before falling back to a general search" : ""
  } (or if it's not a food/drink venue, the most surprising specific things to do/see there) - the kind of find worth building a video around, not a safe generic pick.
2. Real insider tips a first-time visitor wouldn't know - timing, booking tricks, easy-to-miss details, cost hacks, honest warnings.
3. Up to 3 other REAL nearby places genuinely worth visiting while already in the area.
${trimmedFocus ? `4. She specifically wants you to dig into this too, with its own dedicated search: "${trimmedFocus}" - fold whatever you genuinely find into whichever of the fields above it best fits (wild_food_and_drink, secret_tips, or nearby_worth_going), rather than forcing a new category. If nothing genuine turns up for this specific ask, say so plainly rather than stretching an unrelated finding to fit.` : ""}

Never invent a dish, tip, or nearby place - if nothing genuinely notable turns up for a slot, return fewer items (or none) rather than forcing a generic one.
${customInstructionsBlock(customInstructions)}
Call submit_planning_research with the result.
`.trim();

  const content = [{ type: "text", text: promptText }];
  for (const file of files) {
    content.push({
      type: file.mediaType.startsWith("image/") ? "image" : "document",
      source: {
        type: "base64",
        media_type: file.mediaType,
        data: file.base64,
      },
    });
  }

  try {
    const t0 = Date.now();
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: trimmedFocus ? 10500 : 9000,
        tools: [
          { ...WEB_SEARCH_TOOL, max_uses: trimmedFocus ? 4 : 3 },
          { ...WEB_FETCH_TOOL, max_uses: links.length > 0 ? links.length + 1 : 1 },
          PLANNING_RESEARCH_TOOL,
        ],
        messages: [{ role: "user", content }],
      }),
    });

    if (!res.ok) {
      console.error("[researchPlanningItem] API error:", res.status, (await res.text()).slice(0, 1000));
      return null;
    }

    const data = await res.json();
    await logUsage("researchPlanningItem", data, { durationMs: Date.now() - t0 });
    const blocks = data?.content || [];
    const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_planning_research");

    if (data?.stop_reason === "max_tokens") {
      console.error(`[researchPlanningItem] hit max_tokens (output_tokens=${data?.usage?.output_tokens})`);
    }

    if (!submitBlock) {
      console.error("[researchPlanningItem] no submit_planning_research tool call:", JSON.stringify(blocks).slice(0, 1000));
      return null;
    }

    const input = submitBlock.input || {};

    return {
      isFoodVenue: !!input.is_food_or_drink_venue,
      wildFoodAndDrink: Array.isArray(input.wild_food_and_drink)
        ? input.wild_food_and_drink.filter((i) => i?.name && i?.description).slice(0, 4)
        : [],
      secretTips: Array.isArray(input.secret_tips) ? input.secret_tips.filter((t) => typeof t === "string" && t.trim()).slice(0, 5) : [],
      nearbyWorthGoing: Array.isArray(input.nearby_worth_going)
        ? input.nearby_worth_going.filter((p) => p?.name && p?.why).slice(0, 3)
        : [],
      summary: input.summary || null,
    };
  } catch (err) {
    console.error("[researchPlanningItem] threw:", err);
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
  const systemPrompt = await buildSystemPrompt(roundedDuration, resolvedPlatform);

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

  const t0 = Date.now();
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
  await logUsage("writeVoiceoverFromReel", data, { durationMs: Date.now() - t0 });
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
  const systemPrompt = await buildSystemPrompt(60, resolvedPlatform);

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

  const t0 = Date.now();
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      // Flat 2500 was only ever enough for a couple of clips - it started
      // hitting stop_reason "max_tokens" (scene_summary/edit_plan cut off
      // mid-place) once more clips meant more to write up, the same issue
      // findNearbyFilmingIdeas/findDiscoveryIdeas hit for the same reason
      // (see the comment there): Sonnet 5 runs adaptive thinking by
      // default even though this call never sets `thinking` itself, and
      // those tokens draw from this same ceiling. Scales generously with
      // clip count instead of a fixed number.
      max_tokens: 4000 + clips.length * 400,
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
  await logUsage("writeReelEditPlan", data, { durationMs: Date.now() - t0 });
  const blocks = data?.content || [];
  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_reel_edit_plan");

  if (data?.stop_reason === "max_tokens") {
    console.error(`[writeReelEditPlan] hit max_tokens (output_tokens=${data?.usage?.output_tokens}, clips=${clips.length}) - response likely truncated mid-plan.`);
  }

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

  const systemPrompt = await buildSystemPrompt(resolvedLength, platform);

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

  const t0 = Date.now();
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
    `[claude] platform=${platform} attempt=${attemptNumber} stop_reason=${data?.stop_reason} content_blocks=${blocks.length} used_web_search=${usedWebSearch} got_submit_post=${!!submitBlock}`
  );
  await logUsage(`attemptGeneration(${platform})`, data, { durationMs: Date.now() - t0 });

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
