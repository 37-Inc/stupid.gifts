import {
  giftGuides,
  giftGuideFocusKeywordGroups,
} from "../../lib/gift-guide-definitions";
import type { GiftGuideDefinition } from "../../lib/gift-guide-definitions";
import { suppressNearDuplicateProducts } from "../../lib/db/product-scoring";
import type {
  CatalogSnapshot,
  PublicCatalogProduct,
} from "../../lib/catalog/types";
import { PREVIEW_ORIGIN } from "./metadata";
import { readySnapshotProducts } from "./selection";
import { siteIdentity } from "./site-identity";

export const guides = giftGuides;
export const GUIDE_PRODUCT_LIMIT = 36;

function matches(text: string, keyword: string): boolean {
  const words = keyword.toLowerCase().match(/[a-z0-9]+/g) || [];
  return (
    words.length > 0 &&
    new RegExp(
      `(^|[^\\p{L}\\p{N}])${words.join("[^\\p{L}\\p{N}]+")}([^\\p{L}\\p{N}]|$)`,
      "iu",
    ).test(text)
  );
}

/** Same canonical title-focus groups and conservative family dedup as production.
 * Do not use its broad generated-keyword fallback: a thin immutable sample must
 * stay thin, not borrow unrelated products merely containing "funny" or "gift".
 * The already-validated public projection is the only membership input.
 */
export function selectGuideProducts(
  snapshot: CatalogSnapshot,
  guide: GiftGuideDefinition,
  now = Date.parse(snapshot.generatedAt),
): PublicCatalogProduct[] {
  const products = readySnapshotProducts(snapshot, now);
  if (guide.curatedProductIds) {
    const byId = new Map(products.map((product) => [product.id, product]));
    return [...new Set(guide.curatedProductIds)]
      .flatMap((id) => byId.get(id) ?? [])
      .slice(0, GUIDE_PRODUCT_LIMIT);
  }
  const groups = giftGuideFocusKeywordGroups[guide.slug] || [
    guide.keywords.slice(0, 1),
  ];
  const score = (p: PublicCatalogProduct) =>
    guide.keywords.reduce(
      (sum, keyword) =>
        sum +
        (matches(p.title, keyword) ? 4 : 0) +
        ([
          p.punnyTitle || "",
          p.wittyDescription || "",
          ...(p.humorTags || []),
        ].some((text) => matches(text, keyword))
          ? 1
          : 0),
      0,
    );
  const candidates = products
    .filter((p) =>
      groups.every((group) =>
        group.some((keyword) => matches(p.title, keyword)),
      ),
    )
    .sort(
      (a, b) =>
        score(b) - score(a) ||
        b.qualityScore - a.qualityScore ||
        a.id.localeCompare(b.id),
    );
  return suppressNearDuplicateProducts(candidates, GUIDE_PRODUCT_LIMIT);
}

export function relatedGuides(guide: GiftGuideDefinition) {
  const keywords = new Set(guide.keywords);
  return guides
    .filter((g) => g.slug !== guide.slug)
    .map((g) => ({
      guide: g,
      score: g.keywords.filter((k) => keywords.has(k)).length,
    }))
    .sort(
      (a, b) => b.score - a.score || a.guide.title.localeCompare(b.guide.title),
    )
    .slice(0, 8)
    .map((g) => g.guide);
}

export function guideSchema(
  guide: GiftGuideDefinition,
  products: PublicCatalogProduct[],
) {
  const url = `${PREVIEW_ORIGIN}/gift-guides/${guide.slug}`;
  const graph: Record<string, unknown>[] = [
    {
      "@type": "WebPage",
      "@id": `${url}#webpage`,
      name: guide.title,
      headline: guide.h1,
      description: guide.intro,
      url,
      isPartOf: {
        "@type": "WebSite",
        name: siteIdentity.name,
        url: PREVIEW_ORIGIN,
      },
    },
    {
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Gift guides",
          item: `${PREVIEW_ORIGIN}/gift-guides`,
        },
        { "@type": "ListItem", position: 2, name: guide.title, item: url },
      ],
    },
    {
      "@type": "ItemList",
      name: guide.title,
      numberOfItems: products.length,
      itemListElement: products.map((p, i) => ({
        "@type": "ListItem",
        position: i + 1,
        name: p.punnyTitle || p.title,
        url: `${PREVIEW_ORIGIN}/gifts/${p.slug}`,
      })),
    },
  ];
  // The shared runtime fallback claims a live catalog. Keep exact authored FAQs,
  // not stale runtime claims or new synthetic FAQ content, in this static app.
  if (guide.faqs?.length)
    graph.push({
      "@type": "FAQPage",
      mainEntity: guide.faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    });
  return { "@context": "https://schema.org", "@graph": graph };
}
