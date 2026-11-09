import { CatalogCardArt, CatalogDescription, CatalogDisclosure } from "./CatalogPhotos";
import type { PublicCatalogProduct } from "../../lib/catalog/types";
import type { CatalogCard } from "../lib/card-shard";
import { isIllustrative } from "../lib/selection";
import { shortProductName } from "../lib/product-presentation";
import { Icon } from "./Icon";

export function ProductCard({
  product,
  lead = false,
  eager = false,
  context = "catalog",
}: {
  product: PublicCatalogProduct | CatalogCard;
  lead?: boolean;
  eager?: boolean;
  context?: string;
}) {
  const illustrative =
    "illustrative" in product ? product.illustrative : isIllustrative(product);
  const name = shortProductName(product.title);
  return (
    <article className={`product-card ${lead ? "lead-card" : ""}`}
      data-analytics-card={illustrative ? undefined : ""}
      data-analytics-id={illustrative ? undefined : product.id}
      data-analytics-source={illustrative ? undefined : product.source}
      data-analytics-context={context}
      data-analytics-expiry={product.eligibleUntil ?? undefined}
      data-analytics-permanent={product.eligibleUntil === null ? "" : undefined}>
      <CatalogCardArt
        href={`/gifts/${product.slug}`}
        label={`View ${name}`}
        illustrative={illustrative}
        id={product.id}
        imageUrl={product.imageUrl}
        alt={
          illustrative
            ? `Original illustration for a fictional ${product.title}`
            : name
        }
        className="object-contain"
        sizes="(max-width: 700px) 45vw, 30vw"
        priority={lead || eager}
      />
      <div className="card-copy">
        {illustrative && <p className="eyebrow">Illustrative fixture · not for sale</p>}
        <h2>
          <a data-analytics-product-link="" href={`/gifts/${product.slug}`}>
            {name}
          </a>
        </h2>
        {!illustrative && <CatalogDisclosure source={product.source} id={product.id} />}
        <CatalogDescription source={product.source} id={product.id} title={product.title} fallback={product.description} card />
        <a className="card-action" data-analytics-product-link="" href={`/gifts/${product.slug}`}>
          View gift <Icon name="arrow" />
          <span className="sr-only">: {name}</span>
        </a>
      </div>
    </article>
  );
}
