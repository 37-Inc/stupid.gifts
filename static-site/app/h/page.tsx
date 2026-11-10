import { isFixtureRelease } from "../../lib/catalog";
import { previewMetadata } from "../../lib/metadata";
import { ShowShortlist } from "../../components/ShowShortlist";

export const metadata = previewMetadata("Stupid gifts. Excellent taste.",
  "A hand-picked assortment of unusual gifts.", "/h", { indexable: false, fixture: isFixtureRelease });

export default function ShowPicksPage() {
  return <ShowShortlist />;
}
