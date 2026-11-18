import { guides, selectGuideProducts } from "../../lib/guides";
import { previewMetadata } from "../../lib/metadata";
import { PREVIEW_ORIGIN } from "../../lib/metadata";
import { JsonLd } from "../../components/JsonLd";
import { catalog, isFixtureRelease } from "../../lib/catalog";
import { GuideIcon } from "../../components/GuideIcon";
import { Icon } from "../../components/Icon";
export const metadata = previewMetadata(
  "Gift guides",
  "Browse gift guides with original editorial and matching selections from the curated collection.",
  "/gift-guides",
  { indexable: true, fixture: isFixtureRelease },
);
export default function Guides() {
  const available = guides.filter((guide) => selectGuideProducts(catalog, guide).length > 0);
  return (
    <main id="main" className="site-main">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "CollectionPage",
          name: "Gift guides",
          url: `${PREVIEW_ORIGIN}/gift-guides`,
          mainEntity: {
            "@type": "ItemList",
            numberOfItems: available.length,
            itemListElement: available.map((guide, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: guide.title,
              url: `${PREVIEW_ORIGIN}/gift-guides/${guide.slug}`,
            })),
          },
        }}
      />
      <div className="page-heading">
        <h1>Gift guides</h1>
        <p>Start with the occasion, the person or their particular obsession.</p>
      </div>
      <div className="guide-links">
        {available.map((guide) => (
          <a key={guide.slug} href={`/gift-guides/${guide.slug}`}>
            <GuideIcon slug={guide.slug} />
            {guide.title}
            <Icon name="chevron" />
          </a>
        ))}
      </div>
    </main>
  );
}
