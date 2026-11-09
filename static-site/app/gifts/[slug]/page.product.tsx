import { notFound } from "next/navigation";
import { CatalogDescription, CatalogDisclosure, CatalogImage } from "../../../components/CatalogPhotos";
import { buildGiftPageSchema } from "@/lib/gift-page-schema";
import { catalog, relatedGifts } from "../../../lib/catalog";
import { isIllustrative } from "../../../lib/selection";
import { previewMetadata, PREVIEW_ORIGIN } from "../../../lib/metadata";
import { ProductCard } from "../../../components/ProductCard";
import { og } from "../../../lib/og-data";
import { shortProductName } from "../../../lib/product-presentation";
import { Icon } from "../../../components/Icon";

export const dynamicParams = false;
// Held identities use shared neutral assets, not one React export per identity.
export function generateStaticParams() {
  return catalog.products.map(({ slug }) => ({
    slug,
  }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = catalog.products.find((item) => item.slug === slug);
  if (!product) notFound();
  return previewMetadata(
    shortProductName(product.title),
    product.description,
    `/gifts/${slug}`,
    { indexable: true, fixture: catalog.dataKind === "synthetic_fixture",
      image: og.cards.find((card) => card.subjectId === product.publicId) },
  );
}
export default async function Gift({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = catalog.products.find((item) => item.slug === slug);
  if (!product) notFound();
  const illustrative = isIllustrative(product);
  const related = relatedGifts(product);
  const name = shortProductName(product.title);
  const retailer = product.source === "amazon" ? "Amazon" : "Etsy";
  const schema = buildGiftPageSchema(
    product,
    `${PREVIEW_ORIGIN}/gifts/${slug}`,
    name,
    product.description,
    PREVIEW_ORIGIN,
  );
  return (
    <main id="main" className="site-main">
      {!illustrative && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(schema).replace(/</g, "\\u003c"),
          }}
        />
      )}
      <a className="back-link" href="/">
        Browse all gifts
      </a>
      <article className="product-detail">
        <div className={`detail-art${illustrative ? "" : " retailer-art"}`}>
          <CatalogImage
            id={product.id}
            imageUrl={product.imageUrl}
            alt={
              illustrative
                ? `Original illustration of the fictional ${product.title}`
                : name
            }
            className="object-contain"
            sizes="(max-width: 700px) 90vw, 55vw"
            priority
          />
        </div>
        <div className="detail-copy">
          {illustrative && <p className="eyebrow">Illustrative fixture · not for sale</p>}
          <h1>{name}</h1>
          {!illustrative && <CatalogDisclosure source={product.source} id={product.id} />}
          <CatalogDescription source={product.source} id={product.id} title={product.title} fallback={product.description} />
          {illustrative ? (
            <div className="fixture-explanation">
              <h2>A design example, not a real listing.</h2>
              <p>
                This original illustration and fictional object test the layout.
                There is no retailer, price, availability or endorsement to
                claim.
              </p>
              <a className="button" href="/random-gift">
                Try another example
              </a>
            </div>
          ) : (
            <div id="gift-retailer-primary"
              data-analytics-id={product.id}
              data-analytics-source={product.source}
              data-analytics-context="gift_page_primary_cta"
              data-analytics-expiry={product.eligibleUntil ?? undefined}
              data-analytics-permanent={product.eligibleUntil === null ? "" : undefined}>
              <a
                data-analytics-outbound=""
                href={product.affiliateUrl}
                target="_blank"
                rel="sponsored noopener noreferrer"
                className="button"
              >
                Check price on {retailer}
                <Icon name="external" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <p className="quiet">
                Check current price and availability at the retailer. We may
                earn a commission.
              </p>
            </div>
          )}
          {product.editorialWriteup && (
            <details className="editorial">
              <summary>More about this gift</summary>
              {product.editorialWriteup
                .split(/\n\s*\n/)
                .map((paragraph, index) => (
                  <p key={index}>{paragraph}</p>
                ))}
            </details>
          )}
        </div>
      </article>
      {related.length > 0 && <section className="section-block">
        <div className="section-heading">
          <h2>You might also like</h2>
          <a href="/random-gift" className="text-action">
            Surprise me
          </a>
        </div>
        <div className="catalog-grid">
          {related
            .map((item) => (
              <ProductCard key={item.id} product={item} context="gift_related" />
            ))}
        </div>
      </section>}
    </main>
  );
}
