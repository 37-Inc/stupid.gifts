/** Offline, deterministic migration of accepted presentation; never fetches,
 * generates copy, changes source records, or decides catalog membership. */
export function backfillPresentation(snapshot, homepage, notes) {
  const products = snapshot.products.map(p => p.persistent ?? p);
  const entries = Object.fromEntries(products.filter(p => p.source === 'amazon').map(p => {
    const factual = notes[p.id]?.title === p.title ? notes[p.id].description : undefined;
    const description = homepage.cardNotes?.[p.id] || homepage.descriptions?.[p.id]
      || (p.description === 'A strange little catalog find.' ? factual : undefined) || p.description;
    if (!description?.trim()) throw Error('presentation_missing_short_copy:' + p.id);
    const sourceCopy=p.wittyDescription?.trim() || p.description;
    return [p.id, { sourceTitle:p.title, sourceCopy,
      ...(sourceCopy!==p.description?{sourceDescription:p.description}:{}),
      description, ...(homepage.cardTitles?.[p.id] ? {title:homepage.cardTitles[p.id]} : {}) }];
  }));
  if (entries.B0BYJ6QF8S) entries.B0BYJ6QF8S = { ...entries.B0BYJ6QF8S,
    title:'Telescopic insect-catching nets',
    description:'Six extendable mesh nets for outdoor bug-catching and fishing.', repairedSemanticCopy:true };
  if (entries.B0757WW6KB) entries.B0757WW6KB.description = "A prank gift box styled as a child's first fire-starting kit.";
  // Correct existing description values already ARE the canonical field. Store
  // only the legacy corrections; don't duplicate a second full catalog in Git.
  return Object.fromEntries(Object.entries(entries).filter(([id,review])=>{
    const original=products.find(p=>p.id===id);
    return review.description!==original.description || review.title && review.title!==original.title || review.repairedSemanticCopy;
  }));
}
