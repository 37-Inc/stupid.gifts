# Stupid Gifts — Instant show shortlist

Owner direction, November 6: Howie opens `/h` on his phone, chooses a gift and
shows its photo to the camera. The page renders the actual curated gifts
immediately, including without JavaScript. It looks like the regular storefront:
same heading, search bar and shared cards, with no guest-specific label. Search
runs only on Search/Enter; Clear and Back restore the shortlist on `/h`.
There is no fake search match or reveal gate.

## Saved filming lineups

`/h` now opens the Matan edition. `/h/matan` is its stable saved URL.
Billy Ray's exact original order is preserved at `/h/billy-ray`; a postponed
filming can use that link immediately, without changing production again.
All three pages look like the regular storefront, with no guest label. Each
saved URL keeps its own assortment when Search/Enter, Clear and Back are used.
They are unlisted/noindex and are not included in the sitemap.

The current assortment and order are read from GET
`/api/content-admin/collections/matan`; do not use a copied prose list as a second
source of truth. The compiled `SHOW_PRESETS` retains the original twelve-ID
fallback, and runtime revisions retain later owner-approved changes. The flapping
catnip duck B0B3XCGVJB is site-only, not part of this filming lineup.

The visual review used existing catalog photos/copy; no supplier or model batch
was needed. Selection references Matan Even's public absurdist/prank persona
and award-show appearance, not claims about his beliefs, identity or sex life.
Research: <https://en.wikipedia.org/wiki/Matan_Even>.

The archived Billy Ray assortment, in order:

- Cowboy cat pillow cover — a cat in a cowboy hat riding a horse.
- Chicken-leg socks — a visual alternative to cowboy boots.
- Guitar cutting board — an instrument for the kitchen.
- Drinking rooster wine holder — a bird holding a bottle upside down.
- Tortilla blanket — wrap yourself into a burrito.
- Raccoon dumpster-fire desk organizer — a very small workplace disaster.
- Desktop boxing set — a miniature punching bag and tiny gloves.
- Lobster claw oven mitts — another immediately recognizable visual joke.

These are editorial rationales, not claims about the guest's interests,
purchases, endorsement or a confirmed appearance. The private rehearsal stays
unlisted/noindex; it is not an episode archive or an acquisition search page.
The goat, fortune-telling pickle and raw chicken vase were already shown and
are intentionally absent from both editions. Previous picks remain in Git history.

Use the existing [content admin API](CONTENT_ADMIN.md) to PUT an ID-only named
collection and, if needed, PUT `/active-show`. Both apply through the shared
runtime revision service without an app build, supplier call or extra job.
Use `/collections/<name>/restore` to append a prior edition as a new revision;
never overwrite its history. `static-site/lib/show-rehearsal.ts` retains compiled
defaults for old lineups, not an additional editing workflow. Runtime collections
take precedence and resolve against the current public catalog. Never silently
substitute unreviewed gifts.
Use the same short title/description as every other card and product page;
there are no show-only copy overrides. Photos and tagged merchant links use the
normal catalog components and retain their original content deadlines.

Collection edits preserve the accepted catalog receipt, homepage edition,
semantic index and archived guest lineups. The next daily refresh retains these
runtime revisions. No merchant batch or model generation is necessary to reorder
existing products. New products use the exact-ASIN admission queue; they are not
hard-coded cards, direct merchant-only links or special daily-job exceptions.

The old filming-only endpoint and its separate client cards are retired. The
owner-requested conversions are B01DVUSR1Y and B0DK82DBDG, tracked in `.34`.
The preview observations expired November 11 at 20:20 UTC, and the live endpoint
was verified empty November 12. Removing that expired code is independent of
the still-queued canonical admissions; it does not claim those products are live.
Only after genuine admission may their canonical public IDs lead Matan's runtime
collection. Do not copy the expired preview photo/title records or renew their
old deadlines. Normal catalog cards, pages, availability and photo refresh apply.

Creator Connections research in the authorized website account checked cowboy,
mullet, horse-mask and guitar searches. The reviewed visible results were
mostly ordinary clothing/equipment, or fully claimed offers. None was selected
over the stronger existing visual jokes, and no campaign was joined. Higher
commission is not a reason to weaken this on-camera selection. Potential new
products still use the normal admission pipeline, not ad hoc public records.

Verify the saved Matan order and preserved eight-ID Billy Ray collection before hydration, loaded photos, mobile layout,
product navigation, canonical tagged links and Back. Pinch zoom stays enabled.
Owner review of the actual page precedes any message to Howie; this work does
not send him a link automatically.

## Fast existing-product lineups

After this serving upgrade is accepted, `/h?ids=<public-UUID>,<public-UUID>`
opens an ordered custom assortment of up to 24 already-public gifts (the existing
feed-card response batch size) without
another build, model call, catalog mutation or campaign enrollment. Named guest
routes support the same parameter. Normal search still uses `q`; Clear restores
the custom assortment. Invalid/unavailable custom lineups show a recovery link,
never briefly show the wrong saved picks. Without JavaScript the saved picks
remain available with an explicit notice. Billy Ray's archived default is unchanged.
New products still require normal admission before public-ID lookup can show them.
