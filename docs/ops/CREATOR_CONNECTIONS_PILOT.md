# Stupid Gifts — Higher-commission gift pilot

Status: proposal for owner review, November 5, 2026. This PR changes no site behavior, joins no campaigns and authorizes no spending.

## Recommendation

- **Funny first, commission second.** Try three to five genuinely good gag gifts with verified Creator Connections bonuses. A high rate cannot rescue a boring product.
- Start on the homepage, using **up to two of the existing eighteen daily discovery positions**, only when the products deserve them. Keep the six weekly highlights and the rest of the mix intact. This is a small pilot, not a permanent quota or a new carousel.
- **Leave search ranking unchanged initially.** Later, consider commission only as a tie-break between equally relevant, equally good results—not as a reason to return the wrong gift.

## What the research establishes

- Amazon includes publishers/bloggers, but bonuses require qualifying campaign sales. Dates, funding, variation and seller matter. [Amazon overview](https://advertising.amazon.com/help/GPARAL6JVGFEJKG2).
- Verify website/link eligibility and each campaign's content/disclosure requirements. [Amazon campaign guidance](https://advertising.amazon.com/help/GMANECFAFD49W23Y).
- Creator Product Research already saves ASINs, account-scoped campaigns, rates, dates and exclusions. Reuse these—not its **influencer-video earnings forecast** for website revenue.
- Its research account differs from the website account, and recent unattended source research is blocked by browser access. Saved leads are useful; fresh eligibility and accepted website campaigns are not yet established.

## Small implementation, after approval

- **Shortlist:** match saved campaign leads against our catalog and clicked favorites. Review a few new gag gifts too. Preserve exclusions and deduplicate families; skip off-brand commodities regardless of rate.
- **Verify and join:** check exact ASIN/variation, seller, bonus, dates/funding, enrollment and website requirements in the website account. Obtain owner approval before joining. Leave the separate research profile untouched.
- **One private JSON handoff:** ASIN/catalog ID, campaign reference, opaque account scope, separate base/bonus rates, observation/expiry, enrollment proof and obligations. No credentials, raw pages, shared database or live cross-repository dependency.
- **Reuse publishing:** admit/enrich only selected gifts through normal catalog care, including both indexes. Give the existing [homepage editor](HOMEPAGE_EDITOR.md) the shortlist. No new scheduler, per-visitor model or compulsory article.
- **Verify links/disclosures:** retain the canonical website tag and test the actual Amazon landing URL. Any campaign-specific link/tag change requires review; never substitute the research account's tag. Add campaign-required disclosures.
- **Graceful expiry:** an ended, exhausted, unverified or ineligible campaign loses preference—not its product listing. Ordinary affiliate links, history and search remain available.
- **Measure for two weeks:** reuse daily reporting for product clicks, CTR where measured, campaign orders and realized bonus earnings. Prefer earnings per outbound click to advertised commission. Separate base/bonus and mixed-channel results where possible; suppressed or lagged figures are unknown. Extend the observation window if volume is low.

## Reuse and acceptance checks

- Reuse `read-opportunity-pool.ts`, `creator-connections-observations.ts` and `contracts/creator-connections.ts` in `37-Inc/creator-product-research`. Add a thin read-only export; current `pool` output alone lacks the complete handoff. Do not transplant uncommitted research changes.
- Test wrong-account, card-only and expired evidence; campaign expiry preserves listings; intended tags survive; search and `/h` remain unchanged; homepage retains 24 pictured, described gifts.
- Defer automatic campaign acceptance, broad catalog backfills, search boosts and hosted research. First prove that a few worthwhile gifts actually earn the bonus through this website.
