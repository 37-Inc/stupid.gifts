import { catalog, isFixtureRelease } from "../../lib/catalog";
import { previewMetadata } from "../../lib/metadata";
import { selectShowPicks } from "../../lib/show-rehearsal";
import { ProductCard } from "../../components/ProductCard";
import { Search } from "../../components/Search";

export const metadata = previewMetadata("Stupid gifts. Excellent taste.",
  "A hand-picked assortment of unusual gifts.", "/h", { indexable: false, fixture: isFixtureRelease });

export default function ShowPicksPage() {
  const picks = selectShowPicks(catalog);
  return <main id="main" className="site-main show-rehearsal">
    <div className="opening-line"><h1>Stupid gifts. <span>Excellent taste.</span></h1></div>
    <Search action="/h" autoSearch={false}>
    {picks.length ? <div className="catalog-grid" aria-label="Gifts">
      {picks.map((product, index) => <ProductCard key={product.id} product={product}
        lead={index === 0} eager context="show-curated" />)}
    </div> : <p>These picks are being refreshed. <a href="/">Browse all gifts.</a></p>}
    </Search>
  </main>;
}
