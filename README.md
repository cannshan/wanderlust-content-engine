# Wanderlust Content Engine

A small dashboard for Wine Wilderness Wanderlust: enter an idea and location, get back a TikTok package and an Instagram package — description, hashtags, video length, filming notes, cover text — each genuinely tailored to that platform's own algorithm, not the same output with a swapped hashtag suffix.

The research and design plan behind this (algorithm rules, caption-formula breakdown, case studies from her real posts) lives in `wanderlust-content-engine.html` in this same folder — publish/open that separately, it's a static reference doc, not part of the app.

## What it does

1. You enter an idea, location, an optional story beat, a target video length (~30s or ~60s, same target on both platforms), and any free-text notes (a trending hashtag/sound you spotted, an idea, anything).
2. The app fires two independent requests in parallel — one for TikTok, one for Instagram. Each one has Claude (Sonnet) write a description and pick 5 hashtags following the formula pulled from 15 of Leah's real posts (see `lib/voiceProfile.js`), tailored to that specific platform's ranking signals (TikTok: completion rate + comments/saves; Instagram: DM shares first), and actively runs its own live web search for currently-trending hashtags/sounds on that topic before finalizing — folding in your free-text notes too when you give any — using only what genuinely fits.
3. You copy the description and tags into TikTok/Instagram yourself. Nothing posts automatically.

The tool decides on its own whether a topic reads better as flowing narrative or an itinerary-style bullet list, and only tags a business/venue handle if you mentioned one in your notes — neither needs its own form field.

## Nearby filming ideas

Once a result exists, a "Find nearby ideas" section appears below it. Pick a category (foodie, hiking, speakeasies/bars, museums, or "All categories") and it does two separate live searches for real places within roughly a 10-mile drive of the same location — worth filming the same day as the primary idea. Results split into two lists:

- **🔥 Already popular** — places with real evidence of existing social buzz or reputation.
- **💎 Hidden gems** — places that are new, under-the-radar, or rarely covered, with real evidence for that too.

Same integrity rule as the hashtags/location-tag/restaurant features: nothing gets labeled "proven" or "hidden gem" without genuine search evidence behind it, and an empty list is an honest result if a search turns up nothing that qualifies — never padded with filler. Distances are whatever a search result happens to state (a drive time, a "X miles from downtown" mention) — there's no maps/geocoding API in this app, so treat "10 miles" as an estimate to sanity-check, not a guarantee. This only runs when you click the button, not on every Generate — it costs several searches per click.

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
  menu_link text
);
```

If you set this table up before the restaurant checkbox existed, run this once instead to add the two new columns:

```sql
alter table saved_ideas add column if not exists restaurant_name text;
alter table saved_ideas add column if not exists menu_link text;
```

3. In **Project Settings → API**, copy the **Project URL** and the **`service_role`** key (not `anon` — this app only ever talks to Supabase from the server, same as the Anthropic key).
4. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to `.env.local` (and to Vercel's environment variables once deployed).

Without these two variables, generation still works exactly the same — the sidebar just stays empty and "Save this idea" silently does nothing.

One thing worth knowing: free Supabase projects pause after 7 days of inactivity. If nobody's used the tool in a week, saving/loading ideas will fail until someone reopens the project in the Supabase dashboard (one click to resume) — everything else in the app is unaffected.

A saved restaurant idea keeps the restaurant name and menu link (so reloading it re-checks the box with the same source) but never the uploaded menu photo/PDF itself — that's only ever used inline for the one request that reads it, never written anywhere.

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
- `lib/voiceProfile.js` — Leah's decoded caption formula, 15 real sample captions, and the per-platform algorithm/location-tag rules used to ground generated copy.
- `lib/trends.js` — the Apify integration, degrades gracefully if unconfigured.
- `lib/claude.js` — all the Anthropic API calls: the main per-platform generation, the hashtag step, and the optional voiceover/music/styling extras.
- `lib/supabase.js` + `app/api/ideas/` — the optional "Saved ideas" sidebar, degrades gracefully if unconfigured.
- `proxy.js` (Next.js 16's replacement for `middleware.js`) + `lib/auth.js` + `app/login/page.js` — simple shared-password gate for hosting this online.
