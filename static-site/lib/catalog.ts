import fs from "node:fs";
import path from "node:path";
import { validateCatalogSnapshot } from "../../lib/catalog/snapshot";
import { catalogDisplayView } from "../../lib/catalog/display";
import fixtureSnapshot from "../fixtures/catalog.snapshot.json";
import { createBrowseRelease } from "./browse";
import { createPhotoRelease } from "./photos";
import { createRelatedGiftSelector } from "./related-gifts";
import { rankedBrowseProducts } from "./browse";

// Exactly one immutable input per build, never a database or provider adapter.
// The release command supplies a private, validated snapshot path for real cohorts.
const input = process.env.CATALOG_SNAPSHOT_PATH
  ? JSON.parse(
      fs.readFileSync(path.resolve(process.env.CATALOG_SNAPSHOT_PATH), "utf8"),
    )
  : fixtureSnapshot;
export const sealedCatalog = validateCatalogSnapshot(input, new Date());
export const photos = createPhotoRelease(sealedCatalog);
// Build supplies the normalized, sealed context; development/fixtures use their
// fixed snapshot time rather than a machine clock or an unbound extra setting.
const releaseContext = process.env.CATALOG_RELEASE_CONTEXT_PATH
  ? JSON.parse(fs.readFileSync(path.resolve(process.env.CATALOG_RELEASE_CONTEXT_PATH), "utf8"))
  : null;
export const catalog = catalogDisplayView(sealedCatalog,releaseContext?.merchandising);
export const isFixtureRelease = catalog.dataKind === "synthetic_fixture";
export const releaseGeneratedAt: string = releaseContext?.generatedAt ?? catalog.generatedAt;
export const browse = createBrowseRelease(catalog, releaseGeneratedAt, releaseContext?.homepage);
export const relatedGifts = createRelatedGiftSelector(rankedBrowseProducts(catalog));
