export const SITE_NAME = 'goose.gifts';
export const DEFAULT_SITE_URL = 'https://www.goose.gifts';
export const PUBLIC_CONTACT_EMAIL = 'stupidgifts@37.technology';

export function getSiteUrl(): string {
  const configuredUrl = (process.env.NEXT_PUBLIC_BASE_URL || DEFAULT_SITE_URL).replace(/\/$/, '');

  try {
    const url = new URL(configuredUrl);

    if (url.hostname === 'goose.gifts') {
      url.hostname = 'www.goose.gifts';
    }

    return url.origin;
  } catch {
    return DEFAULT_SITE_URL;
  }
}

export function absoluteUrl(path: string = '/'): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${getSiteUrl()}${normalizedPath === '/' ? '' : normalizedPath}`;
}
