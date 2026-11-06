import { previewMetadata } from "../../lib/metadata";
import { isSitePreview, siteIdentity } from "../../lib/site-identity";
import { isFixtureRelease } from "../../lib/catalog";
import { privacyPolicySections, privacyPolicyIntro, privacyPolicyUpdated } from "../../../lib/privacy-policy";
import { PUBLIC_CONTACT_EMAIL } from "../../../lib/site";
const preview = isSitePreview || isFixtureRelease;
const brand = (text: string) => text.replaceAll("goose.gifts", siteIdentity.wordmark);
export const metadata = previewMetadata(
  preview ? "Preview privacy" : "Privacy Policy",
  preview ? "The isolated static proof does not initialize production analytics or save queries in browser storage."
    : `Privacy policy for ${siteIdentity.wordmark}.`,
  "/privacy",
  { indexable: !preview, fixture: isFixtureRelease },
);
export default function Privacy() {
  if (!preview) return (
    <main id="main" className="site-main prose">
      <h1>Privacy Policy</h1>
      <p className="quiet">Last updated {privacyPolicyUpdated}</p>
      <p>{brand(privacyPolicyIntro)}</p>
      {privacyPolicySections.map((section) => <section key={section.title}>
        <h2>{section.title}</h2>
        {section.body.map((paragraph) => <p key={paragraph}>{brand(paragraph)}</p>)}
      </section>)}
    </main>
  );
  return (
    <main id="main" className="site-main prose">
      <h1>Preview privacy.</h1>
      <p>
        This isolated staging proof does not initialize production analytics.
        Search queries are sent only to the site’s search endpoint when you
        submit them. We do not store catalog content or search queries in
        localStorage, cookies or a service worker.
      </p>
      <p>
        External retailer links, when enabled for approved real products, open
        only after you choose them. Illustrative fixtures have no retailer
        destination.
      </p>
      <p>
        Questions:{" "}
        <a href={`mailto:${PUBLIC_CONTACT_EMAIL}`}>{PUBLIC_CONTACT_EMAIL}</a>.
      </p>
    </main>
  );
}
