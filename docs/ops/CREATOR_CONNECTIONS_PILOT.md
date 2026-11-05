# Stupid Gifts — Higher-commission gift pilot

Status: proposal for owner review, November 5, 2026. This PR changes no site behavior, joins no campaigns and authorizes no spending.

## Recommendation

- **Funny first, commission second.** Try three to five genuinely good gag gifts with verified Creator Connections bonuses. A high rate cannot rescue a boring product.
- Start on the homepage, using **up to two of the existing eighteen daily discovery positions**, only when the products deserve them. Keep the six weekly highlights and the rest of the mix intact. This is a small pilot, not a permanent quota or a new carousel.
- **Leave search ranking unchanged initially.** Later, consider commission only as a tie-break between equally relevant, equally good results—not as a reason to return the wrong gift.
- **Our candidate rule is just:** worthwhile gag gift + positive, attractive commission + an open Creator Connections campaign we can join. Compare rates among good gifts; no invented minimum commission or earnings threshold.

## What the research establishes

- Amazon includes publishers/bloggers, but bonuses require qualifying campaign sales. Dates, funding, variation and seller matter. [Amazon overview](https://advertising.amazon.com/help/GPARAL6JVGFEJKG2).
- Verify website/link eligibility and each campaign's content/disclosure requirements. [Amazon campaign guidance](https://advertising.amazon.com/help/GMANECFAFD49W23Y).
- Creator Product Research already saves ASINs, account-scoped campaigns, rates, dates and exclusions. Reuse these—not its **influencer-video earnings forecast** for website revenue.
- Code review confirms its `assessCampaignOpportunity` also requires a purchase verdict, fresh price, video-count proof and a 50-video limit; its pool/discovery-lead ordering uses sales and video competition. **Do not call that qualifier or use its top-ranked/qualified-only export for this site.** Read the complete saved campaign inventory/observations before filtering, then select by gag-gift fit, open enrollment and commission. Missing/low sales, many/unknown videos, carousel placement, product purchase cost, payback and a failed video-calculator verdict must neither exclude nor demote a website candidate. No Jungle Scout/ViralVue/Keepa enrichment is needed for this shortlist.
- Its research account differs from the website account, and recent unattended source research is blocked by browser access. Saved leads are useful; fresh eligibility and accepted website campaigns are not yet established.

## Small implementation, after approval

- **Shortlist:** match the complete campaign inventory against our catalog and clicked favorites. Review a few new gag gifts too. Preserve website duplicate/editorial exclusions and explicit owner rejections, but not automatic video-economics rejections. Deduplicate families; skip off-brand commodities regardless of rate.
- **Verify and join:** check exact ASIN/variation, seller, bonus, dates/funding, enrollment and website requirements in the website account. Obtain owner approval before joining. Leave the separate research profile untouched.
- **One private JSON handoff:** ASIN/catalog ID, campaign reference, opaque account scope, separate base/bonus rates, observation/expiry, enrollment proof and obligations. No credentials, raw pages, shared database or live cross-repository dependency.
- **Reuse publishing:** admit/enrich only selected gifts through normal catalog care, including both indexes. Give the existing [homepage editor](HOMEPAGE_EDITOR.md) the shortlist. No new scheduler, per-visitor model or compulsory article.
- **Verify links/disclosures:** retain the canonical website tag and test the actual Amazon landing URL. Any campaign-specific link/tag change requires review; never substitute the research account's tag. Add campaign-required disclosures.
- **Graceful expiry:** an ended, exhausted, unverified or ineligible campaign loses preference—not its product listing. Ordinary affiliate links, history and search remain available.
- **Measure for two weeks:** reuse daily reporting for product clicks, CTR where measured, campaign orders and realized bonus earnings. Prefer earnings per outbound click to advertised commission. Separate base/bonus and mixed-channel results where possible; suppressed or lagged figures are unknown. Extend the observation window if volume is low.

## Reuse and acceptance checks

- Reuse account-scoped inventory/observations and the contracts in `src/application/creator-connections-observations.ts` and `src/contracts/creator-connections.ts` in `37-Inc/creator-product-research`. Add a thin read-only campaign-facts export, not a new calculator. Its current `pool`/`discovery-leads` ranking is not our selection policy. Do not transplant uncommitted research changes.
- Test wrong-account, card-only and expired evidence; campaign expiry preserves listings; intended tags survive; search and `/h` remain unchanged; homepage retains 24 pictured, described gifts.
- Regression fixtures must keep an otherwise suitable open-campaign gift eligible with zero/unknown monthly sales, 100/unknown influencer videos, missing video placement or a failed creator purchase verdict. A high-rate boring product still fails editorial selection; a closed/full campaign cannot be presented as joinable. Card-only or stale evidence remains a research lead, not a proven open offer.
- Defer automatic campaign acceptance, broad catalog backfills, search boosts and hosted research. First prove that a few worthwhile gifts actually earn the bonus through this website.
