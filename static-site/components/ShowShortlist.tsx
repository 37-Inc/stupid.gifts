import { catalog } from "../lib/catalog";
import { selectShowPicks } from "../lib/show-rehearsal";
import type { ShowPreset } from "../lib/show-rehearsal";
import { ProductCard } from "./ProductCard";
import { Search } from "./Search";
import { ShowLineup } from "./ShowLineup";
import { SHOW_LINEUP_BOOTSTRAP } from "../lib/show-lineup";

export function ShowShortlist({ preset, action = "/h" }: {
  preset?: ShowPreset; action?: "/h" | `/h/${ShowPreset}`;
}) {
  const picks = selectShowPicks(catalog, preset);
  return <main id="main" className="site-main show-rehearsal" data-custom-show="false" suppressHydrationWarning>
    <div className="opening-line"><h1>Stupid gifts. <span>Excellent taste.</span></h1></div>
    <style>{`[data-custom-show="true"] .show-default-picks{display:none}`}</style>
    <script dangerouslySetInnerHTML={{ __html: SHOW_LINEUP_BOOTSTRAP }} />
    <noscript>Custom URL lineups require JavaScript. The saved picks are shown below.</noscript>
    <Search action={action} autoSearch={false}>
      <ShowLineup catalogRevision={catalog.catalogRevision} action={action}>
      {picks.length ? <div className="catalog-grid" aria-label="Gifts">
        {picks.map((product, index) => <ProductCard key={product.id} product={product}
          lead={index === 0} eager context="show-curated" />)}
      </div> : <p>These picks are being refreshed. <a href="/">Browse all gifts.</a></p>}
      </ShowLineup>
    </Search>
  </main>;
}
