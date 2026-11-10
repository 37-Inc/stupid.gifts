import { notFound } from "next/navigation";
import { isFixtureRelease } from "../../../lib/catalog";
import { previewMetadata } from "../../../lib/metadata";
import { isShowPreset, SHOW_PRESET_KEYS } from "../../../lib/show-rehearsal";
import { ShowShortlist } from "../../../components/ShowShortlist";

export const dynamicParams = false;
export function generateStaticParams() {
  return SHOW_PRESET_KEYS.map((preset) => ({ preset }));
}

export async function generateMetadata({ params }: { params: Promise<{ preset: string }> }) {
  const { preset } = await params;
  if (!isShowPreset(preset)) notFound();
  return previewMetadata("Stupid gifts. Excellent taste.",
    "A hand-picked assortment of unusual gifts.", `/h/${preset}`,
    { indexable: false, fixture: isFixtureRelease });
}

export default async function SavedShowPicksPage({ params }: { params: Promise<{ preset: string }> }) {
  const { preset } = await params;
  if (!isShowPreset(preset)) notFound();
  return <ShowShortlist preset={preset} action={`/h/${preset}`} />;
}
