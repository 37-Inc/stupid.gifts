import { catalog } from "../lib/catalog";
import { selectShowPicks } from "../lib/show-rehearsal";
import type { ShowPreset } from "../lib/show-rehearsal";
import { ProductCard } from "./ProductCard";
import { Search } from "./Search";

export function ShowShortlist({ preset, action = "/h" }: {
  preset?: ShowPreset; action?: "/h" | `/h/${ShowPreset}`;
}) {
  const picks = selectShowPicks(catalog, preset);
  return <main id="main" className="site-main show-rehearsal">
    <div className="opening-line"><h1>Stupid gifts. <span>Excellent taste.</span></h1></div>
    <Search action={action} autoSearch={false}>
      {picks.length ? <div className="catalog-grid" aria-label="Gifts">
        {picks.map((product, index) => <ProductCard key={product.id} product={product}
          lead={index === 0} eager context="show-curated" />)}
      </div> : <p>These picks are being refreshed. <a href="/">Browse all gifts.</a></p>}
    </Search>
  </main>;
}
