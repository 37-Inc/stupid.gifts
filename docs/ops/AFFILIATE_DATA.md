# Affiliate Data Availability

## Current reporting reference — November 4, 2026

| Field | Correct value |
| --- | --- |
| Parent Store ID | `rileyehrlic0b-20` |
| Website tracking ID | `goose-gifts-37-20` |
| Current public site | `https://stupid.gifts` |
| Reports | `https://affiliate-program.amazon.com/p/reporting/earnings` |

Verified again in the signed-in in-app browser: this exact tracking ID is listed
under the correct parent, and Amazon reports credited clicks against it. The
live chicken-vase destination uses the same tag. Private numerical evidence is
`~/.codex/private/goose-gifts-migration/affiliate-report-20261104.json`.

Select the **parent store at the top of the page first**, then filter Tracking
ID to `goose-gifts-37-20`, select the intended dates, and view **Commissions**.
The separate `onamzrileyehr-20` store and its `goose-gifts-20` tag are not this
website's reporting scope. Do not rename/switch the live tag merely to match the
new brand, or mix all-store revenue with website attribution. Never retain an
authenticated sign-in URL as the report link.

Routine care supplies the canonical tag in `scripts/catalog/daily-operator.mjs`'s
`catalog.associateTag`; provider URL validation consumes that value. Saved runs
pin it immutably. Keep every published retailer destination consistent with it.
Historical Vercel environment instructions below are not the current writer.

Ordered items normally update hourly, most within three hours; earnings are
reported through the previous day and depend on shipments. Dashes/suppressed
low-volume metrics are not a verified numeric zero. Recorded clicks prove tag
credit, not a qualifying purchase or eventual commission.

The sections below are dated historical evidence, not current account-access or
deployment instructions. The November 4 reference above supersedes their old
access gates and Vercel configuration path.

## October 19 launch review

Fresh Vercel Production configuration supplies `goose-gifts-37-20`. A read-only
audit of all **3,383** Amazon rows found zero invalid HTTPS Amazon hosts,
missing/duplicate/foreign tags, or ASIN-path mismatches. Live random and three
sitemap-listed product pages exposed the same tag. Homepage/directory link
internally to product pages; no direct retailer anchors there were counted as
verified clicks. No database updates or artificial test purchases occurred.

The previously documented parent Store ID is `rileyehrlic0b-20`; that is
persisted evidence, not a new account-side verification. Current Chrome 37
shows `mikeideas-20`, and Personal is signed out. Neither establishes access to
the intended wife's store. Cameron explicitly deferred signing into the correct
account, verifying tracking-ID membership, adding `https://stupid.gifts` while
retaining Goose URLs, and reviewing tag-scoped reports until the final
pre-launch gate. See `roadmap-lbbz1.8` and
[the launch checklist](STUPID_GIFTS_LAUNCH_SPEC.md#provider-and-automation-cutover-checklist).
No Amazon account configuration changed.

Valid URLs prove technical consistency, not recorded clicks or credited
commissions. Do not call sales attribution verified until the relevant official
report supports it. Public pricing is optional and must pass the launch spec's
source/rights/expiry requirements; SerpApi is not an approved-price substitute.

The following August snapshot remains historical context, not current counts
or current browser access.

## August historical production path (retired)

- All 3,363 catalog products are Amazon products; 3,343 are active.
- Amazon Creators API is the sole Amazon product-data path. It uses OAuth 2.0
  credentials and supports `SearchItems` discovery plus `GetItems` enrichment
  and stale-product revalidation.
- Amazon requests and stored product links use the dedicated Associates tracking
  ID `goose-gifts-37-20` through `AMAZON_ASSOCIATE_TAG`. The Creators API
  application remains attached to the parent Store ID `rileyehrlic0b-20`.
- The production environment is the source of truth for `AMAZON_ASSOCIATE_TAG`.
  The weekly catalog automation refreshes its local environment from Vercel,
  and its revalidation phase audits and repairs every stored Amazon URL before
  fetching products. To change tracking IDs, update the Vercel variable once;
  the next weekly run will rewrite existing links, or run
  `npm run catalog:repair-affiliate-urls` after refreshing `.env.local` for an
  immediate repair.
- The 2026-08-10 production audit found 3,363 correctly tagged URLs and zero
  foreign tags, missing tags, malformed URLs, or ASIN/path mismatches. Live
  homepage, random-gift, and catalog HTML exposed only `goose-gifts-37-20`.
- Google CSE is optional discovery-only resilience. CSE metadata is never
  recorded as Amazon price, availability, or freshness verification.
- Amazon product APIs do not expose the Associates
  earnings, orders, shipped revenue, or commission reports needed for EPC
  optimization.

## August reporting-access snapshot (superseded above)

Amazon provides orders and earnings through Associates Central reports and
manual CSV/XLSX/XML downloads. There is no configured API credential for those
reports, and neither the in-app browser nor Chrome had an authenticated
Associates Central session during this audit.

This is an operational limitation, not a standing owner task. Keep optimizing
against attributable outbound clicks. Reopen revenue ingestion only if Amazon
adds a supported reporting API or a report export is deliberately provided.

References:
- https://affiliate-program.amazon.com/help/node/topic/GMWAK55DQX8JEK7C
- https://affiliate-program.amazon.com/help/node/topic/GQ5FS7J76MT59WLW

## Awin

Awin supports publisher transaction reporting through a Bearer token and
publisher ID. Neither `AWIN_API_TOKEN` nor `AWIN_PUBLISHER_ID` exists in the
production environment, Keychain, or the local operator config stores. The
production catalog currently contains no Etsy/Awin products, so Awin reporting
would not explain current goose.gifts revenue.

Do not list Awin access as an owner blocker until goose.gifts deliberately
joins/configures an Awin publisher account and begins serving Awin affiliate
links.

References:
- https://help.awin.com/apidocs/api-authentication
- https://success.awin.com/articles/en_US/Knowledge/Publisher-API-GET-transactions-list
