import { buildSystemPrompt, platformLabelFor, getCustomInstructions } from "./voiceProfile";
import { fetchOgImage } from "./ogImage";
import { getSupabase } from "./supabase";
import { headers } from "next/headers";

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
//
// rawText: optional full model output text, stored alongside the cost row
// so a wrong-but-well-formed result (a garbled/hallucinated place NAME
// that still parses cleanly, e.g.) can be diagnosed from what the model
// actually wrote instead of only the already-parsed fields shown in the
// UI - or, for a search-grounded call, so a specific real-world claim in
// the finished content can be traced back to an actual search result
// rather than guessed at (see summarizeApiBlocks below). Passed by
// findDiscoveryIdeas/findNearbyFilmingIdeas (place NAMEs go straight
// through with no verification step, unlike the style/food image links,
// which do get fetched and checked before ever being shown) and by
// attemptGeneration (to see what its one search actually queried/found
// versus what came from the model's own training knowledge).
// Which side of the app a call came from, so real usage can be told from
// development. Same hostnames MonthlySpend.js gates its badge on, read
// here from the request's own Host header rather than passed down through
// every call site - headers() is request-scoped, so reading it inside
// logUsage keeps twelve route handlers and every function between them
// out of the business of knowing about cost attribution.
//
// Returns null rather than guessing when there's no request context to
// read (nothing calls logUsage outside one today, but a script or a
// background job later would land here). A null is stored as "unknown"
// rather than silently counted as real usage - a spend figure that
// quietly includes your own testing is the exact problem this solves.
const LOCAL_HOSTNAMES = ["localhost", "127.0.0.1", "::1", "[::1]"];

async function requestIsLocal() {
  try {
    const host = (await headers()).get("host") || "";
    // Strip the port: "localhost:3000" and "localhost" are the same origin
    // for this purpose. IPv6 hosts arrive bracketed ("[::1]:3000"), which
    // this leaves intact by only splitting on a trailing :port.
    const hostname = host.toLowerCase().replace(/:\d+$/, "");
    return LOCAL_HOSTNAMES.includes(hostname);
  } catch {
    return null;
  }
}

async function logUsage(label, data, { model = MODEL, durationMs = null, rawText = null } = {}) {
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
  const isLocal = await requestIsLocal();
  try {
    const { error } = await supabase.from("api_cost_logs").insert({
      feature: label,
      is_local: isLocal,
      model,
      cost_usd: cost,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_tokens: usage.cache_read_input_tokens || 0,
      cache_write_tokens: usage.cache_creation_input_tokens || 0,
      searches,
      duration_ms: durationMs,
      raw_response: rawText,
    });
    if (error) console.error("[logUsage] failed to persist cost log:", error.message);
  } catch (err) {
    console.error("[logUsage] threw persisting cost log:", err);
  }
}

// Turns a response's raw content blocks into a readable trace of what it
// actually searched for, what real results came back, and what it
// ultimately submitted - so a specific real-world claim in the finished
// content (a TV show reference, a factual detail) can be traced back to
// whether it genuinely came from a live search result or the model's own
// training knowledge, instead of guessing. Generic across any call using
// WEB_SEARCH_TOOL plus a submit_* tool - not tied to one feature.
function summarizeApiBlocks(blocks) {
  return (blocks || [])
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "server_tool_use" && b.name === "web_search") {
        return `SEARCH QUERY: ${b.input?.query || "(none)"}`;
      }
      if (b.type === "web_search_tool_result") {
        // Success `content` is a list of results; an error is a single
        // object instead (e.g. {error_code: "..."}) - branch before
        // indexing rather than assuming the list shape always holds.
        if (Array.isArray(b.content)) {
          return `SEARCH RESULTS:\n${b.content
            .map((r, i) => `${i + 1}. ${r.title || "(untitled)"} - ${r.url}`)
            .join("\n")}`;
        }
        return `SEARCH RESULTS: (error) ${JSON.stringify(b.content)}`;
      }
      if (b.type === "tool_use") {
        return `TOOL CALL (${b.name}):\n${JSON.stringify(b.input, null, 2)}`;
      }
      return null;
    })
    .filter(Boolean)
    .join("\n\n");
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
// extra required field (titles) that TikTok/Instagram don't have at all -
// titles only exists in the schema for a youtube call, rather than being an
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
              titles: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 3,
                description: "EXACTLY 3 title options for this YouTube Short, to pick between at upload time. Each one: front-load the one concrete, specific hook detail as real searchable language (a person could plausibly type it), not just a vibe or pun. This is indexed/searchable metadata on YouTube, unlike a TikTok/Instagram caption, so treat it accordingly. Roughly 40-60 characters each so they don't get truncated. They must be three genuinely DIFFERENT angles on the same video - e.g. one leading with the specific thing itself, one with the surprise/contrast, one with the place or the question a viewer would actually search - not one title reworded three times with synonyms. All three must be equally honest about what the video actually shows; never make one more clickable by overstating it. Order them best-first, since the first is what gets used unless she picks another.",
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
        ...(isYouTube ? ["titles"] : []),
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
// - pickHashtags() and suggestMusic() below send no `tools` at
//   all, for any platform - so with the shared block now byte-identical
//   across platforms, their cache CAN be shared across all three
//   platforms generated from one click, not just retries of one platform.
// - attemptGeneration()'s own main call still can't share its cache
//   across platforms even with this split, because buildSubmitPostTool()
//   (its `tools` entry) genuinely differs by platform (YouTube's `titles`
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

// One optional, per-platform extra - only run when the user explicitly
// asks for it (an opt-in toggle, not a default), and its own small call
// for the same reason hashtag_rationale moved out of the main schema:
// this is exactly the kind of "nice to have" field that gets shortcut
// once a schema is crowded, so it never touches buildSubmitPostTool at
// all. Degrades to null on any failure - it's genuinely optional, so a
// failure here should never block or retry the actual post generation
// the way a missing required field does.

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

// Estimates a real, typical out-of-pocket cost for two people at a
// specific Planning item - an admission/ticket price, a typical bill for
// two (if it's a restaurant/bar/food spot), a rental or tour fee, whatever
// actually applies - grounded in a live search rather than guessed from
// the model's own training knowledge, same reasoning as every other
// price-shaped question in this app (analyzeRestaurant's menu prices,
// suggestForPlace's food picks). Distinct from api_cost_logs' own spend
// tracking - this is what the PLACE costs to visit, not what asking
// Claude about it costs (though this call is itself logged there too,
// under its own "estimateItemCost" feature name, same as every other
// call in this file).
export async function estimateItemCost({ name, placeCategory, area, searchLocation }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !name) return null;

  const prompt = `
You're helping a trip planner budget a specific stop. Here's the place:
Name: ${name}
Category: ${placeCategory || "(not specified)"}
Area: ${area || "(not specified)"}
Broader location: ${searchLocation || "(not specified)"}

Do a web search for real, current pricing for this exact place - an admission/ticket price, a typical bill for two people (if it's a restaurant/bar/food spot), a rental or tour fee, whatever actually applies. If it's genuinely free to do/visit (a public trail, a scenic viewpoint, walking around a neighborhood), say so.

Respond in EXACTLY this format and nothing else:
COST: <a single number - the estimated total US dollar cost for TWO people, e.g. 45.00 - or 0 if genuinely free>
NOTE: <one short sentence - what the number covers, e.g. "Two 3-course dinners at average entree price" or "Free public trail, no fees" - or "Couldn't find real pricing for this" if a search genuinely turned up nothing to base an estimate on>
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
    await logUsage("estimateItemCost", data, { durationMs: Date.now() - t0 });
    const textBlocks = (data?.content || []).filter((b) => b.type === "text");
    const text = textBlocks.map((b) => b.text).join("\n").trim();

    return parseCostEstimate(text);
  } catch {
    return null;
  }
}

// Pulls the COST/NOTE pair out of estimateItemCost's plain-text response -
// same labeled-field approach as the rest of this file (see the comment
// above parseNearbyIdeasSection below) rather than asking for JSON, which
// the model doesn't reliably hold to for a one-line answer like this.
// Returns null (rather than a zeroed-out estimate) when the response
// doesn't even contain a parseable COST line, so a malformed response
// surfaces as "couldn't estimate" instead of silently saving $0.
function parseCostEstimate(text) {
  if (!text) return null;
  const costMatch = text.match(/COST:\s*\$?([\d,]+(?:\.\d+)?)/i);
  const noteMatch = text.match(/NOTE:\s*(.+)/i);
  if (!costMatch) return null;
  const costUsd = Number(costMatch[1].replace(/,/g, ""));
  if (!Number.isFinite(costUsd)) return null;
  return { costUsd, note: noteMatch ? noteMatch[1].trim() : "" };
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

  // Same shared/per-request split as findDiscoveryIdeas above, and the
  // same caveat: the cache only hits between calls that picked the same
  // number of categories, since `tools.max_uses` (which renders before
  // `system`) scales with categoryList.length.
  const sharedInstructions = `
You're helping plan a single filming day around a primary idea that's already chosen, so multiple things can be filmed nearby without a second trip out.

Phrase each category's search to surface BOTH already-popular/proven spots AND overlooked ones together (e.g. "best and hidden gem speakeasy bars near Boothbay Harbor Maine reviews"), so one search per category can genuinely turn up candidates for either bucket - don't run a separate search per bucket, that's what silently drops whole categories under a shared search budget.

Once every category has been searched, sort every place you found with genuine evidence into one of two buckets, based on what the evidence for that specific place actually shows:
- VIRAL - places with real evidence of social buzz, strong reviews, being locally well-known or frequently posted about.
- HIDDEN - newly opened, rarely covered on social media, under-the-radar, or seeming to have real filming potential but not yet discovered.

Only include a place if you have genuine search evidence backing both its category fit and its bucket - never invent a place, never guess a distance without evidence (say "distance not confirmed" rather than making one up), and never force a "proven" or "hidden gem" label onto something the search didn't actually support. If a bucket ends up with nothing genuinely fitting, leave that section's list empty rather than padding it with mediocre or moderately-known filler - an honest "nothing stood out" is a valid result, but a place any category's search actually turned up with real evidence should never be dropped just because it doesn't fit one bucket cleanly - put it in whichever bucket the evidence best supports.

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

  const prompt = `
Primary idea already chosen: ${idea}
Location: ${location}
Story beat / detail: ${storyBeat || "(none given)"}

Find real, specific places within roughly a 10-mile / short-drive radius of ${location} worth filming alongside the primary idea above.

Do ONE search for EACH of these categories - do not skip any of them, even if you already feel confident about a category from general knowledge:
${categorySearchLines}
${customInstructionsBlock(customInstructions)}
Follow the response format and evidence rules given above exactly.
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
        // Tried the 1h TTL here (2x write vs 1.25x) on the theory that
        // real searches land 5-15 minutes apart, past the 5-minute
        // default. Live-tested and reverted: a real 3-call sequence (see
        // git history / api_cost_logs around 2026-09-14) cost $0.50 on 1h
        // TTL vs a computed $0.31 had those same calls run on the 5-minute
        // default - even though the 5-minute version would have MISSED
        // the one call that landed 8 minutes out. The 2x tax applies to
        // every write whether or not a read ever comes back for it, and
        // that tax outweighed the one caught miss. Separately, several
        // real historical calls already showed cache hits at 14-17
        // minutes under this plain 5-minute default - longer than its
        // documented minimum - undercutting the case for paying more for
        // a longer guaranteed window in the first place.
        system: [{ type: "text", text: sharedInstructions, cache_control: { type: "ephemeral" } }],
        // Fixed at the "all categories" ceiling regardless of this call's
        // actual category count - see the identical comment in
        // findDiscoveryIdeas for why: max_uses is a cap, not a target (no
        // cost difference for a smaller selection), and fixing it makes
        // `tools` byte-identical across every category combination, so the
        // shared instructions above can cache between ANY two calls within
        // the TTL rather than only ones that picked the same category count.
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: NEARBY_ALL_CATEGORIES.length + 3 }],
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
    await logUsage("findNearbyFilmingIdeas", data, { durationMs: Date.now() - t0, rawText: text });
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
// "YYYY-MM-DD" (an <input type="date">'s native value) to a readable
// "October 5, 2026" for the prompt - built from separate y/m/d numbers
// rather than new Date(isoDate) directly, same UTC-midnight-parsing
// timezone trap as dateKey()/formatShortDate() everywhere else in this
// app, even though it's server-side here: this runs on whatever machine
// hosts the request, not necessarily US-local time.
function formatLongDate(isoDate) {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export async function findDiscoveryIdeas({ location, categories, focus, date }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !location) return null;

  const trimmedFocus = typeof focus === "string" ? focus.trim() : "";
  const formattedDate = typeof date === "string" ? formatLongDate(date.trim()) : "";
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

  // Split into a location/category-independent block (the bucket
  // definitions, evidence rules, and output format spec - identical for
  // every Discovery call, and the largest chunk of this prompt's tokens)
  // and a per-request block (location, focus, category list, custom
  // instructions). cachedSystemBlockRaw() below puts only the first part
  // behind a cache breakpoint, so repeat Discovery searches can read that
  // shared instruction block at 0.1x instead of paying full price to
  // resend it every time. Real caveat, not glossed over: `tools` renders
  // before `system` in the cache prefix, and this call's `max_uses`
  // scales with category count - so the cache only actually hits between
  // calls that picked the same number of categories (in practice, mostly
  // "all categories" against "all categories", since that's the default).
  // Wording changed from the original in one place only: AREA's
  // description no longer repeats "${location}" inline, since that's
  // what made this block location-dependent in the first place - the
  // per-request block already states Location: ${location} once, right
  // above where the model reads this.
  const sharedInstructions = `
You're helping a travel content creator discover real things to do in a location - not tied to any specific idea already chosen, just genuinely worth visiting/filming there.

Phrase each category's search to surface BOTH well-known/popular spots AND lesser-known/overlooked ones together (e.g. "best and hidden gem speakeasy bars near Boothbay Harbor Maine reviews"), so one search per category can genuinely turn up candidates for more than one bucket - don't run a separate search per bucket, that's what silently drops whole categories under a shared search budget.

Once every category has been searched, sort every place you found with genuine evidence into exactly one of three buckets, based on what the evidence for that specific place actually shows:
- POPULAR - well-known draws with real evidence of tourism traffic, strong reviews, or being a well-known must-visit.
- INTERESTING - genuinely interesting or unique but not necessarily top-tourist-list material - a distinctive experience, an unusual activity, something with a real "huh, I didn't know that was here" quality, backed by real evidence it exists and is worth it.
- HIDDEN - new, under-the-radar, rarely covered, or seeming to have real potential but not yet widely discovered, with real evidence for that too.

Only include a place if you have genuine search evidence backing both its category fit and which bucket it belongs in - never invent a place, never guess at an area/town without evidence (say "area not specified" rather than making one up), and never force a "popular," "interesting," or "hidden gem" label onto something the search didn't actually support. If a bucket ends up with nothing genuinely fitting, leave that section's list empty rather than padding it with mediocre filler - an honest "nothing stood out" is a valid result, but a place any category's search actually turned up with real evidence should never be dropped just because it doesn't fit one specific bucket cleanly - put it in whichever bucket the evidence best supports.

Respond in EXACTLY this format and nothing else - up to 7 places per section, each place as five labeled lines in this exact order. A field's text can wrap onto more than one line if it needs to (keep wrapped lines plain, no new label on them) - just always start the NEXT field on its own line with its label. NAME is ONLY the place's name - never a sentence, clause, or dash-appended description tacked onto it, no matter how short or true. WRONG (never do this): "Coastal Maine Botanical Gardens—the largest botanical garden in New England with 295 acres." RIGHT: "Coastal Maine Botanical Gardens" as NAME, with every one of those extra facts moved into WHY instead, where they belong:
---POPULAR---
NAME: <place name, and ONLY the name>
CATEGORY: <category>
AREA: <town/neighborhood, or "area not specified">
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

  const prompt = `
Location: ${location}

Find real, specific places or experiences in and around ${location}. If this is a broad area (a whole state or region, not one town), spread results across different towns/areas within it rather than clustering on just one spot. If it's a specific city/town instead, stay within it or a short drive of it (roughly 30-45 minutes) - a search turning up a genuinely well-known day-trip destination further out doesn't mean it belongs here; only include it if you clearly label it as a day trip (say so plainly in AREA and WHY) rather than presenting it as if it's in ${location} itself.
${
    trimmedFocus
      ? `\nShe's specifically looking for: "${trimmedFocus}" - fold this into EVERY category search below (e.g. for a focus of "christmas things," the "hiking/outdoors" category becomes something like "christmas lights walk hiking trail near ${location}", not a generic hiking search with no connection to the focus). A category is only worth including in the results at all if what it turned up genuinely connects to this focus - a generic result for that category with no real tie to it should be left out rather than padded in just to fill the category. This isn't just a filter for which places make the list - every WHY must explicitly SAY how that place connects to "${trimmedFocus}", specifically and concretely (e.g. for a dog breed, name the actual dog-friendly feature - off-leash areas, shaded wide trails, a patio that allows dogs - not just "a scenic trail" with the connection left for the reader to guess). If a genuinely good place can't be described with a real, specific tie to the focus, leave it out rather than including it and hoping the connection is implied.\n`
      : ""
  }${
    formattedDate
      ? `\nShe's planning around this date: ${formattedDate} - fold that timing into EVERY category search below too (e.g. "best hiking trails near ${location} in early October" rather than a generic, date-blind search), so anything seasonal (open/closed for the season, in-bloom, snow-covered, a limited-run exhibit) surfaces the way it actually is around then. Separately, if any category's search happens to turn up a real, genuinely notable event, festival, or seasonal happening in or near ${location} around that date - backed by real search evidence, a real event name and an actual date, never a guess - include it as its own standout result even though it's temporary rather than a permanent place, naming the real event and its real date directly in WHY. Same integrity rule as everywhere else here: never claim something is "happening around then" without genuine search evidence it actually is - an honest lack of anything notable that week is a valid result, not a gap to fill.\n`
      : ""
  }
Do ONE search for EACH of these categories - do not skip any of them, even if you already feel confident about a category from general knowledge:
${categorySearchLines}
${customInstructionsBlock(customInstructions)}
Follow the response format and evidence rules given above exactly.
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
        // Plain 5-minute default, not a 1h TTL - see the comment on the
        // identical line in findNearbyFilmingIdeas for why: live-tested
        // and reverted, the 2x write tax cost more in practice than the
        // reads it caught paid back.
        system: [{ type: "text", text: sharedInstructions, cache_control: { type: "ephemeral" } }],
        // Fixed at the "all categories" ceiling regardless of how many
        // categories THIS call actually picked - max_uses is a cap, not a
        // target, so this costs nothing extra for a smaller selection (the
        // model still only searches once per category the prompt actually
        // lists). What it buys: `tools` renders before `system` in the
        // cache prefix, so a `max_uses` that varied by category count used
        // to mean the shared instructions above could only cache between
        // calls that happened to pick the exact same number of categories.
        // Fixed here, a 1-category search and an all-categories search now
        // share the same tools byte-for-byte, so the cache can hit between
        // ANY two Discovery calls within the TTL - not just matching ones.
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: DISCOVERY_ALL_CATEGORIES.length + 3 }],
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
    await logUsage("findDiscoveryIdeas", data, { durationMs: Date.now() - t0, rawText: text });
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
      whats_happening_then: {
        type: "array",
        description: "ONLY include this field at all if a specific planned visit date was given above. Up to 3 real, specific things actually happening in the area around that exact date - a seasonal event, festival, exhibit, closure, or altered hours that would genuinely change what to expect or film. Same integrity rule as everywhere else here: never invent one. If nothing genuine turns up for that date, return exactly one entry saying so plainly (e.g. 'Nothing specific found for this date') rather than leaving it empty in a way that looks unchecked, or stretching an unrelated general fact to fill it.",
        items: { type: "string" },
      },
    },
    required: ["is_food_or_drink_venue", "wild_food_and_drink", "secret_tips", "nearby_worth_going", "summary"],
  },
};

// "December 15, 2026" from a plain "YYYY-MM-DD" string - built from
// separate y/m/d numbers rather than `new Date(plannedDate)` directly,
// since that parses a bare date-only string as UTC midnight, which can
// display as the PREVIOUS day in any negative-UTC-offset timezone (the
// whole US). Same reasoning as dateKey()/formatShortDate() elsewhere.
function formatPlannedDateForPrompt(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export async function researchPlanningItem({
  name,
  placeCategory,
  area,
  searchLocation,
  focus,
  menuLinks,
  menuFiles,
  plannedDate,
}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !name) return null;

  const customInstructions = await getCustomInstructions();
  const trimmedFocus = typeof focus === "string" ? focus.trim() : "";
  const readablePlannedDate = typeof plannedDate === "string" && plannedDate ? formatPlannedDateForPrompt(plannedDate) : "";
  // Same shape/cap as analyzeRestaurant's own menu links - a place can
  // have separate food/drink/dessert menus worth checking.
  const links = (Array.isArray(menuLinks) ? menuLinks : menuLinks ? [menuLinks] : [])
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter(Boolean)
    .slice(0, 5);
  // Same shape/cap as analyzeRestaurant's own uploaded files.
  const files = (Array.isArray(menuFiles) ? menuFiles : []).filter((f) => f?.base64 && f?.mediaType).slice(0, 3);
  const hasMenuSource = !!(links.length > 0 || files.length > 0);

  // Built as a list rather than a hardcoded "1./2./3./4." string so the
  // numbering stays correct regardless of which optional tasks (focus,
  // plannedDate) are actually present - both, either, or neither.
  const searchTasks = [
    `Wild, unusual, or genuinely standout food/drink items here${
      hasMenuSource ? " - check the real menu given above FIRST, before falling back to a general search" : ""
    } (or if it's not a food/drink venue, the most surprising specific things to do/see there) - the kind of find worth building a video around, not a safe generic pick.`,
    "Real insider tips a first-time visitor wouldn't know - timing, booking tricks, easy-to-miss details, cost hacks, honest warnings.",
    "Up to 3 other REAL nearby places genuinely worth visiting while already in the area.",
  ];
  if (trimmedFocus) {
    searchTasks.push(
      `She specifically wants you to dig into this too, with its own dedicated search: "${trimmedFocus}" - fold whatever you genuinely find into whichever of the fields above it best fits (wild_food_and_drink, secret_tips, or nearby_worth_going), rather than forcing a new category. If nothing genuine turns up for this specific ask, say so plainly rather than stretching an unrelated finding to fit.`
    );
  }
  if (readablePlannedDate) {
    searchTasks.push(
      `She's planning to visit on ${readablePlannedDate} specifically - do a dedicated search for anything actually happening in the area around that date: a seasonal event, festival, exhibit, closure, or altered hours that would genuinely change what to expect or film. Put whatever you find in whats_happening_then. If nothing specific turns up for that date, say so plainly there (e.g. "Nothing specific found for this date") rather than leaving it looking unchecked or inventing something.`
    );
  }
  const searchTaskList = searchTasks.map((t, i) => `${i + 1}. ${t}`).join("\n");

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
  }Do up to ${searchTasks.length} web searches (and fetch a promising page if you find one) to find:
${searchTaskList}

Never invent a dish, tip, nearby place, or event - if nothing genuinely notable turns up for a slot, return fewer items (or none) rather than forcing a generic one.
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
        // Base 9000 covers the 3 always-on tasks; each optional one
        // (focus, plannedDate) gets the same +1500 headroom the focus
        // field alone used to add, scaled by how many are actually
        // present rather than hardcoded to "focus or not".
        max_tokens: 9000 + (searchTasks.length - 3) * 1500,
        tools: [
          { ...WEB_SEARCH_TOOL, max_uses: searchTasks.length },
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
    const blocks = data?.content || [];
    const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_planning_research");
    // Store the same searched-vs-submitted trace the generation path
    // keeps (summarizeApiBlocks is deliberately generic across any
    // WEB_SEARCH_TOOL + submit_* call). Research states real-world facts
    // about a place, so telling a live search result apart from the
    // model's own recall matters here for the same reason it does there -
    // and without it, a run that comes back empty leaves nothing to look at.
    await logUsage("researchPlanningItem", data, {
      durationMs: Date.now() - t0,
      rawText: summarizeApiBlocks(blocks),
    });

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
      // Gated on readablePlannedDate in code, not just in the prompt: the
      // tool schema always exposes whats_happening_then (tool definitions
      // are static), so a model that fills it in anyway on an undated item
      // would otherwise reach the UI as a "Happening around your visit"
      // section for a visit that was never scheduled.
      whatsHappeningThen:
        readablePlannedDate && Array.isArray(input.whats_happening_then)
          ? input.whats_happening_then.filter((t) => typeof t === "string" && t.trim()).slice(0, 3)
          : [],
    };
  } catch (err) {
    console.error("[researchPlanningItem] threw:", err);
    return null;
  }
}

// Delivers the finished voiceover for the Reel Voiceover tab. Unlike
// the Content tab's old caption-narrated voiceover (which narrated an
// already-written caption
// for a post that doesn't exist as footage yet), this is grounded in real
// footage the user already filmed - frames sampled evenly across the
// video client-side (see lib/videoFrames.js) and sent here as image
// blocks in chronological order. A dedicated tool call, not free text,
// because accuracy matters more here than anywhere else in this file: the
// entire point is that the script matches what's actually on screen, so
// this needs the same reliability treatment buildSubmitPostTool() gets,
// not the looser free-text format pickHashtags()/suggestMusic()
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
function buildFootageDescriptionTool() {
  return {
    name: "submit_footage_description",
    description: "Deliver a plain, accurate rundown of what this footage actually shows. Call exactly once, after reviewing every frame in order.",
    input_schema: {
      type: "object",
      properties: {
        scene_summary: {
          type: "string",
          description: "A concrete, chronological rundown of what actually happens in the footage, as one string with each beat on its own line separated by a newline character (\n) - not numbered, not a JSON array. Describe only what is genuinely visible: the real order of events, the specific things on screen (a dish, a sign, a room, a gesture), and anything a caption could honestly point at. Never guess at a name, a place, or a fact you can't see - if something is unidentifiable, describe it plainly as what it looks like rather than naming it. Vibe words alone ('cozy', 'beautiful') are not a beat; say what is actually shown.",
        },
      },
      required: ["scene_summary"],
    },
  };
}

// The Content tab's caption grounding: read the finished reel and report
// what's actually in it, so the caption/title/cover text describe the real
// video rather than the idea the user typed before filming. Deliberately
// NOT writeVoiceoverFromReel - that one also writes a script, which costs
// tokens this path would only throw away.
//
// frames: [{ base64, mediaType, timestampSeconds }], already extracted
// client-side (see lib/videoFrames.js) so the original video never has to
// be uploaded anywhere - only these small JPEGs make the trip.
export async function describeReelFootage({ frames, durationSeconds, idea, location, notes }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md).");
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("No video frames were provided.");
  }

  const roundedDuration = Math.max(5, Math.round(durationSeconds || 0));

  const introText = `
You're looking at real footage a creator has already filmed, sampled as ${frames.length} frames spread evenly across the full ~${roundedDuration}-second video, in chronological order (each labeled with its approximate timestamp). Describe what's actually in it, accurately and concretely - this description is about to be used to write the caption for this exact video, so anything you state here can end up being claimed publicly.
${idea ? `
What the creator says this is about (context for names/facts only - defer to what you actually see if it conflicts): ${idea}` : ""}
${location ? `Location: ${location}` : ""}
${notes ? `Extra context not necessarily visible on camera: ${notes}` : ""}

Review the frames below in order, then call submit_footage_description.
`.trim();

  const content = [{ type: "text", text: introText }];
  frames.forEach((frame, i) => {
    content.push({ type: "text", text: `Frame ${i + 1} of ${frames.length}, ~${frame.timestampSeconds}s in:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: frame.mediaType || "image/jpeg", data: frame.base64 },
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
      max_tokens: 2000,
      tools: [buildFootageDescriptionTool()],
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];
  await logUsage("describeReelFootage", data, { durationMs: Date.now() - t0, rawText: summarizeApiBlocks(blocks) });
  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_footage_description");

  if (!submitBlock) {
    console.error("[describeReelFootage] no submit_footage_description tool call:", JSON.stringify(blocks).slice(0, 800));
    throw new Error("Claude did not describe the footage.");
  }

  const sceneSummary = parseShotNotes(submitBlock.input?.scene_summary);
  if (sceneSummary.length === 0) {
    throw new Error("Claude's footage description came back empty.");
  }

  return { sceneSummary };
}

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
    footageContext,
    lengthSeconds,
    platform,
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
}${
  footageContext
    ? `
WHAT THE FINISHED VIDEO ACTUALLY SHOWS (read from the real footage before this call, beat by beat in order):
${footageContext}
This video already exists - it is not a plan. Write the caption, title and cover text about THIS footage: lead with something genuinely visible in it, and match the order things actually happen. Where this conflicts with the topic/story beat above, the footage wins - those were written before filming. Never describe a moment, dish, or detail that isn't in the rundown above just because the idea implies it, and don't promise something the video doesn't deliver.
`
    : ""
}
Before writing, you have up to TWO web searches available - use them for two different jobs, not the same job twice:
1. A fact-finding search on the topic/location itself, so any specific, checkable claim you put in the caption (a historical detail, a pop-culture/filming tie-in, anything a viewer could verify) is something this search actually confirmed - see the CAPTION FACT INTEGRITY RULE above. Skip this one only if the topic is simple enough that nothing you plan to claim needs checking.
2. A search for currently trending ${platformLabel} hashtags or sounds relevant to this specific topic/location (e.g. "trending ${platformLabel.toLowerCase()} hashtags [topic] 2026" or "[location] ${platformLabel.toLowerCase()} trend") to check what's live right now - skip this one if pre-fetched trending hashtags were already given above, and use those instead. If the user gave free-text notes above, fold whatever's relevant into this search query too (e.g. a hashtag or sound they mentioned) and weigh it heavily if it's genuinely usable.
If anything from either search is worth carrying forward, mention it in hook_strategy if it shaped the hook, or just let it inform the finished caption - the hashtag strategy and final 5 tags are handled entirely in a separate step after this one, so don't write anything hashtag-specific here.

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
      // Raised 1 -> 2: live testing caught the model already trying to run
      // two searches on its own (one general fact-check, one for trending
      // hashtags) and getting the second rejected with max_uses_exceeded -
      // it didn't just drop the extra angle when blocked, it went on to
      // state a specific, unconfirmed "fact" as settled truth anyway (see
      // the CAPTION FACT INTEGRITY RULE in voiceProfile.js, added
      // alongside this fix). Letting it actually make both searches costs
      // at most one more $0.01 web_search fee per generation.
      tools: [{ ...WEB_SEARCH_TOOL, max_uses: 2 }, buildSubmitPostTool(platform)],
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
  await logUsage(`attemptGeneration(${platform})`, data, {
    durationMs: Date.now() - t0,
    rawText: summarizeApiBlocks(blocks),
  });

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
  if (platform === "youtube") {
    // Checked as a real list of 3 rather than just "present": the whole
    // point is having genuine alternatives to choose from, and one title
    // in an array is the same as no choice at all. A short list is a
    // retryable malformed response, same as any other missing field here.
    const titles = Array.isArray(input.titles) ? input.titles.filter((t) => typeof t === "string" && t.trim()) : [];
    if (titles.length < 3) {
      problems.push(`titles did not come back as 3 usable options (got ${titles.length} from: ${JSON.stringify(input.titles)})`);
    }
  }
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

1. Write a short (1-3 sentence) neutral, plain-language rationale for the hashtag strategy - same tone/rules as the system prompt's other reasoning fields (no "her/she", never the literal words "Source A" or "Source B", no naming a specific past post). If the trend data above surfaced something genuinely usable, say so; if not, say that plainly rather than inventing a finding. Separately: if the caption above already names a specific real reason one of your tags fits especially well - a show/movie connection, a real event, a seasonal moment, anything more specific than the generic category a tag belongs to - say that plainly too, rather than only describing the tag's generic role (e.g. "niche" or "community"). Only ever name something the caption itself actually states; never infer or invent a connection that isn't there.
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

  // Opt-in only. Skipped entirely (not even called) when not requested,
  // so the common case pays zero extra latency or cost for this step.
  const musicSuggestion = includeMusic
    ? await suggestMusic(apiKey, input.description, input.hook_strategy, input.pattern_used, platformLabel)
    : null;

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
    music_suggestion: musicSuggestion,
    usedWebSearch,
  };
}

// ---------------------------------------------------------------------------
// Stories tab: break a finished reel into a handful of Instagram Story
// slides, each with one short line of text burned onto it (the "reel
// chopped into stories with a sentence on each" format a lot of creators
// use to push a new reel). Same frames-only approach as describeReelFootage
// above - the video never leaves the browser, only sampled JPEGs do, and
// the actual cutting/text overlay happens client-side (lib/storyClips.js).
// This call only decides where to cut and what each slide says.
function buildStoryPlanTool() {
  return {
    name: "submit_story_plan",
    description: "Deliver the finished Instagram Story plan for this reel, after reviewing every frame in order. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        scene_summary: {
          type: "string",
          description: "A concrete, chronological rundown of what the reel actually shows, one beat per line separated by a newline character (\\n) - not numbered. Only what is genuinely visible; never guess a name or fact you can't see.",
        },
        slides: {
          type: "array",
          description: "The story slides in posting order. Usually 3-6. Each is one continuous segment of the reel with one short line of on-screen text.",
          items: {
            type: "object",
            properties: {
              start_seconds: {
                type: "number",
                description: "Where this slide's segment starts in the reel, in seconds from the reel's beginning.",
              },
              end_seconds: {
                type: "number",
                description: "Where it ends, in seconds. Greater than start_seconds, at most the reel's real length. Aim for 3-12 seconds per slide.",
              },
              text: {
                type: "string",
                description: "The one short sentence shown on this slide - 12 words max, readable in about 2 seconds. First person, in her voice. No hashtags, no @handles, at most one emoji.",
              },
              text_position: {
                type: "string",
                enum: ["top", "center", "bottom"],
                description: "Where the text sits so it doesn't cover the subject (a face, the dish, the animal) in this segment's frames.",
              },
            },
            required: ["start_seconds", "end_seconds", "text", "text_position"],
          },
        },
      },
      required: ["scene_summary", "slides"],
    },
  };
}

export async function planStoriesFromReel({ frames, durationSeconds, idea, location, notes }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md).");
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error("No video frames were provided.");
  }

  const duration = Math.max(1, Number(durationSeconds) || 0);
  const customInstructions = await getCustomInstructions();

  const system = `You turn Leah's finished travel reels into Instagram Story sequences. Leah runs the travel brand Wine Wilderness Wanderlust (New England-based, also posts Canada and Europe). Her voice: warm, first-person, conversational, a little playful, never salesy; emoji used sparingly and tied to the subject.

How the format works: the reel is cut into a few short consecutive story slides, each with one short line of text on it, so someone tapping through her stories gets the gist and is pulled to the full reel. Rules:
- Slide 1 is the hook: the single most specific, surprising thing in the video, stated in the text (a number, a name, an unexpected detail) - never a generic "look where we went".
- Middle slides each land one new beat, in the order they actually happen in the footage. Pick the best moments; it's fine to skip dead time, shaky or repetitive stretches.
- The last slide sends people to the full video or starts a conversation (e.g. "Full reel is up on my page", "Would you try this?").
- Every line must be true to what's actually on screen plus the context given. Never invent a name, price, or fact you can't see or weren't told.
- Cut on natural scene changes, not mid-action. When two consecutive frames show different scenes, the change happened somewhere between their two timestamps - put the cut at the midpoint of those two timestamps, never at or past the later frame (that would leak the next scene into this slide).
${customInstructionsBlock(customInstructions)}
Call submit_story_plan with the result.`;

  const introText = `
Here's a finished reel, sampled as ${frames.length} frames spread evenly across its ~${Math.round(duration)} seconds, in order (each labeled with its timestamp).
${idea ? `What it's about (names/facts only - defer to what you see): ${idea}` : ""}
${location ? `Location: ${location}` : ""}
${notes ? `Anything she wants the stories to say or mention: ${notes}` : ""}

Review the frames, then call submit_story_plan.
`.trim();

  const content = [{ type: "text", text: introText }];
  frames.forEach((frame, i) => {
    content.push({ type: "text", text: `Frame ${i + 1} of ${frames.length}, ~${frame.timestampSeconds}s in:` });
    content.push({
      type: "image",
      source: { type: "base64", media_type: frame.mediaType || "image/jpeg", data: frame.base64 },
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
      // Adaptive thinking draws from this same ceiling (see the note on
      // writeReelEditPlan's max_tokens above), so it's generous.
      max_tokens: 5000,
      system,
      tools: [buildStoryPlanTool()],
      messages: [{ role: "user", content }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];
  await logUsage("planStoriesFromReel", data, { durationMs: Date.now() - t0, rawText: summarizeApiBlocks(blocks) });
  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_story_plan");

  if (!submitBlock) {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    console.error("[planStoriesFromReel] no submit_story_plan tool call:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude didn't return a story plan (stop_reason: ${data?.stop_reason}).${text ? ` It said instead: ${text.slice(0, 300)}` : ""}`
    );
  }

  // Guarded before it ever reaches ffmpeg, same reasoning as
  // writeReelEditPlan's segment check: clamp into the real video, drop
  // anything inverted or too short to read, keep slides in time order, and
  // never let two slides overlap (the later one is trimmed to start where
  // the earlier one ends). Instagram caps a single story video at 60s.
  const rawSlides = Array.isArray(submitBlock.input?.slides) ? submitBlock.input.slides : [];
  const slides = rawSlides
    .map((s) => ({
      startSeconds: Math.max(0, Number(s?.start_seconds) || 0),
      endSeconds: Math.min(duration, Number(s?.end_seconds) || 0),
      text: typeof s?.text === "string" ? s.text.trim() : "",
      textPosition: ["top", "center", "bottom"].includes(s?.text_position) ? s.text_position : "center",
    }))
    .filter((s) => s.endSeconds > s.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const cleaned = [];
  for (const s of slides) {
    const prev = cleaned[cleaned.length - 1];
    const start = prev ? Math.max(s.startSeconds, prev.endSeconds) : s.startSeconds;
    const end = Math.min(s.endSeconds, start + 60);
    if (end - start < 1) continue;
    cleaned.push({ ...s, startSeconds: start, endSeconds: end });
  }

  if (cleaned.length === 0) {
    console.error("[planStoriesFromReel] no usable slides, raw:", JSON.stringify(rawSlides).slice(0, 1500));
    throw new Error("Claude couldn't find usable story segments in this reel - try again, or a different file.");
  }

  return {
    sceneSummary: parseShotNotes(submitBlock.input?.scene_summary),
    slides: cleaned,
  };
}

// ---------------------------------------------------------------------------
// "Who to tag": accounts worth tagging on a post for the best shot at a
// repost - the venue itself, a parent brand if one genuinely owns it, the
// regional tourism board, feature/repost accounts for the niche, brands
// visibly in the footage.
//
// The hard part is "make sure the account is real". The model's own claim
// that a handle is official is exactly the kind of thing it can get wrong
// (a lookalike fan page, a handle that changed, or a parent company it
// assumed from the name), so it is never taken on trust. Every suggestion
// carries the owner's own official website, and the server fetches that
// site and checks which Instagram/TikTok handles it actually links to
// (handlesLinkedFromSite below) - a business's own site linking a handle is
// the strongest proof of officialness available without logging into
// Instagram. Big brands' sites often block that fetch, so Wikidata's
// record of an organization's official usernames is checked as well
// (wikidataOwners). Weaker but still real evidence: the handle's profile
// page itself turned up in the live search results. A handle with none of
// these is marked unverified, and the Content tab leaves it out of the list.
function buildTagSuggestionsTool() {
  return {
    name: "submit_tag_suggestions",
    description: "Deliver the ranked list of accounts to tag. Call exactly once.",
    // Strict mode makes the API itself guarantee the input matches this
    // schema. Without it, a live run returned `accounts` as one long string
    // of half-JSON instead of an array - the research was fine, but the
    // list was unreadable and the post showed zero accounts.
    strict: true,
    input_schema: {
      type: "object",
      properties: {
        accounts: {
          type: "array",
          description: "Up to 8 accounts, best first. Quality over quantity - an irrelevant tag looks spammy and does nothing.",
          items: {
            type: "object",
            properties: {
              name: { type: "string", description: "The organization/account's real name." },
              role: {
                type: "string",
                enum: ["venue", "parent_brand", "tourism_board", "feature_account", "product_brand", "other"],
              },
              instagram_handle: {
                type: "string",
                description: "Their Instagram handle without @, exactly as search shows it. Empty string if you didn't find one - never guess.",
              },
              tiktok_handle: {
                type: "string",
                description: "Their TikTok handle without @, exactly as search shows it. Empty string if you didn't find one - never guess.",
              },
              official_website: {
                type: "string",
                description: "The owner's own official website (homepage URL), used to verify the handles - a business's site usually links its real social accounts. Empty string for accounts that don't have one (e.g. many feature accounts).",
              },
              why: {
                type: "string",
                description: "One or two sentences: why tagging them could extend reach for THIS post specifically (do they repost creator content, run a feature program, have a large relevant audience?). Plain, neutral tone.",
              },
              repost_odds: {
                type: "string",
                enum: ["high", "medium", "low"],
                description: "Realistic chance they reshare or feature it, based on evidence (they visibly repost creators, ask to be tagged, run a feature hashtag) - not wishful thinking.",
              },
              how: {
                type: "string",
                enum: ["collab_invite", "photo_tag", "caption_mention"],
                description: "Best way to tag: collab_invite (Instagram Collab post - shows on both profiles; best for the venue or a partner likely to accept), photo_tag (tag on the reel itself), or caption_mention (@ in the caption).",
              },
              feature_hashtag: {
                type: "string",
                description: "A hashtag this account explicitly asks creators to use to be featured (e.g. from their bio), only if search confirmed it. Empty string otherwise.",
              },
            },
            required: ["name", "role", "instagram_handle", "tiktok_handle", "official_website", "why", "repost_odds", "how", "feature_hashtag"],
            additionalProperties: false,
          },
        },
        ownership_note: {
          type: "string",
          description: "One or two sentences on who actually owns/operates/manages the venue, as confirmed by search (e.g. which hotel group a property belongs to, or that it's independent). If a common assumption about its ownership is wrong, say so plainly. Empty string if not applicable.",
        },
      },
      required: ["accounts", "ownership_note"],
      additionalProperties: false,
    },
  };
}

// Social URL paths that aren't profiles - a site linking instagram.com/p/xyz
// (a post) or /explore isn't evidence of any handle.
const NON_PROFILE_PATHS = new Set([
  "p", "reel", "reels", "explore", "accounts", "stories", "tv", "share", "sharer", "about", "developer",
  "legal", "direct", "web", "embed", "embed.js", "static", "tag", "music", "discover", "login", "signup",
]);

function normalizeHandle(h) {
  return String(h || "").trim().replace(/^@+/, "").replace(/\.+$/, "").toLowerCase();
}

// Pulls every Instagram/TikTok profile handle linked anywhere in a blob of
// HTML or URLs - including JSON-escaped ones ("instagram.com\/name") that
// show up in script-rendered footers.
function extractSocialHandles(text) {
  const instagram = new Set();
  const tiktok = new Set();
  for (const m of String(text).matchAll(/instagram\.com(?:\\?\/)+([A-Za-z0-9._]{1,30})/gi)) {
    const h = normalizeHandle(m[1]);
    if (h && !NON_PROFILE_PATHS.has(h)) instagram.add(h);
  }
  for (const m of String(text).matchAll(/tiktok\.com(?:\\?\/)+@([A-Za-z0-9._]{1,30})/gi)) {
    const h = normalizeHandle(m[1]);
    if (h) tiktok.add(h);
  }
  return { instagram, tiktok };
}

// Only ever fetches a public http(s) site by hostname - the URL comes from
// model output, so plain IPs and local names are refused outright rather
// than letting a server-side fetch be pointed somewhere internal.
function safePublicUrl(raw) {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    if (!host.includes(".") || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return null;
    if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return null;
    return url;
  } catch {
    return null;
  }
}

async function fetchSiteHtml(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    // The whole body, since social links usually live in the footer at the
    // very end - capped only against something pathological.
    const html = await res.text();
    return html.slice(0, 3_000_000);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// The handles an official site actually links, trying the exact URL first
// and then the site's homepage (a deep link may not carry the global
// footer). null means the site couldn't be read at all - different from
// "read fine, links no socials".
async function handlesLinkedFromSite(rawUrl) {
  const url = safePublicUrl(rawUrl);
  if (!url) return null;

  let read = false;
  const found = { instagram: new Set(), tiktok: new Set(), domain: url.hostname.replace(/^www\./, "") };
  const candidates = [url.href];
  if (url.pathname !== "/" || url.search) candidates.push(url.origin + "/");
  for (const candidate of candidates) {
    const html = await fetchSiteHtml(candidate);
    if (!html) continue;
    read = true;
    const { instagram, tiktok } = extractSocialHandles(html);
    instagram.forEach((h) => found.instagram.add(h));
    tiktok.forEach((h) => found.tiktok.add(h));
    if (found.instagram.size > 0 || found.tiktok.size > 0) break;
  }
  return read ? found : null;
}

// Second independent check, for the big brands whose own sites refuse a
// server-side fetch outright (confirmed live: omnihotels.com, marriott.com
// and visitmaine.com all return 403 bot-protection pages) - exactly the
// accounts where tagging the right one matters most. Wikidata records the
// official Instagram (P2003) and TikTok (P7085) usernames of notable
// organizations, is free, needs no key, and is built for programmatic
// lookups. This asks the reverse question - "which organization is this
// exact username recorded for?" - so a lookalike account can never match.
// Coverage is partial (e.g. @omnihotels and @acadianps are recorded,
// @visitmaine isn't), so a miss here means "no evidence", not "fake".
//
// Every handle from one lookup goes into a single OR'd search plus a
// single entity fetch - two requests per "Who to tag" click, total.
// Wikimedia rate-limits bursts (a per-handle version tripped a 429 in
// testing), and a 429 or timeout just means no Wikidata evidence this time.
const WIKIDATA_PROPS = { instagram: "P2003", tiktok: "P7085" };
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
// Wikimedia's API policy asks for an identifying User-Agent.
const WIKIDATA_HEADERS = { "user-agent": "WanderHQ-tag-check/1.0 (creator tagging helper; low volume)" };

// pairs: [{ network: "instagram"|"tiktok", handle }] (already normalized).
// Returns a Map of "network:handle" -> { id, label } for every handle
// Wikidata records as some organization's official account.
async function wikidataOwners(pairs) {
  const owners = new Map();
  const clauses = [...new Set(pairs.filter((p) => p.handle && WIKIDATA_PROPS[p.network]).map((p) => `${WIKIDATA_PROPS[p.network]}=${p.handle}`))];
  if (clauses.length === 0) return owners;
  try {
    const searchRes = await fetch(
      `${WIKIDATA_API}?action=query&list=search&format=json&srlimit=30&srsearch=${encodeURIComponent(`haswbstatement:${clauses.join("|")}`)}`,
      { headers: WIKIDATA_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!searchRes.ok) return owners;
    const ids = ((await searchRes.json())?.query?.search || []).map((s) => s.title).filter(Boolean).slice(0, 50);
    if (ids.length === 0) return owners;

    const entitiesRes = await fetch(
      `${WIKIDATA_API}?action=wbgetentities&ids=${encodeURIComponent(ids.join("|"))}&props=labels%7Cclaims&languages=en&format=json`,
      { headers: WIKIDATA_HEADERS, signal: AbortSignal.timeout(6000) }
    );
    if (!entitiesRes.ok) return owners;
    const entities = (await entitiesRes.json())?.entities || {};

    // Maps each recorded username back to its organization - the search
    // only says "these entities matched one of the clauses", not which.
    for (const [id, entity] of Object.entries(entities)) {
      const label = entity?.labels?.en?.value || id;
      for (const [network, prop] of Object.entries(WIKIDATA_PROPS)) {
        for (const claim of entity?.claims?.[prop] || []) {
          const value = claim?.mainsnak?.datavalue?.value;
          if (typeof value === "string") owners.set(`${network}:${normalizeHandle(value)}`, { id, label });
        }
      }
    }
  } catch {
    // Timeout/network - no Wikidata evidence this time, nothing breaks.
  }
  return owners;
}

// One handle's verdict, strongest evidence first:
// - "official_site": the owner's own website links this exact handle.
// - "wikidata": Wikidata records this exact username as the official
//   account of a named organization (shown, so she can see whose it is).
// - "corrected": the owner's site links a DIFFERENT single handle - that
//   one is swapped in, since the business's own site is a better
//   authority than the model's recall.
// - "in_search": the profile URL itself appeared in the live search
//   results (it exists and is indexed under that exact handle).
// - "unverified": no independent evidence either way (the Content tab
//   leaves these out of the list entirely).
function verifyHandle(network, handle, site, owners, searchHandles) {
  const h = normalizeHandle(handle);
  if (!h) {
    // No handle given, but the owner's own site links exactly one - that's
    // the real account, straight from the source.
    if (site && site.handles.size === 1) {
      const [siteHandle] = [...site.handles];
      return { handle: siteHandle, status: "official_site", source: site.domain };
    }
    return null;
  }
  if (site && site.handles.has(h)) {
    return { handle: h, status: "official_site", source: site.domain };
  }
  const owner = owners.get(`${network}:${h}`);
  if (owner) {
    return { handle: h, status: "wikidata", source: owner.label, wikidataId: owner.id };
  }
  if (site && site.handles.size === 1) {
    const [siteHandle] = [...site.handles];
    return { handle: siteHandle, status: "corrected", source: site.domain, suggested: h };
  }
  if (searchHandles.has(h)) return { handle: h, status: "in_search", source: null };
  return { handle: h, status: "unverified", source: null };
}

// Strict mode should always hand back a real array, but if a list ever
// arrives as text again (see the note on buildTagSuggestionsTool), the
// array inside it is recovered rather than silently showing nothing.
function coerceAccountList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.filter((a) => a && typeof a === "object") : [];
  } catch {
    return [];
  }
}

// Full web search - quality over cost, by Leah's choice. Up to 5 searches
// cover the venue, who really owns it, the local tourism boards and the
// feature accounts; the server's quiet handle check then confirms each
// handle against the owner's own website, Wikidata, or the profile links in
// these search results, and anything unconfirmed is left off the list.
//
// Measured live: ~$0.24 a run. Cheaper versions were built and dropped
// because each missed something: no search (~$0.03) didn't know small or
// new places at all (it missed the venue for "Rocco Dessert Bar" - really
// Rococo Ice Cream & Dessert Bar in Kennebunk), and one search (~$0.07)
// found the venue but had no evidence left to confirm tourism boards like
// Visit Maine, whose website blocks automated checks. Search-result text is
// what drives the cost (the model re-reads everything gathered after each
// search), and the newer web_search_20260209 tool cost more ($0.38), so the
// basic tool stays.
const TAG_SEARCH_LIMIT = 5;

export async function findTagSuggestions({ idea, location, storyBeat, restaurantName, footageContext, description }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md).");
  }

  // Leah's Profile rules are deliberately NOT sent here, unlike most calls
  // in this file. They're writing rules (voice, phrasing, formatting) with
  // nothing to say about which accounts exist - and this call re-reads its
  // whole prompt on every search round, so a long style document in the
  // rules made up a large share of a $0.37 run when they were included.
  const prompt = `
Leah (travel creator, Wine Wilderness Wanderlust - New England-based, ~8.5K Instagram / ~11.6K TikTok followers) is about to post this:
Idea: ${idea}
Location: ${location}
${restaurantName ? `Restaurant/bar: ${restaurantName}\n` : ""}${storyBeat ? `Story beat: ${storyBeat}\n` : ""}${footageContext ? `What the video actually shows:\n${footageContext}\n` : ""}${description ? `\nThe caption she's posting:\n${description}\n` : ""}
Find the accounts she should tag to give this post the best realistic chance of being reshared or featured by a bigger account. Consider, in this order:
1. The venue/business itself - its real Instagram and TikTok handles. It must be the first account in your list whenever it has any social account at all. If the name as typed looks misspelled, find the real place.
2. Who actually owns or operates it (a hotel group, restaurant group, parent brand, a state park system). Verify ownership - don't assume it from the name or from what "sounds" related. Only suggest a parent brand if it genuinely owns/manages this place AND plausibly reshares property content. If you can't confirm who owns it, say so in ownership_note and don't suggest an owner.
3. The official tourism board(s) for the town/city, region and state/province (e.g. a "Visit ___" account) - these reshare creators constantly, so always include the state/province board, plus the town/city one if it has its own.
4. Established feature/repost accounts for this niche and region that are known to feature creators (they often ask to be tagged or use a feature hashtag).
5. A brand clearly visible in the footage, only if genuinely relevant.

You have up to ${TAG_SEARCH_LIMIT} web searches - make each one count by combining what you're looking for. A good plan: (1) the venue's own Instagram/TikTok and website, (2) who owns or operates it, (3) the tourism boards' Instagram accounts for its town and state/province, (4) feature/repost accounts for this niche and region, (5) whatever is still missing. Searches that return the Instagram/TikTok profile pages themselves are the most useful, since those links are what confirm a handle.

For each account, give its handle exactly as search shows it, and its official website (homepage) whenever it has one - the server reads that site to confirm or correct the handle. If you can't find a handle, leave it empty rather than guessing; a fake or lookalike account is worse than no tag. Only include accounts with a REAL connection to this post - never a "plausible regional player" you can't actually connect to it.

Then call submit_tag_suggestions.
`.trim();

  const messages = [{ role: "user", content: prompt }];
  const blocks = [];
  let data;
  const t0 = Date.now();

  // A long server-side search run can come back as stop_reason
  // "pause_turn" before the model has finished - passing its content back
  // lets it continue where it left off. Bounded so a stuck loop can't run
  // up cost.
  for (let turn = 0; turn < 3; turn++) {
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        tools: [{ ...WEB_SEARCH_TOOL, max_uses: TAG_SEARCH_LIMIT }, buildTagSuggestionsTool()],
        messages,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
    }

    data = await res.json();
    const turnBlocks = data?.content || [];
    blocks.push(...turnBlocks);
    await logUsage("findTagSuggestions", data, { durationMs: Date.now() - t0, rawText: summarizeApiBlocks(turnBlocks) });

    if (data?.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: turnBlocks });
  }

  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_tag_suggestions");
  if (!submitBlock) {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    console.error("[findTagSuggestions] no submit_tag_suggestions call:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude didn't return tag suggestions (stop_reason: ${data?.stop_reason}).${text ? ` It said instead: ${text.slice(0, 300)}` : ""}`
    );
  }

  // Every profile URL that appeared in the search results - evidence the
  // handle exists under that exact name, independent of what the model wrote.
  const searchHandles = extractSocialHandles(
    blocks
      .filter((b) => b.type === "web_search_tool_result" && Array.isArray(b.content))
      .flatMap((b) => b.content.map((r) => r.url || ""))
      .join("\n")
  );

  // Seen live twice on the same post (Gracie's, Providence): the model
  // wrote the whole account list INSIDE the ownership note string, after a
  // stray "</ownership_note><parameter name=\"accounts\">" - strict mode
  // can't catch it, since that's still a valid string. Accounts now come
  // first in the schema to avoid it, and if it happens anyway the list is
  // pulled back out and the note trimmed to just the note.
  let ownershipNote = String(submitBlock.input?.ownership_note || "");
  let accountsValue = submitBlock.input?.accounts;
  const leak = ownershipNote.search(/<\/?(ownership_note|parameter)\b/);
  if (leak !== -1) {
    const spilled = coerceAccountList(ownershipNote.slice(leak));
    if (coerceAccountList(accountsValue).length === 0 && spilled.length > 0) accountsValue = spilled;
    ownershipNote = ownershipNote.slice(0, leak);
    console.error("[findTagSuggestions] account list leaked into ownership_note - recovered", spilled.length);
  }
  const rawAccounts = coerceAccountList(accountsValue).slice(0, 8);

  // One fetch per distinct site, shared if two accounts name the same one.
  const siteLookups = new Map();
  function lookupSite(url) {
    if (!siteLookups.has(url)) siteLookups.set(url, handlesLinkedFromSite(url));
    return siteLookups.get(url);
  }

  const [sites, owners] = await Promise.all([
    Promise.all(
      rawAccounts.map((a) => {
        const website = String(a.official_website || "").trim();
        return website ? lookupSite(website) : null;
      })
    ),
    wikidataOwners(
      rawAccounts.flatMap((a) => [
        { network: "instagram", handle: normalizeHandle(a.instagram_handle) },
        { network: "tiktok", handle: normalizeHandle(a.tiktok_handle) },
      ])
    ),
  ]);

  const accounts = rawAccounts.map((a, i) => {
    const site = sites[i];
    const instagram = verifyHandle(
      "instagram",
      a.instagram_handle,
      site ? { handles: site.instagram, domain: site.domain } : null,
      owners,
      searchHandles.instagram
    );
    const tiktok = verifyHandle(
      "tiktok",
      a.tiktok_handle,
      site ? { handles: site.tiktok, domain: site.domain } : null,
      owners,
      searchHandles.tiktok
    );
    return {
      name: String(a.name || "").trim(),
      role: a.role || "other",
      why: String(a.why || "").trim(),
      repostOdds: ["high", "medium", "low"].includes(a.repost_odds) ? a.repost_odds : "low",
      how: ["collab_invite", "photo_tag", "caption_mention"].includes(a.how) ? a.how : "caption_mention",
      // Came back without its # in live testing ("MaineThing").
      featureHashtag: String(a.feature_hashtag || "").trim().replace(/^#*(?=\S)/, "#"),
      website: site ? site.domain : null,
      instagram,
      tiktok,
    };
  });

  const kept = accounts.filter((a) => a.name && (a.instagram || a.tiktok));

  console.log(
    `[findTagSuggestions] ${kept.length} accounts: ${kept
      .map((a) => `${a.name}(ig=${a.instagram?.status || "-"} tt=${a.tiktok?.status || "-"})`)
      .join(", ")}`
  );

  return {
    ownershipNote: ownershipNote.trim(),
    accounts: kept,
    checkedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// "Tweak this": Leah tells the app what's wrong with a generated post in
// plain words ("the hike is 2 miles, not 5", "less emoji", "don't say
// hidden gem") and gets back the same post with just that fixed.
//
// Deliberately NO web search here. Everything the original generation
// already researched (location-tag research, restaurant/menu research, the
// footage rundown) is handed back in from what the client kept, and Leah
// herself was there - her correction is treated as the source of truth, not
// something to re-check. So a tweak is one call with no searches (~$0.06
// measured) instead of repeating them.
//
// "Learning over time": the model also says whether the feedback reflects
// a lasting preference (a phrase she never wants, a formatting habit) as
// opposed to a one-off fact about this post. If it does, that rule is
// offered back to her in the UI to save to the Profile tab's rules list -
// which buildSystemPrompt() already injects into every future generation.
// Nothing is saved without her tapping it, so a misread one-off correction
// can't quietly become a permanent rule.
function buildRevisionTool(platform) {
  const isYouTube = platform === "youtube";
  return {
    name: "submit_revision",
    description: "Deliver the revised post. Call exactly once.",
    input_schema: {
      type: "object",
      properties: {
        ...(isYouTube
          ? {
              titles: {
                type: "array",
                items: { type: "string" },
                minItems: 3,
                maxItems: 3,
                description: "The 3 title options - unchanged unless the feedback affects them (e.g. a wrong fact that appears in a title must be fixed there too).",
              },
            }
          : {}),
        description: {
          type: "string",
          description: "The full revised caption/description, formatted with line breaks like the original. No hashtags in it (those are separate).",
        },
        hashtags: {
          type: "string",
          description: "Exactly 5 hashtags as ONE comma-separated string (e.g. \"#visitmaine, #acadia, ...\"). Return the current ones unchanged unless the feedback is about hashtags or makes one of them wrong.",
        },
        hashtag_rationale: {
          type: "string",
          description: "Only if you changed the hashtags: an updated 1-3 sentence rationale, neutral tone. Otherwise an empty string.",
        },
        cover_text: {
          type: "string",
          description: "The cover/thumbnail text - unchanged unless the feedback affects it. Under 8 words.",
        },
        change_summary: {
          type: "string",
          description: "One short sentence saying what you changed, e.g. \"Changed the trail length to 2 miles and removed the waterfall line.\"",
        },
        lesson: {
          type: "string",
          description: "If the feedback reveals a LASTING preference that should apply to all future posts (a banned word or phrase, a tone/format habit, a standing fact about her brand), write it as one short imperative rule, e.g. \"Never describe a place as a 'hidden gem'.\" If the feedback is only about this one post's facts or content (a wrong distance, a wrong dish name), or the rule is already covered by LEAH'S OWN RULES, return an empty string.",
        },
      },
      required: [
        ...(isYouTube ? ["titles"] : []),
        "description",
        "hashtags",
        "hashtag_rationale",
        "cover_text",
        "change_summary",
        "lesson",
      ],
    },
  };
}

// current: the platform's result object as the Content tab holds it
// (description, hashtags, cover_text, titles/title). priorFeedback: earlier
// tweaks already applied to it, so this one doesn't undo them. context: the
// original inputs plus whatever research the generation already did.
export async function refinePost({ platform, lengthSeconds, current, feedback, priorFeedback, context }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set. Add it to .env.local (see README.md).");
  }

  const resolvedPlatform = ["instagram", "youtube"].includes(platform) ? platform : "tiktok";
  const platformLabel = platformLabelFor(resolvedPlatform);
  const resolvedLength = lengthSeconds === 30 ? 30 : 60;
  // Same system prompt the original generation used (voice, platform rules,
  // her Profile rules), so a tweak stays in her voice and follows the same
  // rules the post was written under.
  const systemPrompt = await buildSystemPrompt(resolvedLength, resolvedPlatform);

  const ctx = context || {};
  const titles = Array.isArray(current?.titles) ? current.titles : current?.title ? [current.title] : [];
  const earlier = (priorFeedback || []).filter(Boolean);

  const userPrompt = `
Do not call submit_post. This is a REVISION of a ${platformLabel} post that's already been written - call submit_revision instead.

What the post is about:
Topic / idea: ${ctx.idea || "(not given)"}
Location: ${ctx.location || "(not given)"}
Story beat: ${ctx.storyBeat || "(none)"}
Notes: ${ctx.notes || "(none)"}
${ctx.footageContext ? `\nWhat the finished video actually shows:\n${ctx.footageContext}\n` : ""}${ctx.restaurantContext ? `\nRestaurant research already done for this post: ${ctx.restaurantContext}\n` : ""}${ctx.locationContext ? `\nLocation research already done for this post: ${ctx.locationContext}\n` : ""}
The current version:
${titles.length ? `Titles:\n${titles.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n` : ""}Description:
${current?.description || ""}

Hashtags: ${(current?.hashtags || []).join(", ")}
Cover text: ${current?.cover_text || ""}
${earlier.length ? `\nEarlier corrections Leah already made to this post (already applied above - keep them intact, don't undo them):\n${earlier.map((f) => `- ${f}`).join("\n")}\n` : ""}
Leah's feedback now:
"""${feedback}"""

How to revise:
- Change only what the feedback asks for (plus anything it makes wrong elsewhere, e.g. the same false detail repeated in a title or the cover text). Keep everything else word-for-word - this is an edit, not a rewrite.
- Leah was there. If she says something is untrue, it's untrue: remove or correct it everywhere it appears. If she supplies a fact, use it as given. Don't replace a removed claim with a new unverified one.
- If fixing something leaves a gap (e.g. the hook relied on the wrong fact), rebuild that part from what IS confirmed above, in her voice, following the same platform rules.
- Keep the caption's structure (hook, detail, practical info, CTA, 📍 line) unless she asks otherwise.
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
      max_tokens: 6000,
      system: cachedSystemBlock(systemPrompt),
      tools: [buildRevisionTool(resolvedPlatform)],
      messages: [{ role: "user", content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Claude API returned ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const blocks = data?.content || [];
  await logUsage(`refinePost(${resolvedPlatform})`, data, {
    durationMs: Date.now() - t0,
    rawText: summarizeApiBlocks(blocks),
  });
  const submitBlock = blocks.find((b) => b.type === "tool_use" && b.name === "submit_revision");

  if (!submitBlock || !submitBlock.input?.description) {
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    console.error("[refinePost] no usable submit_revision call:", JSON.stringify(blocks).slice(0, 1000));
    throw new Error(
      `Claude didn't return a revision (stop_reason: ${data?.stop_reason}).${text ? ` It said instead: ${text.slice(0, 300)}` : ""}`
    );
  }

  const input = submitBlock.input;
  // Anything besides the description that comes back malformed falls back
  // to the current value rather than failing the whole tweak.
  const hashtags = parseHashtags(input.hashtags || "");
  const revisedTitles = Array.isArray(input.titles) ? input.titles.filter((t) => typeof t === "string" && t.trim()) : [];

  return {
    description: input.description.trim(),
    hashtags: hashtags.length === 5 ? hashtags : current?.hashtags || [],
    hashtagRationale: hashtags.length === 5 && input.hashtag_rationale ? input.hashtag_rationale.trim() : null,
    coverText: typeof input.cover_text === "string" && input.cover_text.trim() ? input.cover_text.trim() : current?.cover_text || "",
    titles: resolvedPlatform === "youtube" && revisedTitles.length === 3 ? revisedTitles : null,
    changeSummary: String(input.change_summary || "").trim(),
    lesson: String(input.lesson || "").trim(),
  };
}
