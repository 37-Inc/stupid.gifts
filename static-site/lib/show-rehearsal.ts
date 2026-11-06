import type { CatalogSnapshot, PublicCatalogProduct } from "../../lib/catalog/types";
import { readySnapshotProducts } from "./selection";

// A fixed on-camera shortlist. Resolve current public products, keeping their
// canonical copy, photos and links; this is not a simulated search result.
export const SHOW_PICK_SLUGS = [
  "country-cat-cowboy-decor-for-cat-lovers",
  "cluck-yeah-chicken-leg-socks-for-poultry-lovers",
  "guitar-shaped-cutting-board-wood-for-kitchen",
  "rooster-but-not-a-roost-wine-bottle-holder",
  "wrap-it-up-tortilla-blanket-for-foodies",
  "trash-talk-with-the-raccoon-desk-buddy",
  "desktop-boxing-knock-out-stress-in-style",
  "lobster-claw-oven-mitts-quilted-cotton-lining-design-heat-resistant-crab-claw-gloves-microwave-oven-gloves-lobster-oven",
] as const;

export function selectShowPicks(snapshot: CatalogSnapshot): PublicCatalogProduct[] {
  const products = readySnapshotProducts(snapshot);
  const available = new Map(products.map((product) => [product.slug, product]));
  const picks = SHOW_PICK_SLUGS.flatMap((slug) => available.get(slug) || []);
  // Fixtures are illustrative. On a real catalog, never silently substitute
  // unrehearsed items if one of the hand-picked products is removed.
  return snapshot.dataKind === "synthetic_fixture" ? products.slice(0, SHOW_PICK_SLUGS.length) : picks;
}
