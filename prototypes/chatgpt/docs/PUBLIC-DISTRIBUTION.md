# Stupid Gifts — public distribution decision

Checked November 6, 2026. **Recommendation: prepare a small first-party-media, general-audience physical-gift cohort; keep public activation gated until evidence exists.** This is a source-grounded engineering recommendation, not a declaration of legal clearance.

## Decision and evidence

Use original photographs owned by the publisher (of already available physical products) or a separate written supplier/photo license expressly covering the intended ChatGPT/mobile display. Pair these with original factual copy and the existing Stupid Gifts detail-page links. Do not purchase products, contact rights holders, change affiliate-account settings or publish without the required authorization. Do not rehost retailer photos merely to change their domain.

Current Amazon Program Content permissions are limited. The IP License ties content use to relevant Amazon destinations, includes mobile-use approval restrictions and limits image-link/content caching. The current widget loads Amazon-hosted photos but opens a Stupid Gifts intermediary page. That mismatch needs a documented permission/provenance resolution before public distribution; a working website or private tunnel is not clearance. [Amazon Program Policies, IP License §§1 and 3](https://affiliate-program.amazon.com/help/operating/policies).

Amazon's agreement also requires an Associate disclosure and accurate identification of authorized sites. Preserve the current retailer-page disclosure and resolve how disclosure applies to the ChatGPT presentation without assuming that hiding it until the website is sufficient. [Amazon Operating Agreement §§1 and 5](https://affiliate-program.amazon.com/help/operating/agreement).

Etsy API access is not a blanket photo license: member content remains member-owned, applications need approved purposes, and API listing content has freshness rules. Audit each Etsy asset's origin and permission independently before enabling it in the public cohort. [Etsy API Terms §§3 and 5](https://www.etsy.com/legal/api/).

OpenAI requires authorized content, genuine standalone utility and general-audience suitability, including ages 13–17. The affiliate flow must be reviewed against commerce/advertising rules; directory approval is not established by this memo. [OpenAI Plugin Guidelines](https://developers.openai.com/plugins/plugin-guidelines).

## Proposed first cohort

Start rights review with the six identities below. They are **candidates, not cleared or approved products**. The public URLs were observed in current site output or the November6 local MCP receipt. Titles are identifying labels; each actual variant, photo and copy still needs inspection. None is certified safe for children.

| Candidate | Why it fits the initial scope | Identity evidence | Current release status |
| --- | --- | --- | --- |
| Cat socks | A straightforward physical gift for cat interests, with non-explicit copy. | /gifts/purrfectly-funny-cat-socks-for-dad (public ID 7340f78a-83b8-40d9-88c0-332bc9a9c65c) | Hold: media rights and actual design unverified. |
| Medieval cat tapestry | Covers cat/home interests without a price or adult-humor claim. | /gifts/medieval-cat-tastic-tapestry-a-purrfectly-quirky-decor (public ID e4dec59b-bc3b-4c23-ac6f-b225049b69f7) | Hold: media rights and print design unverified. |
| Crab spoon rest | Clear unusual-kitchen use; avoid heat-resistance claims. | /gifts/crab-tacular-spoon-rest-stay-claw-some-in-the-kitchen | Hold: media rights and variant identity unverified. |
| Screaming goat | A distinct desk novelty; avoid therapy claims or encouraging unwanted pranks. | /gifts/screaming-goat-a-desk-toy-for-loud-laughter | Hold: media rights, sound/context and variant identity unverified. |
| Grumpy frog | A simple desk/shelf object with neutral expression-based humor. | /gifts/grumpy-frog-not-happy-but-here-to-stay | Hold: exact public ID, variant and media rights unverified. |
| Chicken-leg socks | Visual novelty suitable for original product photography and factual copy. | /gifts/cluck-yeah-chicken-leg-socks-for-poultry-lovers | Hold: exact public ID, variant and media rights unverified. |

This shortlist yields **zero cleared items today**. Resolve exact IDs for all candidates, collect evidence, then test whether the cleared set supplies useful interest coverage. If it does not, expand the same reviewed process rather than silently falling back to the whole catalog. Historical no-repeat promises must remain conditional on available eligible choices.

The production candidate now supports a fail-closed approval flag plus a bounded ID/digest list. After a product is actually approved, resolve fresh public facts and use the runtime’s giftApprovalDigest() function; do not synthesize a digest or treat inclusion as legal evidence. The digest binds the displayed identity/copy/tags/canonical URL/photo URL; changing those fields no longer matches. It does not hash photo bytes fetched later at an unchanged URL. Use immutable content-addressed owned media or an independently verified image-byte record for asset identity. Never commit private signed licenses, personal names, private source paths or account details to this public repository; retain secure evidence separately and use a non-sensitive reference/hash in the release record.

For each admitted product record: stable public ID and exact variant; original image hash/source file or written license and its scope; copy provenance; inspection date and reviewer; general-audience/physical-good decision; canonical page and current retailer destination; freshness deadline; explicit approval. A withdrawn or missing proof should exclude the item. External photo-host allowlists are transport controls, not rights records.

The initial public cohort should exclude sexual/adult imagery, explicit profanity, intoxicants or smoking products, weapons, medical-treatment claims, digital products/subscriptions and unsafe or deceptive prank framing. Review the image as well as tags/title; tags alone cannot establish suitability. This is a conservative first-release selection rule, not a claim that every excluded item is universally prohibited.

## Owner decision

Recommended path: authorize a first-party-media pilot from existing available products, or supply explicit licenses covering these uses. Alternative: seek written retailer approval for the exact current distribution/link flow. Until one path is supported, finish code and materials but keep public catalog activation gated. No requests have been sent and no purchases made.
