# Stupid Gifts — Creator Connections integration notes

Owner-approved PR350 implementation, November5,2026. See
[One product view, better discovery](CATALOG_QUALITY_AND_MERCHANDISING.md) and
[the manual-digest contract](CAMPAIGN_DIGEST.md). Accepted campaigns and bonus
earnings remain separate from implementation/notification acceptance.

## The candidate rule

- Worthwhile gag gift + attractive positive commission + an open campaign the website account can join. No invented minimum rate, monthly-sales threshold or purchase/payback requirement.
- Creator Product Research's `assessCampaignOpportunity` requires purchase economics, fresh price, video-count proof and a 50-video limit. Its pool/lead ordering also uses sales and video competition. **Bypass those qualifiers and rankings for this site.** Read the complete saved campaign inventory/observations instead.
- Missing sales, 100/unknown videos, missing carousel placement or a failed video-calculator verdict must not exclude/demote an otherwise suitable website candidate. No Jungle Scout/ViralVue/Keepa enrichment is required. Preserve explicit owner/website editorial/duplicate exclusions, not automatic video-economics rejections.

## Reuse facts, not the calculator

- Reuse account-scoped inventory and `src/application/creator-connections-observations.ts` / `src/contracts/creator-connections.ts` in `37-Inc/creator-product-research`. Add a thin read-only campaign-facts export; no shared SQLite, credentials or live runtime dependency. Do not transplant unrelated uncommitted research changes.
- Private handoff: exact ASIN/catalog ID, campaign reference, opaque account scope, separate base/bonus rates, observation/expiry, enrollment proof and obligations. Card-only/stale evidence is a lead, not a proven joinable offer.
- The research account differs from the website account. Verify website-account eligibility, ASIN/variation, seller, dates/funding and content/link requirements; get owner approval before enrollment. An open campaign is not accepted participation, and full enrollment does not necessarily disqualify an existing participant.
- Retain the canonical website tag and disclosures. Review any explicitly required campaign link/tag change; never silently substitute the research account's tag. No public prices or commission claims in this work.
- An ended/exhausted/unverified campaign loses its ranking preference, not its listing. No guaranteed campaign slots. Measure actual bonus earnings, not an influencer-video forecast; mixed-channel, lagged and suppressed reports remain unknown where attribution is unavailable.
- Maintain a saved pending-join queue and notify Cameron of new/changed actionable offers through the existing daily task's Slack digest (thread fallback if unavailable). Include the exact campaign link, product, rate, deadline and account scope; deduplicate unchanged notices. Cameron joins manually. Verify accepted participation afterward before awarding ranking preference; never treat notification/acknowledgement as enrollment. No new timer, automatic joining or callback server is needed.

## Evidence and boundaries

- Amazon includes publishers/bloggers but bonuses apply only to qualifying campaign sales: [program overview](https://advertising.amazon.com/help/GPARAL6JVGFEJKG2). Campaign content/disclosure requirements can vary: [campaign guidance](https://advertising.amazon.com/help/GMANECFAFD49W23Y).
- Current research handoff reports source-browser access failures. Saved leads are reusable, but fresh unattended collection and any specific accepted website campaign remain unproven. Keep browser-dependent work outside the site's publication dependency chain.
- The owner's subsequent request authorizes implementation/deployment and the existing-task manual Slack digest. Automatic enrollment is prohibited; hosted research, public prices and new provider plans remain deferred.
