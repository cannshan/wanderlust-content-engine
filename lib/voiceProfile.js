import { getSupabase } from "./supabase";

// Real captions pulled from @winewildernesswanderlust on Instagram and TikTok
// (public og:description metadata, Sept 2026). Used to ground generated copy
// in Leah's actual voice instead of generic travel-creator language.
//
// Each sample is tagged "outlier" or "baseline" against her own posting
// history (baseline is roughly 250-400 IG likes / 300-900 TikTok views).
// This matters: all 14 captions are equally "her voice," but only the
// outliers are evidence of what actually made something perform well above
// her norm. buildSystemPrompt() below uses that split deliberately - voice
// fidelity comes from the full set, virality mechanics come from the
// outliers specifically - so the tool is optimizing for both, not just
// sounding like her.
//
// This is now the FALLBACK, not the live source - the Profile tab moved
// these 14 into an editable `profile_captions` table so Leah can add her
// own over time without a code change. getSampleCaptions() below reads
// from there and only falls back to this hardcoded list if Supabase isn't
// configured yet or the table is empty - same degrade-gracefully rule as
// every other Supabase-optional feature in this app, so generation never
// breaks just because the Profile tab hasn't been set up.
const DEFAULT_SAMPLE_CAPTIONS = [
  {
    platform: "Instagram",
    stats: "31K likes, 501 comments",
    tier: "outlier",
    why: "Animal content + a specific number (10 corgis) and superlative claim in line one + a story that builds to a surprise payoff (puppies) at the very end.",
    caption:
      "I just spent the day hiking with 10 corgis and this might be one of the best activities I have ever done in Maine. 🐾\n\nCorgi Bliss is located in Ellsworth, just a 25 minute drive from downtown Bar Harbor, making it the perfect addition to any Acadia National Park itinerary.\n\nThe adventure starts when you meet your host Jennifer who teaches you all about the breed before the corgis lead you into the forest.\n\nAnd this is not your average hike either because there are fairy houses hidden along the trail, each one filled with little treasures. 🧚\n\nHalfway through you stop for photos completely surrounded by corgis and yes there is definitely stopping for pets and kisses the entire time.\n\nBut the biggest surprise came at the end. We got to meet and cuddle all of the corgi puppies. As a dog lover this absolutely stole my heart. 🐶\n\nYou can book this experience through Airbnb Experiences! DM for the link since it won't let me post it on here!\n\n📍 Corgi Bliss, Ellsworth, Maine\n\n@corgibliss\n\n#visitmaine #acadianationalpark #barharbor #mainetravel #corgisofinstagram",
  },
  {
    platform: "TikTok",
    stats: "59.2K views",
    tier: "outlier",
    why: "Animal content again (confirms it's a repeatable lever, not a one-off) + a curiosity-gap hook ('did you know') that's answered immediately, not teased.",
    caption:
      "Did you know there is a beach in Maine that has lifeguard dogs? 🐾 At Scarborough Beach State Park, specially trained Newfoundlands work alongside human lifeguards, helping patrol the beach and assist with water rescues. During our last visit, we got to meet Beacon, the first dog in the country to serve as a lifeguard at a public beach. 🌊 The beach is beautiful, but I am not going to lie. I definitely keep coming back to see the dogs. 📍 Scarborough Beach State Park, Maine #VisitMaine #scarboroughbeach #NewEngland #newfoundlanddog #dogsoftiktok",
  },
  {
    platform: "TikTok",
    stats: "39.7K views (pinned)",
    tier: "outlier",
    why: "Ties a real place to a trending, widely-watched show ('The Summer I Turned Pretty') in the first two sentences - borrowed cultural relevance, not just destination facts.",
    caption:
      "The summer I finally visited Goose Rocks Beach. And now I understand why everyone loves it. 🌊 Three miles of white sand in Kennebunkport, Maine and honestly it felt like I was transported straight into The Summer I Turned Pretty. ☀️ If you are looking for a beautiful beach day in Maine this is the one. 📍 Goose Rocks Beach, Kennebunkport, Maine #VisitMaine #KennebunkportMaine #MaineBeaches #NewEngland #MaineCoast",
  },
  {
    platform: "Instagram",
    stats: "3,908 likes, 124 comments",
    tier: "outlier",
    why: "An experience that sounds hard to access (priority booking most people don't know about) paired with a concrete insider tip (jellyfish warning) - makes the reader feel let in on something.",
    caption:
      "One of the highlights of our Lofoten trip was an unexpected sauna and cold plunge at Reinefjorden Sjøhus. 🇳🇴\n\nWe were staying at Eliassen Rorbuer nearby and reached out that day to see if they had any availability since guests staying at Reinefjorden Sjøhus get priority booking for the sauna. We got lucky and snagged a spot!\n\nThe views from the sauna were absolutely stunning, but our favorite part was cold plunging into the Arctic water during the midnight sun. 🌊\n\nOne thing to know — there are lion's mane jellyfish in the water, and we did see some floating by, so just be aware before you jump in! They are beautiful, but you will want to keep an eye out. 🪰\n\nIf you are visiting Lofoten this is such a unique experience and worth reaching out for availability even if you are not staying there.\n\n📍 Reinefjorden Sjøhus, Lofoten Islands, Norway\n\n@reinefjordsjohus\n\n#visitnorway #lofotenislands #norwaytravel #midnightsun #europetravel",
  },
  {
    platform: "Instagram",
    stats: "325 likes, 93 comments",
    tier: "baseline",
    caption:
      "Just stayed at one of the most relaxing winter spas in Quebec, and I’m still thinking about it.\n\nAfter hiking Mont Mégantic in the snow, we checked into @estello_suites_spa and were greeted with champagne waiting in our suite.\n\nThe Luxury Suite felt more like a full apartment, with a living room, kitchen, and views over Lac Mégantic that made it hard to leave the balcony.\n\nThe real magic, though, was the outdoor spa in winter. Stepping into a hot tub while snow covered the ground around us and the lake sat frozen in the distance was one of my favorite moments of the trip.\n\nIf you’re planning a winter trip to the Lac-Mégantic area, this is one to bookmark.\n\n#quebectravel #winterspa #lacmegantic #canadatravel #hotspringresort",
  },
  {
    platform: "Instagram",
    stats: "318 likes, 80 comments",
    tier: "baseline",
    caption:
      "If you’re visiting Martha’s Vineyard, you have to see the gingerbread houses in Oak Bluffs. 🏡💜\n\nWe visited this past weekend, and walking through the colorful cottages honestly felt like stepping into a little storybook.\n\nThe area dates back to 1835, and over time, the original summer tents were replaced with these whimsical Victorian cottages known for their bright colors and intricate gingerbread-style details.\n\n📍Oak Bluffs, Martha’s Vineyard\n\nWould you want to stay in one of these cottages? 🩷\n\n#marthasvineyard #oakbluffs #newenglandtravel #massachusettstravel #newenglandlife",
  },
  {
    platform: "Instagram + TikTok",
    stats: "298 likes / cross-posted",
    tier: "baseline",
    caption:
      "Have you seen Mont Tremblant in the fall? Because it is absolutely breathtaking! 🍂\n\nWe went last fall, and here’s everything we did during our fall trip to Mont Tremblant, Quebec:\n\n🥾 Hike the Devil's Falls Trail (La Chute du Diable) for stunning fall foliage views\n🏘️ Explore the colorful pedestrian village downtown\n🚡 Take the gondola up the mountain for the most incredible views\n🍫 Stop at Chocolato for dark chocolate-dipped ice cream\n☕ Warm up with a hot chocolate after taking it all in\n\nOne of the best fall foliage destinations in Canada and just a short drive from Montreal. Save this for your fall travel plans! 🍁\n\n📍 Mont Tremblant, Quebec, Canada\n\n#monttremblant #fallfoliage #quebectravel #canadatravel #newenglandtravel",
  },
  {
    platform: "Instagram",
    stats: "250 likes, 43 comments",
    tier: "baseline",
    caption:
      "Next up in my Oslo series is the city's best brown cheese waffle. 🧇\n\nAnd I found it at Haralds Vaffel. The brown cheese waffle is served with jam, and the way to eat it is folded over. Simple, warm, and absolutely delicious.\n\nIt was so good I would eat this every single day if we had it in the US.\n\nAnd of course I had to try the brown cheese ice cream too because when in Norway you have to fully commit. 🇳🇴\n\n10/10 recommend, and a must-add to your Oslo foodie list!\n\n📍 Haralds Vaffel, Oslo, Norway\n\n@haraldsvaffel\n\n#visitoslo #norwayfoodie #oslofood #norwaytravel #europetravel",
  },
  {
    platform: "Instagram",
    stats: "297 likes, 64 comments",
    tier: "baseline",
    caption:
      "This medieval fortress sits right in the heart of Oslo 🇳🇴\n\nI visited Akershus Fortress while exploring the city, and it was such an interesting way to experience a little of Oslo’s history.\n\nDating back more than 700 years, it has served as a royal residence, military stronghold and even played a role during World War II.\n\nToday, you can wander the historic grounds and take in beautiful views over the Oslofjord.\n\nDefinitely worth adding to your Oslo itinerary!\n\n📍 Akershus Fortress, Oslo, Norway\n\n#visitnorway #visitoslo #oslo #norwaytravel #europetravel",
  },
  {
    platform: "Instagram",
    stats: "296 likes, 68 comments",
    tier: "baseline",
    caption:
      "Have you tried this coastal Portuguese restaurant in Portland, Maine? 🍷🇵🇹\n\nDouro brings the flavors of Portugal together with fresh ingredients from the Maine coast, and we loved this combination.\n\nThe space is warm and intimate, the food was delicious, and it felt completely different from other restaurants we’ve tried in Portland.\n\nDefinitely one to add to your Portland foodie list!\n\n📍 Douro | Portland, Maine\n@douroportland\n\n#mainefoodie #newenglandfoodie #visitmaine #portlandmaine #mainetravel",
  },
  {
    platform: "Instagram",
    stats: "259 likes, 65 comments",
    tier: "baseline",
    caption:
      "Welcome back to my Maine Lobster Roll Series. This is stop number 9! 🦞\n\nThis time we are heading to Old Orchard Beach to try one of my favorite summer lobster rolls at Lone Pine Brewing.\n\nJust a short walk from the main beach and the perfect stop after a day in the sun.\n\nThey keep it simple, and that is exactly why it works. Fresh Maine lobster dressed in mayo on a buttered bun with lettuce. Classic and delicious. 🧈\n\nI highly recommend pairing your lobster roll with their Oh-J Beer. A summer staple that pairs perfectly. 🍻\n\nIf you are heading to Old Orchard Beach this summer, add Lone Pine to your foodie list. You will not regret it!\n\nAnd keep following along because I still have a few more lobster roll spots to share before summer comes to an end. 🦞\n\n📍 Lone Pine Brewing, Old Orchard Beach, Maine\n\n@lonepinebrewing @lonepine_tastingrooms\n\n#visitmaine #oldorchardbeach #mainefoodie #mainelobsterroll #newenglandtravel",
  },
  {
    platform: "Instagram",
    stats: "315 likes, 61 comments",
    tier: "baseline",
    caption:
      "Did you know there’s a castle just 1 hour from Boston? 🏰\n\nI visited Hammond Castle Museum in Gloucester, Massachusetts, and it is such a gorgeous place to explore!\n\nBuilt by inventor John Hays Hammond Jr., the castle is filled with medieval architecture, stone passageways, dramatic rooms and even a gorgeous courtyard that feels like you’ve somehow ended up in Europe.\n\nAnd the fact that it sits right along the Massachusetts coast makes it even better.\n\nIt was such a fun day trip from Maine!\n\nDefinitely one of the most unexpected places I’ve visited in New England!\n\n📍 Hammond Castle Museum, Gloucester, Massachusetts\n\n@hammondcastlemuseum\n\n#newenglandtravel #visitboston #newenglandlife #hammondcastle #castlesofinstagram",
  },
  {
    platform: "Instagram",
    stats: "258 likes, 50 comments",
    tier: "baseline",
    caption:
      "Not to be cheesy, but would you try a parmesan cheese-infused martini? 🧀🍸\n\nIf yes, you can, at Freeport Oyster Bar!\n\nThe Cheesy-Tini is made with parmesan vodka, vermouth and olive brine, making it one of the most unique martinis I’ve tried in Maine.\n\nAnd of course, I had to pair it with a cheese plate. 🧀😂\n\nWould you give the Cheesy-Tini a try?!\n\n📍 Freeport Oyster Bar, Freeport, Maine\n\n@freeport_oysterbar\n\n#mainefoodie #mainecocktails #visitmaine #newenglandfoodie #cocktails",
  },
  {
    platform: "TikTok",
    stats: "928 views",
    tier: "baseline",
    caption:
      "Discover Halifax's dreamy pink dessert bar? 🌸 Crème on the Halifax waterfront stops you in your tracks before you even walk through the door. Pink flowers, pastel tables and vintage bikes out front like a little piece of Paris in Nova Scotia. Inside velvet seating, soft lighting and the most beautiful dessert case. I tried the peach mousse designed to look just like a real peach. Slight crunch on the outside and tasted like the best peach pie I have ever had. 🍑 We also had the Dubai Chocolate and Fig and Honey truffles and finished with their signature pink Chai latte. Every bite was incredible. Non-negotiable if you are visiting Halifax. 🌸 📍 Crème, Halifax, Nova Scotia #VisitHalifax #NovaScotia #CanadaTravel #HalifaxFood #NewEnglandTravel",
  },
];

// Reads the Profile tab's editable caption list - falls back to the
// hardcoded 14 above whenever Supabase isn't configured, the table
// doesn't exist yet, or it's genuinely empty (e.g. right after the table
// was created but before anything's been added), so this can never leave
// buildSystemPrompt() with zero examples to work from.
export async function getSampleCaptions() {
  const supabase = getSupabase();
  if (!supabase) return DEFAULT_SAMPLE_CAPTIONS;

  // position drives the order these are injected in, same reasoning as
  // getCustomInstructions() below - nulls (not yet reordered) sort after
  // everything with a real position.
  const { data, error } = await supabase
    .from("profile_captions")
    .select("*")
    .order("position", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error || !data || data.length === 0) return DEFAULT_SAMPLE_CAPTIONS;
  return data;
}

// The Profile tab's free-text rules (e.g. "no double hyphens", "never
// mention specific prices as guaranteed current") - genuinely new, so
// there's no hardcoded fallback list here, just an empty one until Leah
// adds her first instruction.
export async function getCustomInstructions() {
  const supabase = getSupabase();
  if (!supabase) return [];

  // position drives the order these are injected in (nulls - not yet
  // reordered - sort after everything with a real position), so
  // reordering on the Profile tab actually changes which rule reads as
  // taking precedence, not just the on-screen display order.
  const { data, error } = await supabase
    .from("profile_instructions")
    .select("*")
    .order("position", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });

  if (error || !data) return [];
  return data;
}

export const VOICE_FORMULA = `
Leah's caption formula, decoded from 14 of her real Instagram/TikTok posts (do not deviate from this structure):

1. HOOK - First-person and specific. "Did you know...", "I just spent the day...", "Have you seen...". Never a generic scene-setter.
2. STORY BEAT - One unexpected, concrete detail a stock description would not include (fairy houses on a trail, a jellyfish warning, exactly how a waffle is folded).
3. PRACTICAL INFO - Real logistics woven into the sentence: distance from a known landmark, price, or how to book. Choose the format yourself based on what the topic actually is - a single experience reads better as flowing narrative prose (most of her posts); a genuinely multi-stop topic (several attractions, a day's worth of activities) reads better as her emoji-bullet itinerary list (like her Mont Tremblant fall-trip post). Don't force a list onto a single-moment topic or prose onto a real multi-stop itinerary.
4. CTA - Ends on a direct question or explicit next step ("DM for the link", "Would you try it?!", "Save this for your trip").
5. LOCATION + TAG - A location-pin emoji (📍) line with the place name. Only add a venue's @handle if the user's own notes included one or named the business clearly enough to know the real handle - never invent or guess a handle. If a business is mentioned by name only, it's fine to name it in the text without an @tag.
6. HASHTAGS - Exactly 5: 1-2 broad regional/destination tags (#visitmaine, #visitnorway), 1-2 specific/niche tags tied to the topic, 1 community/interest tag (#dogsofinstagram, #castlesofinstagram, #cocktails). Lowercase, no spaces, no punctuation. This 5-tag, broad+niche+community structure is not just her habit - it matches published TikTok hashtag-strategy research (3-5 tags consistently outperforms stuffing 15-30, which confuses the algorithm and dilutes reach), and her own posts happen to be a working example of it.

Tone: warm, first-person, conversational, a little playful, never salesy or overly polished. She uses emoji purposefully (1-3 per post) tied to the subject, not as decoration.
`;

export function platformLabelFor(platform) {
  if (platform === "instagram") return "Instagram";
  if (platform === "youtube") return "YouTube";
  return "TikTok";
}

function lengthBlock(lengthSeconds, platform) {
  const lo = lengthSeconds - 3;
  const hi = lengthSeconds + 3;
  const range = `${lo}-${hi}s`;

  if (platform === "instagram") {
    return `LENGTH - Leah chose a fixed ~${lengthSeconds}-second target for this post (applies the same on both platforms she's generating). Instagram Reels has NO minimum length requirement for its own monetization (Gifts on Reels), so this choice is purely about pacing/completion rate, not eligibility - build the hook, story beats, and shot notes to properly fill ${range} well, trimming or adding a genuine beat as needed, never padding a single shot just to hit the number.`;
  }

  if (platform === "youtube") {
    return `LENGTH - Leah chose a fixed ~${lengthSeconds}-second target for this post - this is the SAME video/edit being uploaded as a YouTube Short, not a separate longer video. YouTube Shorts has no fixed per-video length floor tied to monetization the way TikTok's Creator Rewards Program does - Partner Program eligibility runs off overall channel watch hours and subscribers, not this individual video's runtime - so this choice is purely about pacing/completion rate here too, not payout eligibility. Build the hook, story beats, and shot notes to properly fill ${range} well, trimming or adding a genuine beat as needed, never padding a single shot just to hit the number.`;
  }

  if (lengthSeconds >= 60) {
    return `LENGTH - Leah chose a fixed ~${lengthSeconds}-second target. This meets TikTok's Creator Rewards Program 60-second minimum payout floor, so this video is monetization-eligible. Build the hook, story beats, and shot notes to properly fill ${range} - if the topic is naturally a quick single moment, add a genuine second beat (a close-up, a reaction, a second detail) rather than padding or slowing down the same shot, since that still hurts completion rate.`;
  }

  return `LENGTH - Leah chose a fixed ~${lengthSeconds}-second target for this post. IMPORTANT: TikTok's Creator Rewards Program requires 60+ seconds to earn anything - this video will NOT be monetization-eligible on TikTok at ${lengthSeconds}s, regardless of performance. This is a deliberate choice for this specific post (prioritizing speed/reach over payout on this one), not an oversight, but you MUST surface this tradeoff clearly in video_length_why so it's never a silent surprise. Build the hook and shot notes to properly fill ${range} tightly.`;
}

// Verified via live web search on 2026-09-10 against current third-party
// marketing/analytics coverage (Hootsuite, Later, Sprout Social, and
// similar creator-economy outlets) - NOT the platforms' own official
// documentation, since none of TikTok/Meta/YouTube publish their actual
// ranking weights; this is the ceiling of what's publicly verifiable, best
// treated as informed consensus rather than confirmed fact. The TikTok and
// Instagram numbers below matched current reporting closely (no changes
// needed); the YouTube block was updated with more specific figures than
// the original draft had. Algorithm mechanics shift over months, not overnight
// - worth another pass roughly every few months, or sooner if a generated
// post's reasoning starts citing something that feels off.
function platformSourceABlock(lengthSeconds, platform) {
  if (platform === "instagram") {
    return `SOURCE A - documented Instagram Reels platform behavior (not specific to her account, and NOT the same algorithm as TikTok - do not reuse TikTok rules here): DM shares are the #1 ranking signal (weighted 3-5x higher than likes for reaching new accounts, and a share rate above 3% of reach can mean 5-10x more distribution), then watch completion, then saves, then comments, then story shares, with plain likes weakest - so the CTA should specifically invite sending/tagging ("send this to the friend you're dragging here," "tag whoever needs this") rather than a comment-bait question, since that's what this platform's algorithm actually rewards most. Hashtags are capped at 5 (platform-enforced) and now function mainly as categorization, not a reach lever - precision over volume, same broad+niche+community mix still applies but use Instagram-native community tags (e.g. #corgisofinstagram, not #corgisoftiktok). Cover image gets cropped differently per surface (9:16 in the Reels tab, 4:5 in feed, 3:4 on the profile grid) so the key text/subject must sit inside the dead-center safe zone or it gets cut off somewhere.
LOCATION TAG (separate from the 📍 line in the caption, which always stays the literal exact venue): on Instagram, a geotagged post can surface in that place's own page/map, so tagging a bigger, well-known real landmark near a small/obscure venue can expose the post to a meaningfully larger audience than the tiny business alone would reach - this is a real, platform-endorsed choice (Instagram's own location-add flow offers a business, a trending spot, or a city name as equally valid options, not just the exact address). Actively prefer a genuinely nearby, well-known real place over the exact tiny venue when one fits naturally.
${lengthBlock(lengthSeconds, platform)}`;
  }

  if (platform === "youtube") {
    return `SOURCE A - documented YouTube Shorts platform behavior (distinct from both TikTok and Instagram - do not reuse either platform's rules here): the first test every Short has to pass is viewed-vs-swiped, and the average swipe-away happens around 5-6 seconds in, so the hook has even less runway than TikTok's 3-second window - it has to land immediately, no slower buildup than the other two platforms get. Past that, average view duration and percentage viewed are the dominant ranking signal for the Shorts shelf (not total watch time - a short, fully-watched video beats a longer one people bail on); the retention bar to get pushed wider is roughly 65% for sub-30s Shorts and 50% for 30-60s Shorts, with 70%+ average view duration considered strong. The structural difference that actually matters here: YouTube is also a search engine, and unlike a TikTok or Instagram caption (barely indexed), the Title and Description are genuinely searchable metadata - so the title must front-load the one concrete, specific hook detail as real searchable language a person might type, not just a vibe or a pun, and the description should open with 1-2 lines that work as a compelling preview (this is what shows before the viewer taps "...more") before expanding into fuller detail, a location/booking mention, and then hashtags at the end. Up to 15 hashtags are allowed across the title and description combined but only the first 3 in the description display above the title - and going over 15 makes YouTube discard ALL of them, not just the extras, so stay well under it (5 is safe). Treat hashtags here as categorization/search aid more than a discovery lever, same broad+niche+community mix as the other platforms but keep the community tag YouTube-appropriate (a plain interest tag like #traveltiktok-style naming doesn't apply here - prefer a general, genuinely searched term over a platform-specific community hashtag convention that doesn't exist on YouTube).
LOCATION TAG (separate from the 📍 line in the caption, which always stays the literal exact venue): YouTube's location metadata ("Featured Places") works by helping YouTube understand what place the Short is actually about, for search-matching - unlike Instagram, there's no evidence a bigger/more-followed location tag earns a bigger passive audience here, and engagement signals dominate over metadata anyway. Default to the exact, literal venue name (or the nearest real, accurately-describing place if the venue itself isn't a distinct listed location, e.g. a food truck) rather than a bigger nearby landmark - accuracy over reach-gaming on this platform specifically.
${lengthBlock(lengthSeconds, platform)}`;
  }

  return `SOURCE A - documented TikTok platform behavior (not specific to her account, and NOT the same algorithm as Instagram - do not reuse Instagram rules here): completion rate is the single biggest ranking signal and 70%+ completion is now needed to break out (up from 50% in 2024); roughly 70% of viewers decide whether to keep watching within the first 3 seconds; COMMENTS AND SAVES are the top engagement signals TikTok rewards beyond completion - the CTA should be built to generate comments or saves specifically (a direct question, an explicit "save this," a reason to DM), not just a sign-off; hashtag-stuffing measurably hurts reach versus a tight 3-5 tag set, and use TikTok-native community tags (e.g. #corgisoftiktok, not #corgisofinstagram); the cover should show a real face or the animal/subject with bold high-contrast text in the safe middle zone.
LOCATION TAG (separate from the 📍 line in the caption, which always stays the literal exact venue): TikTok has a dedicated Local Feed discovery surface tied to location tags, but unlike Instagram, there's no clear evidence that tagging a bigger place beats tagging the genuinely relevant one - it's about topical fit for that local discovery surface, not raw audience size. Pick whichever real, nearby option (the exact venue, or a well-known surrounding area if the content is genuinely about the broader experience, e.g. a regional trip) is the most honest fit for what this specific video is actually about - don't default to "biggest" the way Instagram rewards.
${lengthBlock(lengthSeconds, platform)}`;
}

function buildViralityInstructions(lengthSeconds, platform) {
  const platformLabel = platformLabelFor(platform);

  return `
IMPORTANT - your job is not just to sound like Leah, and Leah is not the authority here - she is not a growth expert, which is exactly why this exists. You are drawing on TWO independent sources internally, referred to below as Source A and Source B for your own reasoning only - NEVER write the literal words "Source A" or "Source B" in any user-facing field (hook_strategy, hashtag_rationale, video_length_why). Instead call Source A "${platformLabel} algorithm research" or similar plain phrasing, and refer to Source B only in general terms - "patterns from past high-performing posts" or "what's worked well before" - without naming or describing the specific past post it came from (no "the Norway sauna post," no "the corgi hike," etc.) - keep it high-level, not a citation.

${platformSourceABlock(lengthSeconds, platform)}

SOURCE B - her own outlier posts (3,900-59,000+ likes/views, versus a 250-900 baseline for everything else she's posted) - real evidence that Source A's mechanics work for her specific audience and niche, not just in the abstract. Her baseline posts already sound exactly like her and still only get baseline reach - so matching her tone is necessary but never sufficient.

Use both sources together:

1. Before writing, actively check the given topic/location/story beat against the three levers her outliers demonstrate, in order:
   - ANIMAL CONTENT: does this involve an animal at all? If yes, the animal should be the hook, not a side detail.
   - POP-CULTURE TIE-IN: does this place resemble or connect to a well-known show, movie, or cultural moment? If there's a genuine, non-forced connection, use it in the first line.
   - INSIDER ACCESS: is there a booking trick, lesser-known entry point, or a specific heads-up (safety, timing, cost) that most visitors wouldn't know? If yes, that's the hook, not a footnote.
   If none of the three genuinely fit, don't force one - but still apply rule 2 below, which comes from Source A and applies regardless of which lever, if any, is in play.

2. Whether or not a lever from #1 applies, the FIRST LINE must contain one concrete, specific, surprising detail (a number, a name, an exact claim) - never a generic scene-setting opener like "Have you ever wondered about X" with no specifics attached. This is Source A's 3-second-window finding, not just a pattern in her data. If your first draft's hook could apply to a dozen other posts, it's too generic - rewrite it around the one detail unique to this exact topic.

3. This is the ${platformLabel} package specifically - the CTA, hashtags, video length, shot notes, cover text, and location tag must all follow ${platformLabel}'s rules above, not the other platform's. Give 3-5 concrete, topic-specific filming notes - not generic advice like "use good lighting." Each note should reference something specific from this exact topic/story beat: which moment needs to be the opening shot to match the hook line, which detail deserves a close-up, a reminder to hold key shots 2-5 seconds, and a tip to grab a few extra seconds of buffer footage around the best shot so it can be re-cut into a second post later. Do NOT include a watermark-removal, clean-export, or cross-posting-to-the-other-platform reminder anywhere in shot_notes or elsewhere - that topic is out of scope here regardless of how relevant it might seem. Also suggest cover/thumbnail text: short, bold, high-contrast, built around the same specific detail as the hook - not a restatement of the whole caption.

LOCATION TAG INTEGRITY RULE (applies on all platforms, regardless of the platform-specific guidance above): a suggested location tag must always be a REAL place, genuinely close to the actual venue, and an honest description of what the content is actually about - never invented, never a distant place chosen only because it's popular, and never something that would leave a viewer feeling misled about what they're watching. "Bigger and well-known" is only ever a tiebreaker between genuinely relevant real options, not a license to reach for whatever trends highest.

After writing, name which lever (if any) you used and which algorithm mechanic (hook specificity, CTA type, hashtag structure, length strategy) is doing the real work - this reasoning gets shown to whoever is using this tool so they can judge it themselves, not just trust it blindly. Write this reasoning (hook_strategy, hashtag_rationale, video_length_why) as a neutral, plain-language summary of why the choice was made - never "her/she," and never the literal words "Source A" or "Source B" (see the naming rule above). Keep the past-content reference general, not a specific citation.

If the live web search (or any pre-fetched trend data) surfaced something that could genuinely help this specific post do better than a typical post on this topic - a real rising trend, a relevant sound, a cultural moment, a specific tactic - call it out explicitly in the relevant reasoning field (hook_strategy or hashtag_rationale) as its own finding, not folded silently into the rest. If the search found nothing like that, don't invent one.
`;
}

// Async now - pulls both the caption examples and Leah's own custom rules
// from the Profile tab (see getSampleCaptions/getCustomInstructions above)
// instead of reading a hardcoded constant, so every caller needs `await`.
export async function buildSystemPrompt(lengthSeconds = 60, platform = "tiktok") {
  const [sampleCaptions, customInstructions] = await Promise.all([getSampleCaptions(), getCustomInstructions()]);
  const outliers = sampleCaptions.filter((c) => c.tier === "outlier");
  const baseline = sampleCaptions.filter((c) => c.tier !== "outlier");
  const platformLabel = platformLabelFor(platform);

  const renderGroup = (group) =>
    group
      .map(
        (c, i) =>
          `Example ${i + 1} (${c.platform}, ${c.stats})${c.why ? `\nWhy this one outperformed: ${c.why}` : ""}:\n${c.caption}`
      )
      .join("\n\n---\n\n");

  // Placed last, right before the final instruction, and framed as
  // overriding anything above it - Leah's own stated preferences (a
  // banned phrase, a formatting tic to avoid, a fact the app should
  // always get right) should win over the general voice/virality
  // guidance if the two ever conflict, not get buried earlier and
  // outweighed by everything that comes after.
  const customInstructionsBlock =
    customInstructions.length > 0
      ? `\nLEAH'S OWN RULES - these come directly from her, follow them exactly, and they win over any general guidance above if the two ever conflict:\n${customInstructions
          .map((i) => `- ${i.text}`)
          .join("\n")}\n`
      : "";

  // Split into a platform/length-independent block (voice formula + all
  // sample captions - the bulk of this prompt's tokens) and a platform-
  // specific tail (virality rules, her own custom instructions, the final
  // directive). generatePost() runs one call per selected platform in
  // parallel from the SAME "Generate Content" click - previously the
  // platform name sat in this prompt's very first line, so each
  // platform's system prompt was a byte-different string and got its own
  // separate prompt-cache entry even though ~90% of the content (the
  // captions) is identical across all three. Returning the two parts
  // separately lets cachedSystemBlock() below cache only the shared part,
  // so a 3-platform generation pays for that cache write once instead of
  // three times. Order of information the model sees is unchanged -
  // custom instructions still land right before the final directive,
  // still framed as overriding the virality guidance above them.
  const shared = `You are writing social post captions and hashtag sets for Leah, the creator behind the travel brand Wine Wilderness Wanderlust (New England-based, posts across New England, Canada, and Europe). You have two jobs, in order: (1) sound exactly like her, never generic travel-influencer copy, and (2) actively try to make this specific post outperform her baseline, using the proven mechanics given further below - not just replicate her average.

${VOICE_FORMULA}

--- OUTLIER POSTS (these did 10-190x her normal reach - study WHY, not just how they sound) ---

${renderGroup(outliers)}

--- BASELINE POSTS (this is just her normal voice/tone - typical reach, not evidence of virality) ---

${renderGroup(baseline)}`;

  const platformSpecific = `This package is specifically for ${platformLabel}.

${buildViralityInstructions(lengthSeconds, platform)}
${customInstructionsBlock}
Given a topic, location, and any story details the user provides, write the ${platformLabel} ${platform === "youtube" ? "title, description," : "caption"} and hashtag set in her voice, following every ${platformLabel}-specific rule above. If live trending-hashtag data is supplied, prefer those tags when they genuinely fit the topic - never force an irrelevant trending tag just because it's popular.

When you have your final answer, call the submit_post tool with it - every field in that tool is required, including video_length_why, shot_notes, cover_text, and location_tag/location_tag_why. Do not respond with plain text or JSON in your message; the submit_post tool call is the only acceptable way to deliver the result.`;

  return { shared, platformSpecific };
}
