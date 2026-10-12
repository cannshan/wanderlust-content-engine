"use client";

import { useState } from "react";

// A place's photo (its website's preview image, see usePlaceImages), or -
// when there isn't one, or it fails to load - a brand-teal tile with an
// emoji for what kind of place it is, so every card still has a picture.
// variant "thumb" is a small square beside the text; "banner" is a wide
// photo across the top of a card (a banner with no photo renders nothing,
// since a big empty tile would just be filler).

const CATEGORY_EMOJI = [
  [/bar|speakeas|cocktail|pub|brew|wine|winer|distill|tap ?room|cider/i, "🍸"],
  [/restaurant|food|dining|eat|bistro|cafe|café|bakery|dessert|lobster|seafood|pizza|brunch|snack/i, "🍽️"],
  [/hik|trail|outdoor|mountain|park|nature|preserve|forest|falls|waterfall|lake|garden/i, "🥾"],
  [/beach|coast|harbou?r|island|ocean|boat|cruise|ferry|lighthouse|wharf/i, "🌊"],
  [/museum|histor|art|gallery|landmark|monument|castle|fort/i, "🏛️"],
  [/stay|hotel|inn|lodg|resort|glamp|cabin|chalet|b&b|bed and breakfast/i, "🛏️"],
  [/tour|experience|activit|adventure|class|workshop|farm|zoo|animal|dog/i, "🧭"],
  [/shop|market|store|boutique|brand/i, "🛍️"],
  [/event|festival|show|concert|season/i, "🎉"],
];

export function categoryEmoji(...hints) {
  const text = hints.filter(Boolean).join(" ");
  return CATEGORY_EMOJI.find(([re]) => re.test(text))?.[1] || "📍";
}

export default function PlaceThumb({ imageUrl, hints = [], variant = "thumb", alt = "" }) {
  // Tracks which URL failed, not just "failed", so a new image for the
  // same card (a website found later) gets its own chance to load.
  const [failedUrl, setFailedUrl] = useState(null);
  const showImage = imageUrl && failedUrl !== imageUrl;
  const setFailed = () => setFailedUrl(imageUrl);

  if (variant === "banner") {
    if (!showImage) return null;
    return (
      <div className="place-banner">
        {/* Third-party site images, shown as-is - next/image would need
            every possible domain allow-listed. no-referrer because some
            sites refuse hotlinked images that carry one. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      </div>
    );
  }

  return (
    <div className="place-thumb" aria-hidden={showImage ? undefined : "true"}>
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={imageUrl} alt={alt} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        <span>{categoryEmoji(...hints)}</span>
      )}
    </div>
  );
}
