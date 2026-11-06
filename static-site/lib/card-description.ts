import { productShortDescription } from '../../lib/catalog/presentation';
export const LEGACY_DESCRIPTION_PLACEHOLDER = "A strange little catalog find.";

/** Site-authored presentation only. Retain the original catalog/native inputs,
 * prefer genuinely refreshed copy, and never reuse a note for a changed item. */
export function factualCardDescription(input: {
  source: string; id: string; title?: string; description?: string;
}): string | undefined {
  return productShortDescription({...input,title:input.title || input.id});
}
