// Owner-private preview annotations, visually checked against the real source
// photos on 2026-10-02. Three titles truncate before the product kind; one
// description contains an unsupported safety claim. Keep facts tied to the
// inspected photo identity; never write them to DB.
const facts = {
  'a284a9b7-ee88-406d-9c58-22177de9797a': {
    imageId: '41HMwWA6hoL', titlePrefix: 'shop4ever Coffee Because Adulting is Hard',
    description: 'A white coffee mug printed with “Coffee because adulting is hard.”',
  },
  '581e2ef3-8e87-4113-a6cd-a31323466860': {
    imageId: '51xzaP3QG1L', titlePrefix: 'Poodle Tie Dye Vintage Hippie Dog',
    description: 'A coffee mug featuring a colorful poodle print.',
  },
  'f55deb73-15a2-4ffa-8347-ad301792607f': {
    imageId: '415ShUDGwZL', titlePrefix: 'Retreez Funny I Turn Coffee into Flower',
    description: 'A coffee mug printed with “I turn coffee into flower arrangements.”',
  },
  '0d5f9acb-6bb8-4008-8901-4d4cdbbc88d0': {
    imageId: '51T8W+9SJ6L', titlePrefix: 'Funny Oven Mitts and Pot Holders Sets Black Kitchen Accessories',
    description: 'An oven mitt and pot holder with a playful kitchen print.', tag: 'oven-mitt',
  },
};

export function applyReviewedFacts(gift, originalTitle) {
  const fact = facts[gift.id];
  if (!fact || !originalTitle.startsWith(fact.titlePrefix) || !new URL(gift.imageUrl).pathname.startsWith(`/images/I/${fact.imageId}.`)) return gift;
  return { ...gift, description: fact.description, tags: [...new Set([fact.tag || 'mug', ...gift.tags])].slice(0, 12) };
}
