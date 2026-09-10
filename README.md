# Wanderlust Content Engine

A small dashboard for Wine Wilderness Wanderlust: enter an idea and location, get back a description and hashtag set written in Leah's own voice, checked against currently trending TikTok tags when available.

The research and design plan behind this (algorithm rules, caption-formula breakdown, case studies from her real posts) lives in `wanderlust-content-engine.html` in this same folder — publish/open that separately, it's a static reference doc, not part of the app.

## What it does

1. You enter an idea, location, and (optionally) a story beat, a business to tag, and a format.
2. Claude (Sonnet) writes a description and picks 5 hashtags, following the exact formula pulled from 15 of Leah's real posts (see `lib/voiceProfile.js`) — and actively runs one live web search for currently-trending TikTok hashtags on that topic before finalizing, using only what genuinely fits.
3. You copy the description and tags into TikTok/Instagram yourself. Nothing posts automatically.

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

## Deploying so it works on her phone

The easiest path is [Vercel](https://vercel.com) (built by the makers of Next.js, generous free tier, HTTPS by default):

1. Push this folder to a GitHub repo (private is fine).
2. Go to vercel.com → New Project → import that repo.
3. In the project's Settings → Environment Variables, add the same variables from `.env.local` (**make sure to set `DASHBOARD_PASSWORD`** — without it the site is open to anyone with the link).
4. Deploy. Vercel gives you a `https://your-project.vercel.app` URL that works on any phone browser.

## Files

- `app/page.js` — the dashboard form + result UI.
- `app/api/generate/route.js` — ties the trend lookup and Claude call together.
- `lib/voiceProfile.js` — Leah's decoded caption formula and 15 real sample captions used to ground generated copy.
- `lib/trends.js` — the Apify integration, degrades gracefully if unconfigured.
- `lib/claude.js` — the Anthropic API call.
- `middleware.js` + `lib/auth.js` + `app/login/page.js` — simple shared-password gate for hosting this online.
