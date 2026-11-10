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

The Matan assortment, in order:

- Bullshit button — an immediate debate/heckling prop.
- Top Banana award trophy — an absurd award-show callback.
- Grow a girlfriend — a tiny novelty toy, not a claim about anyone's private life.
- Donald socks with hair — a visual combable-hair gag.
- Pop-up finger box — a surprise response to an argument.
- "Hey, you dropped this" brain pillow — an internet-debate prop.
- Emotional-support chicken nuggets — a soft landing after the roast.
- Circular-saw pizza cutter — an oversized-seriousness joke for ordinary pizza.
- Wiener-switch lamp — an existing catalog identity, not a duplicate admission.
- Solar peeing dog — the exact owner-approved campaign ASIN B0FMXQJW2V.
- Magnetic desk goose — the exact owner-approved campaign ASIN B0H2TW8LZ9.
- Seagull reading "Pooping on People" — exact 8×10 print B0HDRTSB19.

These four additions bring Matan to twelve picks. The flapping catnip duck
B0B3XCGVJB is approved for the main catalog only, not this filming lineup.

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

`static-site/lib/show-rehearsal.ts` owns the named `SHOW_PRESETS` (ordered
canonical slugs or exact ASINs only) and one `ACTIVE_SHOW_PRESET` for `/h`. To add a guest,
add a new named array, retain existing arrays, review it and change the active
key if needed. The saved route is generated automatically; there is no CMS,
database table, new scheduled job or copied product asset. Resolve
against the current public catalog. Never silently substitute unreviewed gifts.
Use the same short title/description as every other card and product page;
there are no show-only copy overrides. Photos and tagged merchant links use the
normal catalog components and retain their original content deadlines.

Change the shortlist through the ordinary reviewed serving release, preserving
the accepted catalog, D1 receipt, homepage edition, semantic index and all
history. The existing GitHub daily coordinator follows merged main, so a later
refresh keeps the saved editions and current active choice. No extra merchant
batch or model generation is necessary for this existing-catalog selection.

Creator Connections research in the authorized website account checked cowboy,
mullet, horse-mask and guitar searches. The reviewed visible results were
mostly ordinary clothing/equipment, or fully claimed offers. None was selected
over the stronger existing visual jokes, and no campaign was joined. Higher
commission is not a reason to weaken this on-camera selection. Potential new
products still use the normal admission pipeline, not ad hoc public records.

Verify twelve Matan/eight Billy Ray cards before hydration, loaded photos, mobile layout,
product navigation, canonical tagged links and Back. Pinch zoom stays enabled.
Owner review of the actual page precedes any message to Howie; this work does
not send him a link automatically.
