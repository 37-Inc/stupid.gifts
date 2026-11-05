import { PUBLIC_CONTACT_EMAIL } from './site';

export const privacyPolicyUpdated = 'November 5, 2026';
export const privacyPolicyIntro = 'This policy explains how goose.gifts handles information for visitors using the site.';
export const privacyPolicySections = [
  {
    title: 'Information We Collect',
    body: [
      'goose.gifts may collect basic usage information, such as pages viewed, searches submitted, approximate device and browser information, referring pages, and product links clicked.',
      'If you contact us directly, we may receive the contact information and message content you choose to provide.',
    ],
  },
  {
    title: 'How We Use Information',
    body: [
      'We use usage information to improve gift recommendations, understand which products and guides are useful, maintain site reliability, and measure traffic and affiliate-link performance.',
      'We do not sell personal information.',
    ],
  },
  {
    title: 'Affiliate Links',
    body: [
      'goose.gifts links to third-party retailers and may earn commissions from qualifying purchases. Retailers and affiliate networks may use cookies or similar technologies under their own policies when you leave goose.gifts.',
    ],
  },
  {
    title: 'Analytics',
    body: [
      'We may use analytics tools to understand aggregate site activity, including searches, page views, outbound product clicks, and referral sources.',
      'Third-party analytics receive only limited event details such as page paths, result counts, product identifiers and sources, link domains, and coarse campaign attribution. We do not send them search or recipient text, affiliate URLs, URL query strings, form contents, or session recordings. Browser Do Not Track and Global Privacy Control signals disable Google Analytics and PostHog collection.',
      'Separately, we collect normalized search topics, the number of results shown, search errors and the position of the first result selected to identify gaps in our catalog. These first-party observations use a random identifier for each search, not a visitor identifier; they contain no IP address or browsing history. We suppress obvious contact details, but automatic filtering cannot detect every personal detail, so please do not enter private information. Do Not Track and Global Privacy Control also disable this collection. Observations expire from reports after 30 days and are deleted during subsequent collection; they are not sent to Google Analytics or PostHog.',
    ],
  },
  {
    title: 'Gift Search',
    body: [
      'For meaning-based gift search, we send the search text to OpenAI to create a numerical representation and match it against our catalog using Cloudflare Vectorize. This is a functional search service, separate from analytics. Please do not enter private or sensitive personal information in the search box.',
      'If meaning-based search is unavailable, we use keyword search instead.',
    ],
  },
  {
    title: 'Third-Party Sites',
    body: [
      'Product links and social links may send you to third-party websites. Their privacy practices are governed by their own privacy policies.',
    ],
  },
  {
    title: 'Contact',
    body: [
      `For privacy questions about goose.gifts, contact ${PUBLIC_CONTACT_EMAIL}.`,
    ],
  },
];
