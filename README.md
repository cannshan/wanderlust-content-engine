# Wanderlust Content Engine

A small dashboard for Wine Wilderness Wanderlust: enter an idea and location, get back a description and hashtag set written in Leah's own voice, checked against currently trending TikTok tags when available.

The research and design plan behind this (algorithm rules, caption-formula breakdown, case studies from her real posts) lives in `wanderlust-content-engine.html` in this same folder — publish/open that separately, it's a static reference doc, not part of the app.

## What it does

1. You enter an idea, location, and (optionally) a story beat, a business to tag, and a format.
2. The server looks up currently trending hashtags related to the topic via Apify (if configured) — this is the "automated tag finding" piece, since TikTok itself has no public API for this.
3. Claude (Sonnet) writes a description and picks 5 hashtags, following the exact formula pulled from 15 of Leah's real posts (see `lib/voiceProfile.js`), preferring live trending tags when they genuinely fit.
4. You copy the description and tags into TikTok/Instagram yourself. Nothing posts automatically.

## Local setup

```bash
npm install
cp .env.example .env.local
```

Fill in `.env.local`:

- **`ANTHROPIC_API_KEY`** — required. Get one at [console.anthropic.com](https://console.anthropic.com). Costs a few cents per generation.
- **`DASHBOARD_PASSWORD`** — required once this is hosted online (anyone with the URL could otherwise use it and spend your Anthropic credits). Leave blank while testing locally.
- **`APIFY_API_TOKEN` / `APIFY_ACTOR_ID`** — optional. Without these, tag generation still works, just from Claude's knowledge of proven patterns instead of this week's live trends. See the comments in `.env.example` for how to pick an actor.

Then:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## About the Apify trend lookup

TikTok doesn't offer a public API for trending-hashtag lookups — its official Research API is restricted to academic institutions, not creators or commercial tools. The realistic "automated" option is a third-party service like [Apify](https://apify.com) that turns TikTok's own public Creative Center trend pages into structured data you can query by keyword. It's pay-per-use (Apify's free tier includes monthly credits, and a single hashtag lookup typically costs a small fraction of a dollar) — check the specific actor's pricing page before relying on it heavily.

This is a step below TikTok's own official tooling in reliability (actor schemas can change, runs can occasionally fail), which is why the app is built to degrade gracefully: if Apify isn't configured or a lookup fails, you still get a hashtag set — just estimated from proven patterns rather than pulled from this week's live data. The dashboard tells you which one you got (the "Live trend data" / "AI-estimated tags" badge on the result).

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
