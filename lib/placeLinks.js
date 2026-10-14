// Where a place's name links to. A venue - a restaurant, bar, museum, shop,
// something with its own Google Maps listing - opens a Maps search. Events
// (a karaoke night at a bar, a haunted trail, a festival), hikes, tours and
// other activities open a regular Google search instead: Maps either finds
// nothing for them or lands on the building they happen to be in, while
// a web search turns up the event page, dates and tickets. Either way it's
// a search, never a URL the model cites - a search always lands somewhere
// real, with no risk of a wrong or invented link.
//
// Searches since this was added label each place with a KIND (see
// lib/claude.js); older saved results don't have one, so they're guessed
// from the name and category. When in doubt the guess picks the Google
// search - it still shows a venue's Maps panel at the top, whereas Maps
// for an event is a dead end.

export const PLACE_KINDS = ["venue", "event", "outdoors", "experience"];

// Words in a name that mean "this is a happening, not a building":
// "Flatbread Community Night", "Scary-oke", "Pumpkin SMASH",
// "Deadwick's Spectral Stroll", "Evil Dead The Musical".
const EVENT_NAME = /\b(night|nights|festival|fest|fair|parade|market|show|musical|concert|tour|tours|cruise|stroll|walk|hike|trail|trails|smash|trick-or-treat|haunted|ghosts?|pop-up|spectacular|celebration|series)\b|-oke\b/i;
// Category words for the same: "events", "hiking/outdoors", "cinematic/
// visually striking areas", "bookable experiences / ghost tours".
const NON_VENUE_CATEGORY = /\b(events?|festivals?|hik\w*|outdoors?|trails?|parks?|preserves?|scenic|cinematic|nature|waterfalls?|beach\w*|experiences?|tours?|cruises?)\b/i;
// Name or category words for a fixed venue.
const VENUE = /\b(restaurants?|dining|bars?|pubs?|tavern|brew\w*|cafe|café|coffee|bakery|food\w*|quick bites|grill|kitchen|eatery|museums?|gallery|shops?|store|trading post|winery|vineyard|distillery|speakeas\w*|lounge|hotel|inn)\b/i;

export function placeKind({ kind, name = "", category = "" }) {
  if (PLACE_KINDS.includes(kind)) return kind;
  if (EVENT_NAME.test(name) || /\bevents?\b/i.test(category)) return "event";
  if (VENUE.test(name) || (VENUE.test(category) && !NON_VENUE_CATEGORY.test(category))) return "venue";
  return "experience";
}

function usable(text) {
  return text && !/not specified/i.test(text) ? text : "";
}

// place: { name, kind?, category?, area?, address?, near? } - `near` is
// the searched location, used when the place's own area is unknown.
export function placeLink(place) {
  const where = usable(place.area) || usable(place.near);
  if (placeKind(place) === "venue") {
    const query = [place.name, place.address || where].filter(Boolean).join(", ");
    return { url: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`, label: "Google Maps" };
  }
  const query = [place.name, where].filter(Boolean).join(" ");
  return { url: `https://www.google.com/search?q=${encodeURIComponent(query)}`, label: "Google" };
}
