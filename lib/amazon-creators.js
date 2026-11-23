const CREATORS_API_BASE_URL = 'https://creatorsapi.amazon/catalog/v1';
const TOKEN_ENDPOINTS = {
  '2.1': 'https://creatorsapi.auth.us-east-1.amazoncognito.com/oauth2/token',
  '2.2': 'https://creatorsapi.auth.eu-south-2.amazoncognito.com/oauth2/token',
  '2.3': 'https://creatorsapi.auth.us-west-2.amazoncognito.com/oauth2/token',
  '3.1': 'https://api.amazon.com/auth/o2/token',
  '3.2': 'https://api.amazon.co.uk/auth/o2/token',
  '3.3': 'https://api.amazon.co.jp/auth/o2/token',
};

const PRODUCT_RESOURCES = [
  'images.primary.large',
  'images.primary.medium',
  'itemInfo.byLineInfo',
  'itemInfo.classifications',
  'itemInfo.contentInfo',
  'itemInfo.features',
  'itemInfo.productInfo',
  'itemInfo.technicalInfo',
  'itemInfo.title',
  'offersV2.listings.availability',
  'offersV2.listings.condition',
  'offersV2.listings.price',
  'parentASIN',
  'customerReviews.starRating',
  'customerReviews.count',
];

let tokenCache = null;
let tokenRequest = null;

class AmazonCreatorsApiError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = 'AmazonCreatorsApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

function getConfig(env = process.env) {
  const credentialId = env.AMAZON_CREATORS_CREDENTIAL_ID;
  const credentialSecret = env.AMAZON_CREATORS_CREDENTIAL_SECRET;
  const version = env.AMAZON_CREATORS_CREDENTIAL_VERSION;
  const partnerTag = env.AMAZON_ASSOCIATE_TAG;
  const marketplace = env.AMAZON_MARKETPLACE || 'www.amazon.com';

  if (!credentialId || !credentialSecret || !version || !partnerTag) {
    const missing = [
      !credentialId && 'AMAZON_CREATORS_CREDENTIAL_ID',
      !credentialSecret && 'AMAZON_CREATORS_CREDENTIAL_SECRET',
      !version && 'AMAZON_CREATORS_CREDENTIAL_VERSION',
      !partnerTag && 'AMAZON_ASSOCIATE_TAG',
    ].filter(Boolean);
    throw new AmazonCreatorsApiError(`Amazon Creators API is not configured: ${missing.join(', ')}`);
  }

  const tokenEndpoint = TOKEN_ENDPOINTS[version];
  if (!tokenEndpoint) {
    throw new AmazonCreatorsApiError(`Unsupported Amazon Creators credential version: ${version}`);
  }

  return { credentialId, credentialSecret, version, partnerTag, marketplace, tokenEndpoint };
}

function isConfigured(env = process.env) {
  return Boolean(
    env.AMAZON_CREATORS_CREDENTIAL_ID
      && env.AMAZON_CREATORS_CREDENTIAL_SECRET
      && env.AMAZON_CREATORS_CREDENTIAL_VERSION
      && env.AMAZON_ASSOCIATE_TAG
  );
}

function tokenCacheKey(config) {
  return `${config.credentialId}:${config.version}`;
}

function clearToken() {
  tokenCache = null;
}

async function getAccessToken(config, { forceRefresh = false } = {}) {
  const cacheKey = tokenCacheKey(config);
  if (!forceRefresh && tokenCache?.key === cacheKey && Date.now() < tokenCache.expiresAt) {
    return tokenCache.value;
  }

  if (!forceRefresh && tokenRequest?.key === cacheKey) {
    return tokenRequest.promise;
  }

  const promise = (async () => {
    const isLwa = config.version.startsWith('3.');
    const body = isLwa
      ? JSON.stringify({
        grant_type: 'client_credentials',
        client_id: config.credentialId,
        client_secret: config.credentialSecret,
        scope: 'creatorsapi::default',
      })
      : new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.credentialId,
        client_secret: config.credentialSecret,
        scope: 'creatorsapi/default',
      });
    const response = await fetch(config.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': isLwa ? 'application/json' : 'application/x-www-form-urlencoded' },
      body,
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.access_token) {
      throw new AmazonCreatorsApiError(
        `Amazon Creators token request failed (${response.status})${data.error ? `: ${data.error}` : ''}`,
        { status: response.status, code: data.error, retryable: response.status === 429 || response.status >= 500 }
      );
    }

    const expiresIn = Math.max(30, Number(data.expires_in || 3600) - 30);
    tokenCache = { key: cacheKey, value: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    return data.access_token;
  })();

  tokenRequest = { key: cacheKey, promise };
  try {
    return await promise;
  } finally {
    if (tokenRequest?.promise === promise) tokenRequest = null;
  }
}

function authorizationHeader(token, version) {
  return version.startsWith('2.') ? `Bearer ${token}, Version ${version}` : `Bearer ${token}`;
}

async function creatorsRequest(operation, body, { retryUnauthorized = true, beforeRequest } = {}) {
  const config = getConfig();
  const token = await getAccessToken(config);
  beforeRequest?.();
  const response = await fetch(`${CREATORS_API_BASE_URL}/${operation}`, {
    method: 'POST',
    headers: {
      authorization: authorizationHeader(token, config.version),
      'content-type': 'application/json',
      'x-marketplace': config.marketplace,
    },
    body: JSON.stringify({ ...body, partnerTag: config.partnerTag }),
  });

  if (response.status === 401 && retryUnauthorized) {
    clearToken();
    const refreshedToken = await getAccessToken(config, { forceRefresh: true });
    beforeRequest?.();
    const retry = await fetch(`${CREATORS_API_BASE_URL}/${operation}`, {
      method: 'POST',
      headers: {
        authorization: authorizationHeader(refreshedToken, config.version),
        'content-type': 'application/json',
        'x-marketplace': config.marketplace,
      },
      body: JSON.stringify({ ...body, partnerTag: config.partnerTag }),
    });
    return parseApiResponse(retry, operation);
  }

  return parseApiResponse(response, operation);
}

async function parseApiResponse(response, operation) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = data.errors?.[0] || data.error || {};
    throw new AmazonCreatorsApiError(
      `Amazon Creators ${operation} failed (${response.status})${error.message ? `: ${error.message}` : ''}`,
      {
        status: response.status,
        code: error.code,
        retryable: response.status === 429 || response.status >= 500,
      }
    );
  }
  return data;
}

function displayValue(value) {
  return value?.displayValue ?? value?.value;
}

function displayValues(value) {
  const values = value?.displayValues || value?.values || [];
  return Array.isArray(values) ? values.map(String).filter(Boolean) : [];
}

function normalizeDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return undefined;

  const normalized = Object.fromEntries(Object.entries(dimensions)
    .map(([key, value]) => {
      const amount = displayValue(value);
      if (amount === undefined || amount === null || amount === '') return undefined;
      const unit = value?.unit || value?.unitOfMeasure || '';
      return [key, `${amount}${unit ? ` ${unit}` : ''}`.trim()];
    })
    .filter(Boolean));

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function sourceFacts(item, listing) {
  const itemInfo = item?.itemInfo || {};
  const productInfo = itemInfo.productInfo || {};
  const byLineInfo = itemInfo.byLineInfo || {};
  const classifications = itemInfo.classifications || {};
  const contentInfo = itemInfo.contentInfo || {};
  const technicalInfo = itemInfo.technicalInfo || {};
  const facts = {
    brand: displayValue(byLineInfo.brand),
    manufacturer: displayValue(byLineInfo.manufacturer),
    contributors: displayValues(byLineInfo.contributors),
    binding: displayValue(classifications.binding),
    productGroup: displayValue(classifications.productGroup),
    features: displayValues(itemInfo.features),
    color: displayValue(productInfo.color),
    size: displayValue(productInfo.size),
    unitCount: displayValue(productInfo.unitCount),
    isAdultProduct: displayValue(productInfo.isAdultProduct),
    itemDimensions: normalizeDimensions(productInfo.itemDimensions),
    packageDimensions: normalizeDimensions(productInfo.packageDimensions),
    publicationDate: displayValue(contentInfo.publicationDate),
    edition: displayValue(contentInfo.edition),
    languages: displayValues(contentInfo.languages),
    formats: displayValues(technicalInfo.formats),
    parentAsin: item?.parentASIN,
    offerCondition: displayValue(listing?.condition) || listing?.condition?.subCondition?.value,
  };

  return Object.fromEntries(Object.entries(facts).filter(([, value]) => (
    value !== undefined
      && value !== null
      && value !== ''
      && (!Array.isArray(value) || value.length > 0)
  )));
}

function mapItem(item) {
  const listings = item?.offersV2?.listings || [];
  const purchasable = new Set(['IN_STOCK', 'IN_STOCK_SCARCE', 'INSTOCKSCARCE', 'AVAILABLE_DATE', 'LEADTIME', 'PREORDER']);
  const listing = listings.find((candidate) => (
    purchasable.has(String(candidate?.availability?.type || '').toUpperCase())
      && candidate?.price?.money
  )) || listings.find((candidate) => (
    purchasable.has(String(candidate?.availability?.type || '').toUpperCase())
  )) || listings.find((candidate) => candidate?.price?.money) || listings[0];
  const money = listing?.price?.money;
  const availabilityStatus = String(listing?.availability?.type || '').toUpperCase() || 'UNKNOWN';
  const rawImageUrl = item?.images?.primary?.large?.url || item?.images?.primary?.medium?.url || '';

  return {
    id: item?.asin || '',
    title: item?.itemInfo?.title?.displayValue || '',
    price: Number(money?.amount || 0),
    currency: money?.currency || 'USD',
    imageUrl: rawImageUrl,
    affiliateUrl: item?.detailPageURL || '',
    source: 'amazon',
    remotelyVerified: true,
    availabilityStatus,
    availabilityMessage: listing?.availability?.message || '',
    sourceFacts: sourceFacts(item, listing),
    rating: item?.customerReviews?.starRating?.value
      ? Number(item.customerReviews.starRating.value)
      : undefined,
    reviewCount: item?.customerReviews?.count
      ? Number(item.customerReviews.count)
      : undefined,
  };
}

async function getItems(asins, options) {
  const itemIds = Array.from(new Set(asins.filter((asin) => /^[A-Z0-9]{10}$/.test(asin)))).slice(0, 10);
  if (itemIds.length === 0) return [];
  const data = await creatorsRequest('getItems', { itemIds, resources: PRODUCT_RESOURCES }, options);
  return (data.itemsResult?.items || []).map(mapItem);
}

async function searchItems({ keywords, searchIndex = 'All', itemCount = 10 }) {
  const data = await creatorsRequest('searchItems', {
    keywords,
    searchIndex,
    itemCount: Math.max(1, Math.min(10, itemCount)),
    resources: PRODUCT_RESOURCES,
  });
  return (data.searchResult?.items || []).map(mapItem);
}

function isThrottleError(error) {
  return error instanceof AmazonCreatorsApiError && (error.status === 429 || error.code === 'TooManyRequests');
}

const amazonCreators = {
  AmazonCreatorsApiError,
  PRODUCT_RESOURCES,
  clearToken,
  getItems,
  isConfigured,
  isThrottleError,
  mapItem,
  sourceFacts,
  searchItems,
};

export {
  AmazonCreatorsApiError,
  PRODUCT_RESOURCES,
  clearToken,
  getItems,
  isConfigured,
  isThrottleError,
  mapItem,
  sourceFacts,
  searchItems,
};

export default amazonCreators;
