# Wanderlust Content Engine

A small dashboard for Wine Wilderness Wanderlust: enter an idea and location, get back a TikTok package and an Instagram package — description, hashtags, video length, filming notes, cover text — each genuinely tailored to that platform's own algorithm, not the same output with a swapped hashtag suffix.

The research and design plan behind this (algorithm rules, caption-formula breakdown, case studies from her real posts) lives in `wanderlust-content-engine.html` in this same folder — publish/open that separately, it's a static reference doc, not part of the app.

## What it does

1. You enter an idea, location, an optional story beat, a target video length (~30s or ~60s, same target on both platforms), and any free-text notes (a trending hashtag/sound you spotted, an idea, anything).
2. The app fires two independent requests in parallel — one for TikTok, one for Instagram. Each one has Claude (Sonnet) write a description and pick 5 hashtags following the formula pulled from 15 of Leah's real posts (see `lib/voiceProfile.js`), tailored to that specific platform's ranking signals (TikTok: completion rate + comments/saves; Instagram: DM shares first), and actively runs its own live web search for currently-trending hashtags/sounds on that topic before finalizing — folding in your free-text notes too when you give any — using only what genuinely fits.
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

### Saving places and searches from the Discovery tab

The Discovery tab has its own two saved lists in its sidebar, both with the same categorize/filter behavior described above:

- **Saved places** — a "Save" button next to every individual place in a Discovery result (Popular/Interesting/Hidden) saves just that one spot - the place already saved from a given search shows "Saved" instead, so hitting it twice doesn't create a duplicate. This is for building a running life-list of specific places worth visiting/filming, browsable and taggable one at a time, across searches.
- **Saved searches** — "Save this search" (next to the result heading) saves the *entire* result - every place across all three buckets for that location/category combination - as one entry, so it can be reopened later without re-running (and re-paying for) the search. Clicking a saved search in the sidebar loads the whole thing back into view.

Requires two more tables (same migration pattern as `saved_ideas` above):

```sql
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
  food_suggestion text,
  style_suggestion text,
  style_links jsonb
);

create table saved_searches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  location text not null,
  categories text[] not null,
  results jsonb not null,
  category text
);
```

Without these, the Discovery tab's search still works exactly the same — the two saved lists just stay empty and their Save buttons silently do nothing, same degrade-gracefully rule as everywhere else Supabase is optional in this app.

If you set `saved_places` up before per-place suggestions existed (see below), run this once too:

```sql
alter table saved_places add column if not exists food_suggestion text;
alter table saved_places add column if not exists style_suggestion text;
alter table saved_places add column if not exists style_links jsonb;
```

### Per-place suggestions (Clothes to Wear / Foodie-Explore Advice)

Every place in a Discovery result gets three small buttons, all ad-hoc (nothing runs until clicked, so a 21-place result doesn't cost 21x):

- **Foodie/Explore Advice** — for a food/drink venue, searches for its current menu and recommends one specific real dish (and a cocktail, if it has a program), always stating plainly how current the source is: from what looks like their real current menu, flagged if the menu looks a year or more old, or explicit that no actual menu was found and the pick is based on reviews/social mentions instead. For a non-food place, recommends one specific real thing to do/see there instead.
- **Clothes to Wear** — a styling suggestion tailored to that specific place's setting/season, same reasoning as the Content tab's styling tips but grounded in a live search for real, specific clothing/accessory links (not a generic store search page - a real product's own URL) and/or real outfit-inspiration photos. Every link shown has a confirmed real thumbnail image, and that image is verified to actually be a picture of the clothing - there's no text-only/no-picture link, and no logo/banner/unrelated-photo masquerading as one, by design. Getting to that point is two separate checks, not one. First, the image itself: deliberately not left to Claude's own fetch tool - live testing found Claude could read the exact right product page and still not surface a usable image URL from it. Instead, `lib/ogImage.js` fetches each candidate link's page directly (bypassing Claude entirely) and reads the page's own declared preview image (`og:image`, falling back to `twitter:image`) - the same technique link-preview generators like Slack and iMessage use. Second, once a link has a real image, a dedicated Claude vision call looks at it and keeps it only if it's genuinely a photo of the garment/accessory itself or someone wearing it - a page's `og:image` is whatever the site picked as its social-share preview, which isn't always the product shot (it can be a logo, a storefront photo, an unrelated lifestyle banner - caught live in testing: a Tuckernuck dress link whose `og:image` was actually the site's own stacked-logo PNG, correctly dropped), so having *an* image isn't the same as having the *right* image. This check runs once per candidate image rather than as one batched call for all of them, on purpose - an earlier version sent all 5 in a single request and found live that if even one candidate's image happened to be unfetchable by Claude's own vision fetch (broken link, hotlink protection), the API rejected the *entire* batch, which would have silently skipped verification for every candidate at once instead of just the broken one. The image check itself runs on Haiku 4.5, not Sonnet 5 - it's a narrow yes/no classification with no room for nuance, so the cheaper/faster model costs nothing in quality while keeping the cost of checking up to 5 candidates (and any retries, below) low. Not every site cooperates with the first step (some retailers render their product image client-side in JavaScript rather than serving it in the page's own HTML; some block non-browser requests outright), so Claude is asked for up to 5 candidate links instead of the 3 actually shown.

If that first round doesn't clear both checks for a full 3, the app doesn't settle for whatever came back - `findStyleLinks` in `lib/claude.js` searches again for more candidates (reusing the styling suggestion text already written, not re-generating it), up to 2 retry rounds, stopping as soon as it reaches 3 verified images or a retry round comes back with nothing new to try. This is a real cost/latency tradeoff, not a free retry - each round is another search call plus more image checks - so the retry budget is capped low on purpose rather than searching indefinitely. Even with retries this is still meaningfully better odds of a full set of 3 real, on-topic photos, not a hard guarantee (a place whose realistic style matches are mostly on blocked/client-rendered sites can still come back with fewer than 3, or in rare cases zero, after using up the retry budget) - but it never pads the gap with a fake, placeholder, or off-topic image to hit the number.
- **Suggest Both** — one combined request for both of the above, cheaper than clicking each separately since it shares one search budget and one generation pass instead of two.

Whichever of these had already been generated for a place at the moment it gets saved rides along into `saved_places` (the three columns above) - nothing is fetched retroactively for places saved before this existed.

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
- `app/api/places/` + `app/api/discovery-searches/` — the Discovery tab's two saved lists - see "Saving places and searches from the Discovery tab" above.
- `app/api/place-suggestion/` + `lib/ogImage.js` — the per-place Clothes to Wear / Foodie-Explore Advice / Suggest Both buttons, and the direct page-fetch that gets a real thumbnail image for a style link - see "Per-place suggestions" above.
- `app/components/ReelVoiceoverTab.js` + `app/api/reel-voiceover/` + `lib/videoFrames.js` — the Reel Voiceover tab's "already edited" mode - see "Reel Voiceover tab" above.
- `app/api/reel-edit-plan/` + `lib/assembleReel.js` — the "raw clips - assemble for me" mode - see "Raw clips" above.
- `lib/useCategorizedItems.js` + `app/components/CategoryUI.js` — the shared categorize/filter behavior behind all three saved lists (saved ideas, saved places, saved searches).
- `lib/constants.js` — shared platform/category constants used across all three tabs.
- `lib/voiceProfile.js` — Leah's decoded caption formula, 15 real sample captions, and the per-platform algorithm/location-tag rules used to ground generated copy.
- `lib/trends.js` — the Apify integration, degrades gracefully if unconfigured.
- `lib/claude.js` — all the Anthropic API calls: the main per-platform generation, the hashtag step, the nearby-ideas/Discovery searches, the reel-voiceover/reel-edit-plan analysis, and the optional voiceover/music/styling extras.
- `lib/supabase.js` + `app/api/ideas/` — the optional "Saved ideas" sidebar, degrades gracefully if unconfigured.
- `proxy.js` (Next.js 16's replacement for `middleware.js`) + `lib/auth.js` + `app/login/page.js` — simple shared-password gate for hosting this online.
