import type { Metadata } from "next";
import { previewMetadata } from "../lib/metadata";
import { isFixtureRelease, photos } from "../lib/catalog";
import { CatalogPhotos } from "../components/CatalogPhotos";
import { siteEditorialDisclosures } from "../lib/site-editorial";
import { StaticAnalytics } from "../components/StaticAnalytics";
import { StaticContentExpiry } from "../components/StaticContentExpiry";
import SafeCatalog from "./safe/catalog/page";
import { show } from "../lib/show-data";
import { isSitePreview, isSiteProduction, siteIdentity } from "../lib/site-identity";
import { Icon } from "../components/Icon";
import { PUBLIC_CONTACT_EMAIL } from "../../lib/site";
import "./styles.css";

export const metadata: Metadata = {
  ...previewMetadata(
    "Stupid gifts. Excellent taste.",
    isFixtureRelease
      ? `An isolated, noindex ${siteIdentity.name} design and static-export preview. Illustrative fixtures are not products for sale.`
      : isSitePreview ? `An isolated, noindex ${siteIdentity.name} staging preview using a bounded catalog cohort. This is not a public launch.`
        : `${siteIdentity.name}: ${siteIdentity.tagline}`,
    "/",
  ),
  icons: { icon: "/favicon.ico" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {isSiteProduction && process.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED === "true" &&
          !isFixtureRelease && <StaticAnalytics />}
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {(isSitePreview || isFixtureRelease) && <div className="preview-notice">
          {isFixtureRelease
            ? "Private design proof · illustrative examples, not purchasable products"
            : "Private staging preview · not a public launch"}
        </div>}
        <header className="site-header">
          <a className="wordmark" href="/" aria-label={`${siteIdentity.name} home`}>
            {siteIdentity.brand}<span>.</span>gifts
          </a>
          <nav aria-label="Main navigation">
            <a className="nav-random" href="/random-gift"><Icon name="dice" />Surprise me</a>
            {show.latest && <a className="nav-show" href="/howie">From the show</a>}
            <a className="nav-secondary" href="/gift-guides">Gift guides</a>
            <a href="/#catalog-search" className="nav-search">
              Search
            </a>
          </nav>
        </header>
        <CatalogPhotos indexPath={photos.indexPath} photoSlots={Object.keys(photos.index.products)}
          editorialDisclosures={siteEditorialDisclosures}>
          <StaticContentExpiry fallback={<SafeCatalog />}>{children}</StaticContentExpiry>
        </CatalogPhotos>
        <footer>
          <a className="wordmark" href="/">
            {siteIdentity.brand}<span>.</span>gifts
          </a>
          <p className="quiet">
            {isFixtureRelease
              ? "Staging only. Original illustrative assets; no merchant photography or current-offer claims. "
              : isSitePreview ? "Staging only. " : ""}
            We may earn a commission. As an Amazon Associate we earn from
            qualifying purchases.
          </p>
          <p className="footer-partner">
            <a href={`mailto:${PUBLIC_CONTACT_EMAIL}?subject=Stupid%20Gifts%20partnership`}>
              Selling something stupid? Partner with us!
            </a>
          </p>
          <div className="footer-bottom">
            <span>© Thirty Seven Inc.</span>
            <a href="/gift-guides">Gift guides</a>
            <a href="/random-gift">Surprise me</a>
            <a href="https://www.pinterest.com/stupid_gifts/" target="_blank" rel="noopener noreferrer">
              Pinterest<span className="sr-only"> (opens in a new tab)</span>
            </a>
            <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>Contact</a>
            <a href="/privacy">Privacy</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
