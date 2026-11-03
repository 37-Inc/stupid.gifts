import type { HomepageEdition } from './homepage-edition.ts';
import type { Product } from '../types.ts';
import type { SemanticCatalog } from './semantic-profile.ts';

/** Public artifacts are price-free until a separately verified offer lane exists. */
export interface PublicCatalogProduct extends Pick<Product,
  'id' | 'title' | 'imageUrl' | 'affiliateUrl' | 'source' | 'currency'> {
  description: string;
  publicId: string;
  slug: string;
  price: 0;
  isActive: true;
  qualityScore: number;
  /** Supplier-display deadline; null is only for independently cleared fields. */
  eligibleUntil: string | null;
  indexable?: boolean;
  /** One independently cleared view, never another supplier-data lease. */
  persistent?: PersistentCatalogProduct;
  punnyTitle?: string;
  wittyDescription?: string;
  editorialWriteup?: string;
  humorTags?: string[];
}

export type PersistentCatalogProduct = Omit<PublicCatalogProduct, 'eligibleUntil' | 'persistent'>
  & { eligibleUntil: null; indexable: boolean };

export type HeldReason = 'inactive' | 'duplicate' | 'editorial_hold' | 'expired' | 'rights_unverified';
export interface SafeHeldProduct {
  id: string;
  publicId: string;
  slug: string;
  path: string;
  title: 'Gift currently unavailable';
  description: 'This gift is not currently available in the curated catalog. Browse other gifts instead.';
  reason: HeldReason;
  affiliateUrl?: string;
}

export interface CatalogSlugHistory { slug: string; canonicalSlug: string; publicId: string }
export interface CatalogSnapshot {
  schemaVersion: 1;
  dataKind: 'catalog' | 'synthetic_fixture';
  catalogRevision: string;
  generatedAt: string;
  products: PublicCatalogProduct[];
  heldProducts: SafeHeldProduct[];
  slugHistory: CatalogSlugHistory[];
}

export interface CatalogAssetRoute {
  assetPath: string;
  safeAssetPath: string;
  eligibleUntil: string | null;
  state: 'ready' | 'held';
  indexable?: boolean;
  /** Explicit positive clearance of the route-specific safe variant. */
  persistentIndexable?: boolean;
  /** Fixed overlap deadline from first retirement capture; never renewed. */
  retainedUntil?: string;
}
export interface SiteAssetManifest extends CatalogReleaseManifest {
  homepage?: HomepageEdition;
  /** Optional compiled proof, hash-bound by this release manifest; not supplier expiry. */
  semanticCatalog?: SemanticCatalog;
  dataKind: CatalogSnapshot['dataKind'];
  routes: Record<string, CatalogAssetRoute>;
  retention: { priorManifestSha256: string; currentAssetPaths: string[] } | null;
  /** Exact duplicate RSC bodies share a file; their original URL policies remain. */
  assetAliases?: Record<string, string>;
}

export interface CatalogReleaseManifest {
  schemaVersion: 1;
  sourceMode: CatalogSiteSourceMode;
  siteIdentitySha256: string;
  releaseId: string;
  codeSha: string;
  catalogRevision: string;
  catalogSnapshotSha256: string;
  generatedAt: string;
  nextExpiry: string | null;
  productCount: number;
  slugCount: number;
  vectorSyncWatermark: number;
  priorReleaseId: string | null;
  checksums: Record<string, string>;
}
export type CatalogSiteSourceMode = 'preview' | 'goose-production' | 'stupid-production';

export type DisplayField = 'title' | 'description' | 'imageUrl' | 'affiliateUrl'
  | 'punnyTitle' | 'wittyDescription' | 'editorialWriteup' | 'humorTags';
/** Private evidence. A grant applies to one exact value, never an entire row. */
export interface ContentRight {
  basis: 'owned' | 'licensed' | 'merchant';
  reference: string;
  value: string;
  observedAt?: string;
  expiresAt?: string;
}
export type DisplayRights = Partial<Record<DisplayField, ContentRight>>;
export type ProductRights = DisplayRights & { persistent?: DisplayRights };
export type SnapshotProductInput = Product & { description?: string; publicId: string; slug: string };
export interface PersistentProductInput {
  product: SnapshotProductInput;
  rights: DisplayRights;
}
