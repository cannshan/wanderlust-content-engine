# Wanderlust Content Engine

A small dashboard for Wine Wilderness Wanderlust: enter an idea and location, get back a TikTok package and an Instagram package — description, hashtags, video length, filming notes, cover text — each genuinely tailored to that platform's own algorithm, not the same output with a swapped hashtag suffix.

The research and design plan behind this (algorithm rules, caption-formula breakdown, case studies from her real posts) lives in `wanderlust-content-engine.html` in this same folder — publish/open that separately, it's a static reference doc, not part of the app.

## What it does

1. You enter an idea, location, an optional story beat, a target video length (~30s or ~60s, same target on both platforms), and any free-text notes (a trending hashtag/sound you spotted, an idea, anything).
2. The app fires two independent requests in parallel — one for TikTok, one for Instagram. Each one has Claude (Sonnet) write a description and pick 5 hashtags following the formula pulled from 14 of Leah's real posts (see `lib/voiceProfile.js`), tailored to that specific platform's ranking signals (TikTok: completion rate + comments/saves; Instagram: DM shares first), and actively runs its own live web search for currently-trending hashtags/sounds on that topic before finalizing — folding in your free-text notes too when you give any — using only what genuinely fits.
3. You copy the description and tags into TikTok/Instagram yourself. Nothing posts automatically.

The tool decides on its own whether a topic reads better as flowing narrative or an itinerary-style bullet list, and only tags a business/venue handle if you mentioned one in your notes — neither needs its own form field.

## Nearby filming ideas

Once a result exists, a "Find nearby ideas" section appears below it. Pick a category (foodie, restaurants, hiking, speakeasies/bars, museums, or "All categories") and it does two separate live searches for real places within roughly a 10-mile drive of the same location — worth filming the same day as the primary idea. Results split into two lists:

- **🔥 Already popular** — places with real evidence of existing social buzz or reputation.
- **💎 Hidden gems** — places that are new, under-the-radar, or rarely covered, with real evidence for that too.

Same integrity rule as the hashtags/location-tag/restaurant features: nothing gets labeled "proven" or "hidden gem" without genuine search evidence behind it, and an empty list is an honest result if a search turns up nothing that qualifies — never padded with filler. Distances are whatever a search result happens to state (a drive time, a "X miles from downtown" mention) — there's no maps/geocoding API in this app, so treat "10 miles" as an estimate to sanity-check, not a guarantee. This only runs when you click the button, not on every Generate — it costs several searches per click.

"All categories" gets a bigger search/output budget than a single category and is explicitly told to spread its searches across different types (food, outdoors, nightlife, culture) instead of defaulting to whichever it reaches for first — this used to come back noticeably thinner than picking one specific category (e.g. "foodie") did on its own; it should now be comparable.

## Discovery tab

A standalone tab, not tied to a primary idea already chosen. Type in any location — a town, a region, or a whole state (e.g. "Maine," or "Boothbay Harbor, Maine") — pick a category, and it runs three separate live searches for real things to do there:

- **🔥 Popular** — well-known draws with real evidence of tourism traffic or being a well-known must-visit.
- **✨ Interesting / unique** — a genuinely distinctive experience that isn't necessarily top-tourist-list material.
- **💎 Hidden gems** — new, under-the-radar, or rarely-covered places.

Same integrity rule as everywhere else: a place only gets listed with real search evidence behind both its category fit and which bucket it lands in, and an empty section is an honest result, not something to pad. If the location given is broad (a whole state, say), results are spread across different towns within it rather than clustering on one spot — each place lists its own area/neighborhood instead of a distance, since there's no single fixed point to measure "nearby" from the way the in-result nearby-ideas search has. This is what originally turned up things like Neat, a speakeasy in Boothbay Harbor, Maine.

Deliberately just a discovery/triage step now, not the place work happens: each result has one action, **Add to Planning**, which opens a small inline picker to file it under an existing Planning category or type a brand new one on the spot (or skip categorizing for now) - see the Planning tab below for what happens next. The old per-place Foodie/Explore Advice, Clothes to Wear, and Suggest Both buttons (plus the separate "Save" bookmark and its own sidebar lists) were removed from here - that depth of research and styling now lives on the Planning tab instead, once a place has actually been decided as worth planning around, rather than offered speculatively on every result. The sidebar is just **Saved searches** now, to reload a past result.

## Planning tab

The working set of places actually being planned around - everything sent here via Discovery's "Add to Planning," or found directly with the Planning tab's own search bar.

Same layout pattern as the Content tab's saved ideas: a sidebar list of compact cards, filterable by category, and clicking one loads its full detail (research, "What to Wear," the focus field) into the main panel - everything else just sits in the sidebar as a card until clicked. Discovery's "Saved searches" already worked this way (click loads the full result; other saved searches stay as cards), so this makes all three saved/planning lists in the app behave consistently.

**Search bar** - a direct, free-text lookup for one specific restaurant/hike/place (`searchForPlace` in `lib/claude.js`, `app/api/planning-search/`), separate from Discovery's broad category search across a whole location. If the query already points at one clear place (e.g. "Ports of Italy Boothbay Harbor"), it returns just that one, confirmed against real search evidence; if it's more general (e.g. "a good hiking trail near Camden Maine"), it returns up to 3 genuinely distinct real options rather than sorting into popular/interesting/hidden buckets - that three-way sort only makes sense when surveying everything in a location, not when the query already narrows it down. Each result gets the same **Add to Planning** picker as Discovery (`AddToPlanningPicker`, shared from `app/components/PlanningPicker.js`) - pick an existing category or type a new one. Items added this way carry `search_location: "Search: <the query>"` so it's clear where they came from.

This is where the real digging happens, once a place is worth spending research on.

**Categories** - a free-text organizational tag per item, same "create it by using it" model as every other category in this app (no separate categories table): pick or type one right in Discovery's Add to Planning picker, or add/change one later via the "Categorize" button on the item itself. The filter row above the list only shows up once a category actually exists.

**Research this place** - fires a deeper, one-time live-search dive specific to that one place (never automatically, only when clicked):

- **🍸 Wild food & drink ideas** - up to 4 genuinely standout, unusual real dishes/drinks worth building a video around (or the most surprising things to do/see there, if it's not a food/drink venue) - never a safe "popular menu item" default.
- **🤫 Secret tips** - up to 5 real insider tips a first-time visitor wouldn't know: timing, booking tricks, easy-to-miss details, cost hacks, honest warnings.
- **📍 Also worth going nearby** - up to 3 other real places genuinely worth visiting while already in the area.

An optional **"What are you looking for?"** free-text field sits right above the button - anything typed there (e.g. "weird desserts on the menu," "a hidden room," "the best time to avoid crowds") becomes its own dedicated required search alongside the three above, with the finding folded into whichever field it best fits rather than forcing a new category. Same integrity rule as everywhere else this app does live search: nothing invented, and an empty or short list (or an honest "nothing genuine turned up for that specific ask") is a valid result. Research is saved directly on the item's row (`research`/`researched_at` below), so it's there next time you open the tab - "Research again" just overwrites it with a fresh pass, using whatever's currently in the focus field.

**What to Wear** - moved here from Discovery, and changed in kind: instead of purchasable clothing links, this now searches specifically for real photos of real people actually wearing a fitting look for this place's vibe/season/occasion (a fashion blog, a real Instagram/Pinterest post, a street-style roundup) - a mood board, not a shopping list. A purchasable product page is fine too if that's genuinely the best real image a search turns up, but it's no longer the goal. Every image shown still goes through the same two-step verification as before it's displayed (`lib/ogImage.js` for a real preview image, then a Haiku vision check that it genuinely shows someone wearing a fitting look) - see "Per-place suggestions" further down for exactly how that pipeline works; it's unchanged, just repointed at outfit-inspiration photos instead of shoppable items.

Requires one more table (plus the `category` column if you already had `planning_items` from before this):

```sql
create table planning_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  place_category text,
  area text,
  why text,
  angle text,
  bucket text,
  search_location text not null,
  category text,
  research jsonb,
  researched_at timestamptz
);

-- if the table already existed without `category`:
-- alter table planning_items add column category text;
```

## Reel Voiceover tab

Upload a reel you've already filmed and get back a voiceover script written from what's actually in the footage — not a generic script for the idea, one that follows the real order of events on screen.

The video file itself is never uploaded anywhere. Entirely in your browser, it's sampled into a handful of still frames spread evenly across the clip (`lib/videoFrames.js`, via a hidden `<video>` + `<canvas>`), and only those small JPEGs — along with the video's real length — are sent to Claude. Claude reviews the frames in chronological order and calls a dedicated tool with two things:

- **What it saw** — a plain-language, beat-by-beat rundown of the footage, shown so you can sanity-check the voiceover actually matches what you filmed.
- **The voiceover script** — spoken language timed to the video's real length (~2.5 words/second is the rough pacing guide), following the actual sequence of what's shown. It only uses the optional idea/location/notes fields for names and facts it can't see on camera (a restaurant name, a booking link) — never to invent a scene that isn't actually in the footage.

Pick a platform (TikTok/Instagram/YouTube) to shape the tone/pacing the same way the rest of the app's voice profile does. This works best on genuine short-form footage (under a few minutes) — very long videos sample the same fixed number of frames, so each one covers proportionally less.

**Already filmed it? Same thing works right from the Content tab.** Turn on the "Voiceover script" extra there and an optional "upload the reel" field appears — if you give it a video, the voiceover script in the result (same script shown on every platform's tab, plus a "what Claude saw" summary above the tabs) is grounded in that actual footage instead of narrating the finished caption. Skip the upload and it falls back to the original caption-narrated voiceover exactly like before; the same silent-fallback also kicks in if the frame extraction or the video analysis itself fails for any reason.

### Raw clips - assemble a reel for me

The Reel Voiceover tab has a second mode for footage that hasn't been edited yet: upload several separate clips/takes (instead of one already-finished reel) and Claude acts as the editor - deciding which parts of which clips actually belong in the cut, in what order, then writing the voiceover for that assembled sequence. There's no on-screen editor or preview/adjust step - what comes back is the finished video, ready to download; if the cut isn't right, the move is to add/remove a clip and run it again, not to tweak the existing result.

The actual cutting and stitching happens entirely in the browser too, via [`ffmpeg.wasm`](https://ffmpegwasm.netlify.app/) (`lib/assembleReel.js`) - raw clips never get uploaded anywhere, same as everywhere else video touches this app. Each selected segment gets trimmed and re-encoded to a consistent 1080×1920 canvas (so takes with different resolutions/codecs still concatenate cleanly), then stream-copy-concatenated into the final file. This is real client-side video encoding with no hardware acceleration, so processing time depends heavily on the device and how much footage is involved - budget a few minutes for a full reel's worth on a normal laptop, possibly longer on an older device or phone.

This is deliberately a different, cheaper capability than AI-generating brand-new video: Claude has no video-generation model at all (nor does any part of the Anthropic API) - this only ever *edits footage that was actually filmed*, choosing what to keep and in what order, never inventing a shot that doesn't exist in the uploads.

## Profile tab

Two editable lists that feed into every Claude call that writes or searches for content - Content tab generation (TikTok/Instagram/YouTube), Reel Voiceover, and (see below) the Discovery tab's own searches:

- **Custom instructions** - free-text rules Leah types in herself: a phrasing habit to avoid ("no double hyphens (--) or em dashes - that reads as AI-written"), a fact the app should always get right, an example food/place it should know about, or anything else it should adhere to. No categories or tiers, just a flat list - meant to stay simple to add to, not another taxonomy to manage. Add, edit, or delete any of them at any time - editing is a real update to the existing row (PATCH), not a delete-and-recreate, so it keeps its place in the list rather than jumping to the end. Drag-and-drop reorderable via the ⠿ handle on each row - the saved `position` drives both the on-screen order and the order they're injected in, so a rule near the bottom (last-injected) can be dragged up to change which one effectively wins if two ever conflict. New ones default to `position: null` and sort after everything else (then by `created_at`) until reordered. These are injected last in whichever prompt is using them, framed as overriding the general guidance above them if the two ever conflict, since a rule Leah stated herself should win over general-purpose guidance.
- **Voice examples (sample captions)** - the 14 real captions that used to be hardcoded directly in `lib/voiceProfile.js` (`DEFAULT_SAMPLE_CAPTIONS`) now live here instead, editable and addable to. Each one carries platform, optional stats, a tier (`baseline` or `outlier`), an optional "why it outperformed" note (only meaningful for outliers), and the caption text itself - same fields `buildSystemPrompt()` always used, just editable now instead of requiring a code change to add a new one. Same drag-and-drop reordering as custom instructions above, same `position` column/semantics - `buildSystemPrompt()` includes every example regardless of order (split into its own outlier/baseline group, not truncated), so this is mainly about keeping the list itself organized rather than changing what reaches the model. This one only feeds `buildSystemPrompt()` (caption writing) - it wouldn't mean anything to a Discovery search that isn't writing a caption yet.

**Reach, corrected after launch:** custom instructions initially only reached `buildSystemPrompt()` in `lib/voiceProfile.js` - Content tab captions and Reel Voiceover. `findDiscoveryIdeas`, `findNearbyFilmingIdeas`, and `suggestForPlace` (the Discovery tab's search and per-place suggestion functions) build their prompts independently of `voiceProfile.js` entirely, so an instruction like "look for opportunities to go viral, especially animal content" or "look for trends around the current closest holiday" was only ever shaping how an already-chosen place got written up, never which places actually got surfaced in the first place - even though that's clearly what an instruction like that is for. All three now call `getCustomInstructions()` too (via a small shared `customInstructionsBlock()` helper in `lib/claude.js`) so a rule added once in the Profile tab reaches every part of the app that searches or writes, not just the caption step. Verified live: with those two instructions already in place, a real Discovery search for Ogunquit, Maine in late September surfaced "OgunquitFest / Dogtoberfest Costume Parade" - tagged `animal content` in its own category field - a direct, visible result of both rules actually shaping the search, not just decorating the output afterward.

**Reach, extended further:** `suggestStyling` (Content tab's "Styling tips" extra), `analyzeRestaurant` (the restaurant/menu check), `findLocationTagOptions` (the location-tag popularity search), and `searchForPlace` (Planning tab's own search bar) were the last four prompt-building functions in `lib/claude.js` that didn't call `getCustomInstructions()`. All four now do, via the same `customInstructionsBlock()` helper - every part of the app that calls Claude now sees the Profile tab's rules, not just generation/research/voiceover.

Both read through Supabase with the same degrade-gracefully rule as everywhere else in this app: if Supabase isn't configured, or the tables below don't exist yet, or a table is genuinely empty, generation doesn't break - custom instructions default to none, and sample captions fall back to the original hardcoded 15 rather than the prompt ever going out with zero voice examples to work from.

Requires two more tables:

```sql
create table profile_instructions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  text text not null,
  position int
);

create table profile_captions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  platform text not null,
  stats text,
  tier text not null default 'baseline',
  why text,
  caption text not null,
  position int
);
```

If you set either table up before reordering existed, run this once to add the new column to whichever one(s) you're missing it on:

```sql
alter table profile_instructions add column if not exists position int;
alter table profile_captions add column if not exists position int;
```

## Local setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

- **`ANTHROPIC_API_KEY`** — required. Get one at [console.anthropic.com](https://console.anthropic.com). Covers both the writing and the trend search below — no second account needed.
- **`DASHBOARD_PASSWORD`** — required once this is hosted online (anyone with the URL could otherwise use it and spend your Anthropic credits). Leave blank while testing locally.
- **`APIFY_API_TOKEN` / `APIFY_ACTOR_ID`** — optional, see below. Not required for trend lookups to work.

Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## How the "automated tag finding" actually works

TikTok doesn't offer a public API for trending-hashtag lookups — its official Research API is restricted to academic institutions, not creators or commercial tools. Its own Creative Center site (the free browser tool creators use) now puts a login wall in front of anything beyond a generic top-3 teaser too, as of testing this in September 2026 — so scraping it, directly or through a third party, hits the same wall.

The tool this app actually uses instead is **Claude's built-in web search** (`lib/claude.js`) — Claude runs a real search for current TikTok hashtag trends on the given topic before writing, billed at $0.01/search on the same `ANTHROPIC_API_KEY` you already have. No extra account, no login wall, effectively free at your posting volume. The result badge shows "Checked via live web search" when this ran.

`lib/trends.js` (Apify) is still in the codebase as an optional pre-fetch layer — if you ever do set up `APIFY_API_TOKEN`/`APIFY_ACTOR_ID`, its results take priority over the web search. It's not required and nothing breaks without it.

If neither finds anything useful for a given topic, the badge shows "AI-estimated tags" — still following the proven broad/niche/community formula, just not grounded in this week's live data.

## Saving ideas (optional)

The "Saved ideas" sidebar lets you generate a batch of posts ahead of time and come back to grab the finished copy later, without re-generating (and re-paying for) anything. It needs a small Supabase project — free tier is plenty (saved ideas are just text, a few KB each; the free 500MB database holds tens of thousands of them).

1. Create a project at [supabase.com](https://supabase.com).
2. In the project's **SQL Editor**, run:

```sql
create table saved_ideas (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  idea text not null,
  location text not null,
  story_beat text,
  notes text,
  length_seconds int not null,
  platforms text[] not null,
  results jsonb not null,
  restaurant_name text,
  menu_link text,
  menu_links text[],
  category text
);
```

If you set this table up before the restaurant checkbox existed, run this once instead to add the two new columns:

```sql
alter table saved_ideas add column if not exists restaurant_name text;
alter table saved_ideas add column if not exists menu_link text;
```

If you set it up before multiple menu links were supported, run this once too:

```sql
alter table saved_ideas add column if not exists menu_links text[];
```

If you set it up before categories existed (see "Categorizing saved ideas" below), run this once too:

```sql
alter table saved_ideas add column if not exists category text;
```

3. In **Project Settings → API**, copy the **Project URL** and the **`service_role`** key (not `anon` — this app only ever talks to Supabase from the server, same as the Anthropic key).
4. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `.env.local` (and to Vercel's environment variables once deployed).

Without these two variables, generation still works exactly the same — the sidebar just stays empty and "Save this idea" silently does nothing.

One thing worth knowing: free Supabase projects pause after 7 days of inactivity. If nobody's used the tool in a week, saving/loading ideas will fail until someone reopens the project in the Supabase dashboard (one click to resume) — everything else in the app is unaffected.

A saved restaurant idea keeps the restaurant name and menu link(s) (so reloading it re-checks the box with the same sources) but never the uploaded menu photo/PDF itself — that's only ever used inline for the one request that reads it, never written anywhere.

### Categorizing saved ideas

Each saved idea can be tagged with one free-text category (a season, a client, a trip, whatever grouping is useful) via the "Categorize" button on its card in the sidebar. There's no separate list of categories to manage — a category exists simply because at least one saved idea currently uses that name, the same way labels work in most tagging tools. Picking "Categorize" shows every category already in use as a quick pick, plus a field to type a new one; picking "Clear category" removes it from that idea without affecting the category name itself (it just stops showing up anywhere once nothing uses it anymore). A filter row above the saved-ideas list lets you narrow it down to just one category at a time.

### Saving searches from the Discovery tab

**Superseded, kept for history:** Discovery's sidebar used to have three saved lists (Saved items, Saved places, Saved searches). Saved items and Saved places are gone from the UI - every place now goes through Add to Planning instead (see the Planning tab section above), which carries a real category and is where the actual research/styling work happens, rather than a flat bookmark list. Only **Saved searches** remains: "Save this search" (next to the result heading) saves the *entire* result - every place across all three buckets for that location/category combination - as one entry, so it can be reopened later without re-running (and re-paying for) the search. Clicking a saved search in the sidebar loads the whole thing back into view.

The `saved_food_items` and `saved_places` tables/API routes (`app/api/food-items/`, `app/api/places/`) are left in the codebase rather than deleted - harmless, just unreachable from the UI now - in case old saved data is still sitting in them from before this change. `saved_searches` is the only one of the three still actively written to.

Discovery also has an optional "What are you looking for?" field alongside Location - a theme/occasion ("christmas things," "date night spots") that gets folded into every category's own search phrasing in `findDiscoveryIdeas` (`lib/claude.js`), rather than just tacked onto the location string. A category is only included in results at all if what it actually turned up genuinely connects to that focus - no padding a category with generic results just to fill it. Saved alongside the rest of the search as `focus`.

Requires one table:

```sql
create table saved_searches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  location text not null,
  categories text[] not null,
  results jsonb not null,
  category text,
  focus text
);
```

If you set this table up before the "What are you looking for?" field existed, run this once to add the new column:

```sql
alter table saved_searches add column if not exists focus text;
```

Without this table configured at all, the Discovery tab's search still works exactly the same — "Save this search" just silently does nothing, same degrade-gracefully rule as everywhere else Supabase is optional in this app.

<details>
<summary>If you have old data in <code>saved_food_items</code>/<code>saved_places</code> from before this change</summary>

Those tables and their API routes (`app/api/food-items/`, `app/api/places/`) are still in the codebase, just unreachable from the UI now:

```sql
create table saved_food_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  price text,
  source text,
  image_url text,
  place_name text,
  search_location text not null,
  category text
);

create table saved_places (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  place_category text,
  area text,
  why text,
  angle text,
  bucket text not null,
  search_location text not null,
  category text,
  food_suggestion jsonb,
  style_suggestion text,
  style_links jsonb
);
```

</details>

### Per-place suggestions (What to Wear)

**Moved from Discovery to Planning, and changed in kind - see "What to Wear" in the Planning tab section above.** This used to be one of three per-place buttons on every Discovery result (Foodie/Explore Advice and Suggest Both were the other two, both retired - that food-suggestion depth is now covered by Planning's "Research this place" instead, folded into `wild_food_and_drink` rather than a separate button). What's left, "What to Wear," now lives on the Planning tab, one per item, and searches for real outfit-inspiration photos rather than purchasable product links.

**What to Wear** — a styling suggestion tailored to that specific place's setting/season, same reasoning as the Content tab's styling tips but grounded in a live search for real photos of real people wearing a fitting look (not a generic store search page, and not primarily a shopping list - a purchasable product page is fine too if that's genuinely what a search turns up, but the goal is a mood board, not a cart). Every image shown has a confirmed real thumbnail image, and that image is verified to actually show a fitting outfit - there's no text-only/no-picture link, and no logo/banner/unrelated-photo masquerading as one, by design. Getting to that point is two separate checks, not one. First, the image itself: deliberately not left to Claude's own fetch tool - live testing found Claude could read the exact right page and still not surface a usable image URL from it. Instead, `lib/ogImage.js` fetches each candidate link's page directly (bypassing Claude entirely) and reads the page's own declared preview image (`og:image`, falling back to `twitter:image`) - the same technique link-preview generators like Slack and iMessage use. Second, once a link has a real image, a dedicated Claude vision call looks at it and keeps it only if it's genuinely a photo of the garment/accessory itself or someone wearing it - a page's `og:image` is whatever the site picked as its social-share preview, which isn't always the product shot (it can be a logo, a storefront photo, an unrelated lifestyle banner - caught live in testing: a Tuckernuck dress link whose `og:image` was actually the site's own stacked-logo PNG, correctly dropped), so having *an* image isn't the same as having the *right* image. This check runs once per candidate image rather than as one batched call for all of them, on purpose - an earlier version sent all 5 in a single request and found live that if even one candidate's image happened to be unfetchable by Claude's own vision fetch (broken link, hotlink protection), the API rejected the *entire* batch, which would have silently skipped verification for every candidate at once instead of just the broken one. The image check itself runs on Haiku 4.5, not Sonnet 5 - it's a narrow yes/no classification with no room for nuance, so the cheaper/faster model costs nothing in quality while keeping the cost of checking a large candidate pool (see below) low. Not every site cooperates with the first step (some retailers render their product image client-side in JavaScript rather than serving it in the page's own HTML; some block non-browser requests outright), so Claude is asked for up to 12 candidate links instead of the 3 actually shown - see below for why that number grew from an earlier, smaller one.

`findStyleLinks` in `lib/claude.js` works through that pool of up to 12 checking `STYLE_LINK_BATCH_SIZE` (3) at a time, stopping the moment it reaches 3 verified images rather than checking the whole pool every time - a lucky pool where the first 3 candidates all pan out costs 3 fetches and 3 classification calls, not 12. This replaced an earlier design where a round that came up short triggered a whole new Claude call to search again - live testing found that both more expensive (a full second Sonnet 5 call, a new $0.01 web_search fee, every retry) AND less reliable: asking a model to "find something different" without a fresh search in front of it turned out to be an easy way to end up guessing rather than searching - one retry call returned a candidate URL for H&M with product ID `1234567890`, an obvious placeholder pattern, not something a real search returns. Doing one thorough search up front and sifting through everything it returns sidesteps that failure mode, since every candidate genuinely came from a real search result. Still not a hard guarantee (a query whose realistic matches are mostly on blocked sites can still come back with fewer than 3, or in rare cases zero) - but it never pads the gap with a fake, placeholder, or off-topic image to hit the number, and going deeper into the pool never costs more than a free fetch plus one cheap Haiku call, no matter how far down it has to go.

**Model choice, tested live, not assumed:** a full pass was made trying every call in this file on Haiku 4.5 to see how much cheaper the whole feature set could get. Two real problems turned up, not hypothetical ones: the Discovery search (`findDiscoveryIdeas`) came back with noticeably fewer real places on Haiku, and once returned zero for a query Sonnet 5 handled fine; and the food/style suggestion text (`suggestForPlace`'s main call) twice leaked raw `<cite index="...">` markup into what would have been Leah-facing text, never once observed on Sonnet 5 across the rest of testing. So `MODEL` in `lib/claude.js` stays Sonnet 5 for every call that does real research or writing - Discovery search, the suggestion text itself, `analyzeRestaurant`, the style/food search. `HAIKU_MODEL` covers only the image classification check - a narrow yes/no with no real judgment in it, where testing has never shown a quality difference. (A retry-search step briefly ran on Haiku too, on the theory that "find more URLs matching an approved description" was mechanical enough - a Haiku round there once returned a candidate URL for H&M with product ID `1234567890`, an obvious placeholder pattern rather than something a real search returns, which is part of why that whole retry-via-new-call design was replaced below rather than just moved back to Sonnet 5.)

**What to Wear hit rate, tracked honestly across iterations:** an earlier 5-candidates-single-search version measured well at first but degraded badly over time - a 10-run live sample later got a verified image on only 2 of 10 clicks, never a full 3. Root cause, confirmed live: round-1 candidates were genuinely real URLs, but a disproportionate share of surfaced retailers were dead ends every time - jcrew.com serves the identical generic placeholder (`jc-default.jpg`) as its `og:image` on every product page (confirmed 3 separate times), and anthropologie.com/bhldn.com/stories.com block non-browser fetches outright (DataDome/Akamai, confirmed via direct curl testing). Two fixes landed together: `UNRELIABLE_STYLE_DOMAINS` in `lib/claude.js` names those 4 proven-dead domains directly in the search prompt so a candidate slot is never spent on one, and the search itself now explicitly asks for 2-3 *separate* search angles (a different retailer, a different cut, an outfit-inspo query) instead of one, feeding the larger 12-candidate pool above - going wide on the one real search mattered more than the domain blocklist alone. Live re-test after both fixes: 4 consecutive runs, each a full verified 3/3, on queries (including the exact places that had scored 0/3 before) that previously failed most of the time. Still not a mathematical guarantee - a genuinely narrow or heavily-gatekept style search could still come up short - but the measured hit rate now matches what the design originally targeted rather than falling well below it.

**Fetch cost:** `WEB_FETCH_TOOL` caps `max_content_tokens` at 8000 - measured live that an uncapped fetch of a real restaurant site can run 50,000+ input tokens, almost all of it nav/footer/script boilerplate rather than menu content, since a fetch pulls the whole page, not just the relevant section. This cap is shared across every `WEB_FETCH_TOOL` use in the app (`researchPlanningItem`'s menu-page fetch and `analyzeRestaurant`'s user-provided-menu-links path both use it) rather than a separate tunable number per feature - both are the same task shape (find one specific real fact on a fetched page), 8000 tokens is generous for even a long real menu, and a second number to keep in sync isn't worth it without evidence one feature actually needs a different value. The tool also sets `allowed_callers: ["direct"]`, needed because this tool version's smarter content-filtering mode requires "programmatic" tool calling, which Haiku 4.5 doesn't support (caught live when `HAIKU_MODEL` briefly touched this tool during testing) - forcing "direct" opts into the plain fetch-and-truncate behavior instead, which every model supports.

Verified the cap doesn't cost real accuracy: tested live against Barnacle Billy's actual menu page, an unusually large real-world site (655KB - the raw menu text doesn't even start until roughly 29,000 tokens deep by byte offset) - the fetch tool's own HTML-to-text extraction strips enough boilerplate before the cap applies that it still surfaced a real, specifically-priced dish (`Billy's Hot Lobster Sauté, $49.95`). A second real menu (Jonathan's) hit an unrelated, pre-existing limitation instead - its menu is loaded via a client-side JS widget the fetch tool can't see at all, capped or not - and the app handled that exactly as designed: it said plainly it couldn't access the item-level menu rather than inventing anything.

A "What to Wear" result isn't persisted anywhere - it's ephemeral React state on the Planning tab, same as it was ephemeral on Discovery before this change, so it clears on refresh and re-runs from scratch (a fresh live search) each time the button's clicked.

## Tracking what Claude API calls actually cost

Every real Claude API call in `lib/claude.js` runs through `logUsage()`, which computes the real dollar cost from what Anthropic's response actually billed (input/output/cache tokens at their published per-token rates, plus $0.01 per web search) - not an estimate from `max_tokens` ceilings. It also times the call itself (`Date.now()` right before the request, subtracted off after the response comes back), so slow-feature questions ("why did that search take two minutes") have a real number behind them instead of a guess. It always logs a `[cost] <feature> $0.0123 ... duration_ms=...` line to the console; when Supabase is configured, it also writes a row to `api_cost_logs` so both can be reviewed later instead of scrolled past in server logs.

`findDiscoveryIdeas` and `findNearbyFilmingIdeas` also pass their full raw model output into `raw_response` on that same row - those are the two calls whose place NAMEs go straight from the model's own text to the screen with no verification step (unlike the style/food image links, which get fetched and checked before ever being shown), so a wrong-but-well-formed name (parses fine, just isn't the real place) has no other trail to debug from otherwise.

Requires one table:

```sql
create table api_cost_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  feature text not null,
  model text not null,
  cost_usd numeric not null,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  searches int not null default 0,
  duration_ms int,
  raw_response text
);
```

If you set this table up before timing was tracked, run this once to add that column:

```sql
alter table api_cost_logs add column if not exists duration_ms int;
```

If you set this table up before raw responses were logged, run this once to add that column:

```sql
alter table api_cost_logs add column if not exists raw_response text;
```

Without this table, cost/timing tracking just falls back to the console-only `[cost]` lines - same degrade-gracefully rule as everywhere else Supabase is optional in this app.

`GET /api/cost-logs` (optionally `?limit=`, default 500, max 2000; `?since=<ISO timestamp>` to filter to rows at or after that time) returns the raw rows plus a `byFeature` summary (call count, total cost, average cost per call, average duration) sorted by total spend - open it directly in a browser, or point any tool at it, to see what's actually being spent (and how long it's taking) without querying Supabase directly. Rows leave out `raw_response` by default (see the comment in `app/api/cost-logs/route.js`) - add `?includeRaw=1` to get it back, e.g. when tracking down a specific bad Discovery/Nearby result.

A small "This week: $X.XX" badge in the top bar (`app/components/WeeklySpend.js`) shows a running total since the most recent Monday, refreshed every 60 seconds - reads the same `/api/cost-logs?since=` endpoint, and renders nothing at all if the table isn't configured yet rather than showing an error.

The badge is gated on hostname, not a manual flag - there's one shared `DASHBOARD_PASSWORD` for this app, no separate owner login, and this isn't something the person actually using the deployed app should ever see. It shows automatically on `localhost`/`127.0.0.1` (any port - local dev only) and stays hidden on every deployed hostname, unconditionally, for anyone visiting it on any device.

**Prompt caching on Discovery/Nearby Ideas:** both split their prompt into a location/category-independent instruction block (bucket definitions, evidence rules, output format, a worked example - identical every time) sent as a cached `system` block, and a small per-request block (location, focus, category list, custom instructions) that's never cached. `tools[].max_uses` is deliberately fixed at the "all categories" ceiling on every call, even a 1-category search - that costs nothing extra (`max_uses` is a cap, not a target; the prompt's own "one search per category" instruction is what actually limits search count), but it keeps `tools` byte-identical across every category combination, which is required for the cached instructions to match - Anthropic's cache is a prefix match, and `tools` renders before `system`. Stays on Anthropic's plain 5-minute cache TTL - a 1-hour TTL (2x write cost instead of 1.25x) was tried and reverted after live testing: a real 3-call sequence cost $0.50 on the 1-hour TTL versus a computed $0.31 had those same calls run on the 5-minute default, even though the 5-minute version would have missed the one call that landed 8 minutes out - the 2x tax applies to every write whether or not a read ever comes back for it, and that outweighed the one caught miss. Real historical calls also showed cache hits surviving 14-17 minutes under the plain 5-minute default already, well past its documented minimum, undercutting the case for paying more for a longer guaranteed window.

## Deploying so it works on her phone

The easiest path is [Vercel](https://vercel.com) (built by the makers of Next.js, generous free tier, HTTPS by default):

1. Push this folder to a GitHub repo (private is fine).
2. Go to vercel.com → New Project → import that repo.
3. In the project's Settings → Environment Variables, add the same variables from `.env.local` (**make sure to set `DASHBOARD_PASSWORD`** — without it the site is open to anyone with the link).
4. Deploy. Vercel gives you a `https://your-project.vercel.app` URL that works on any phone browser.

## Files

- `app/page.js` — the top-level shell, renders `ContentTab`.
- `app/components/ContentTab.js` — the content form + result UI.
- `app/api/generate/route.js` — ties the trend lookup and Claude call together, per platform.
- `app/api/restaurant-check/`, `app/api/location-search/`, `app/api/styling/` — the pre-fetch endpoints (restaurant menu + research, location-tag popularity, wardrobe tips) that run once per "Generate" click and get passed into every platform's request, instead of each platform repeating the same live read/search. The restaurant one only fires when the "Restaurant / bar" checkbox is on and a name is given - it reads the menu you provide directly (a link and/or an uploaded photo/PDF), it no longer guesses at whether a post is about a restaurant.
- `app/api/nearby-ideas/` — on-demand only (a button, not part of "Generate"), finds other real places worth filming near the same location - see "Nearby filming ideas" above.
- `app/components/DiscoveryTab.js` + `app/api/discovery/` — the standalone Discovery tab - see "Discovery tab" above.
- `app/api/discovery-searches/` — Discovery's "Save this search" list - see "Saving searches from the Discovery tab" above. `app/api/places/` + `app/api/food-items/` are old, now-unreachable-from-the-UI siblings, kept only for any data already in them.
- `app/components/PlanningTab.js` + `app/api/planning-items/` — the Planning tab: categories, "Research this place" (`lib/claude.js`'s `researchPlanningItem`), and "What to Wear" - see "Planning tab" above.
- `app/api/planning-search/` + `lib/claude.js`'s `searchForPlace` — the Planning tab's own free-text search bar. `app/components/PlanningPicker.js` — the shared "Add to Planning" category picker, used by both Discovery and this search bar.
- `app/api/place-suggestion/` + `lib/ogImage.js` — the "What to Wear" button (now on the Planning tab, not Discovery), and the direct page-fetch that gets a real thumbnail image for a style link - see "Per-place suggestions" above.
- `app/components/ReelVoiceoverTab.js` + `app/api/reel-voiceover/` + `lib/videoFrames.js` — the Reel Voiceover tab's "already edited" mode - see "Reel Voiceover tab" above.
- `app/api/reel-edit-plan/` + `lib/assembleReel.js` — the "raw clips - assemble for me" mode - see "Raw clips" above.
- `lib/useCategorizedItems.js` + `app/components/CategoryUI.js` — the shared categorize/filter behavior behind saved ideas, saved searches, and Planning items.
- `lib/constants.js` — shared platform/category constants used across all three tabs.
- `lib/voiceProfile.js` — Leah's decoded caption formula, 14 real sample captions, and the per-platform algorithm/location-tag rules used to ground generated copy.
- `lib/trends.js` — the Apify integration, degrades gracefully if unconfigured.
- `lib/claude.js` — all the Anthropic API calls: the main per-platform generation, the hashtag step, the nearby-ideas/Discovery searches, the reel-voiceover/reel-edit-plan analysis, and the optional voiceover/music/styling extras.
- `lib/supabase.js` + `app/api/ideas/` — the optional "Saved ideas" sidebar, degrades gracefully if unconfigured.
- `proxy.js` (Next.js 16's replacement for `middleware.js`) + `lib/auth.js` + `app/login/page.js` — simple shared-password gate for hosting this online.
