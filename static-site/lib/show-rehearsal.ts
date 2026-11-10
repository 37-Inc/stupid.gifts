import type { CatalogSnapshot, PublicCatalogProduct } from "../../lib/catalog/types";
import { readySnapshotProducts } from "./selection";

// Saved lineups contain identities only, never frozen product copy or photos.
// Keep past editions intact so a postponed filming can reopen its original URL.
export const SHOW_PRESETS = {
  "billy-ray": [
    "country-cat-cowboy-decor-for-cat-lovers",
    "cluck-yeah-chicken-leg-socks-for-poultry-lovers",
    "guitar-shaped-cutting-board-wood-for-kitchen",
    "rooster-but-not-a-roost-wine-bottle-holder",
    "wrap-it-up-tortilla-blanket-for-foodies",
    "trash-talk-with-the-raccoon-desk-buddy",
    "desktop-boxing-knock-out-stress-in-style",
    "lobster-claw-oven-mitts-quilted-cotton-lining-design-heat-resistant-crab-claw-gloves-microwave-oven-gloves-lobster-oven",
  ],
  matan: [
    "bullshit-button-hit-for-instant-hilarity",
    "fun-express-top-banana-award-trophy",
    "grow-a-girlfriend-the-perfect-companion",
    "donald-socks-hair-today-gone-tomorrow",
    "pop-goes-the-finger-surprise-prank-in-a-box",
    "hey-you-dropped-this-your-iq",
    "emotional-support-chicken-nuggets-cuddle-crunch",
    "pizza-boss-3000-slice-of-humor-for-kitchen-heroes",
  ],
} as const;

export type ShowPreset = keyof typeof SHOW_PRESETS;
export const ACTIVE_SHOW_PRESET: ShowPreset = "matan";
export const SHOW_PICK_SLUGS = SHOW_PRESETS[ACTIVE_SHOW_PRESET];
export const SHOW_PRESET_KEYS = Object.keys(SHOW_PRESETS) as ShowPreset[];
export function isShowPreset(value: string): value is ShowPreset {
  return Object.hasOwn(SHOW_PRESETS, value);
}

export function selectShowPicks(snapshot: CatalogSnapshot, preset: ShowPreset = ACTIVE_SHOW_PRESET): PublicCatalogProduct[] {
  const products = readySnapshotProducts(snapshot);
  const available = new Map(products.map((product) => [product.slug, product]));
  const slugs = SHOW_PRESETS[preset];
  const picks = slugs.flatMap((slug) => available.get(slug) || []);
  // Fixtures are illustrative. On a real catalog, never silently substitute
  // unrehearsed items if one of the hand-picked products is removed.
  return snapshot.dataKind === "synthetic_fixture" ? products.slice(0, slugs.length) : picks;
}
