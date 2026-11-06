import test from 'node:test';
import assert from 'node:assert/strict';
import { conciseGiftTitle, naturalProductImage, presentGiftProduct } from '../presentation.mjs';

test('curated catalog title and factual description take precedence over old puns', () => {
  const source = { publicId: 'same-product', displayTitle: 'Medieval cat tapestry', title: 'Long merchant title',
    description: 'A medieval-style cat tapestry for a wall.', wittyDescription: 'Old generic joke.',
    punnyTitle: 'The coolest thing ever!', imageUrl: 'https://stupid.gifts/images/cat.jpg', affiliateUrl: 'private' };
  assert.deepEqual(presentGiftProduct(source), { title: 'Medieval cat tapestry',
    description: 'A medieval-style cat tapestry for a wall.', imageUrl: source.imageUrl });
  assert.equal(source.publicId, 'same-product');
  assert.equal(source.title, 'Long merchant title');
  assert.deepEqual(Object.keys(presentGiftProduct(source)), ['title', 'description', 'imageUrl']);
});

test('titles remove separate gift keyword padding while retaining sizes and quoted product wording', () => {
  assert.equal(conciseGiftTitle("Lick'em Tongue Cat Brush – Funny Novelty White Elephant Gag Gift for Cat Lovers"), "Lick'em Tongue Cat Brush");
  assert.equal(conciseGiftTitle('Funny Gifts for Dad | Ceramic cat mug'), 'Ceramic cat mug');
  for (const title of ['Chewy V dog toy (Medium)', 'Cat T-shirt, Size Large', 'Cat mug — Blue', 'Desk sign — “Gift”', 'Gift card — $25', 'Funny gift — Blue']) {
    assert.equal(conciseGiftTitle(title), title);
  }
  assert.equal(conciseGiftTitle('Funny Mugs For Cat Lovers, Gift for Dad'), 'Funny Mugs For Cat Lovers');
});

test('long titles shorten at word boundaries without replacing the supplied object', () => {
  const source = 'Ceramic cat mug with a carefully painted face and a long merchant keyword tail that exceeds the card width';
  const title = conciseGiftTitle(source);
  assert.ok(title.length <= 76);
  assert.ok(title.startsWith('Ceramic cat mug'));
  assert.ok(source.startsWith(title.slice(0, -1)));
  assert.ok(title.endsWith('…'));
  assert.equal(conciseGiftTitle(''), '');
});

test('missing copy falls back to supplied product facts without invented claims', () => {
  assert.equal(presentGiftProduct({ title: 'Cat mug', description: '   ', wittyDescription: 'A cat-shaped ceramic mug.' }).description, 'A cat-shaped ceramic mug.');
  assert.equal(presentGiftProduct({ title: 'Cat mug' }).description, 'Cat mug');
  assert.equal(presentGiftProduct({ title: 'Cat\n mug\u202e', description: 'Ceramic.\u0000\nWhite.' }).description, 'Ceramic. White.');
  assert.equal(presentGiftProduct(null).title, '');
});

test('recognized retailer badge recipes retain the exact original base photo identity', () => {
  assert.equal(naturalProductImage('https://m.media-amazon.com/images/I/51T8W+9SJ6L._SR600,300_PIStarRatingFOURANDHALF,TopLeft,0,0_.jpg'), 'https://m.media-amazon.com/images/I/51T8W+9SJ6L._SL600_.jpg');
  for (const source of ['https://m.media-amazon.com/images/I/same._SL500_.jpg',
    'https://m.media-amazon.com/images/I/composite._TSa%7Cpi-src%3Adifferent.jpg.json',
    'https://i.etsystatic.com/source.jpg', 'https://stupid.gifts/images/source.jpg']) {
    assert.equal(naturalProductImage(source), source);
  }
  assert.equal(naturalProductImage(null), null);
});
