import type { GiftGuideFaq } from './gift-guide-editorial';

// Pure canonical guide content and focus evidence, shared by live and static apps.
export interface GiftGuideDefinition {
  slug: string;
  title: string;
  metadataTitle?: string;
  h1: string;
  description: string;
  intro: string;
  keywords: string[];
  /** Ordered editorial picks, resolved against the currently eligible catalog. */
  curatedProductIds?: readonly string[];
  editorialHeading?: string;
  editorialAside?: string;
  editorialSections?: GiftGuideEditorialSection[];
  faqs?: GiftGuideFaq[];
}

export interface GiftGuideEditorialSection {
  title: string;
  paragraphs: string[];
  links?: Array<{
    slug: string;
    label: string;
  }>;
}

// A guide's broad keywords are useful for recall, but they are not all equally
// distinctive. These focus groups define the concrete evidence that should be
// present in the merchant title before a product leads a guide. Every group
// must match; terms within a group are alternatives. Keeping this separate
// from generated catalog copy prevents optimistic enrichment from making the
// same generic products lead dozens of pages.
export const giftGuideFocusKeywordGroups: Record<string, string[][]> = {
  'white-elephant-gifts': [['white elephant']],
  'funny-gifts-for-coworkers': [['coworker', 'coworkers']],
  'funny-gifts-for-dads': [['dad', 'father', 'grandpa']],
  'weird-kitchen-gadgets': [[
    'kitchen gadget',
    'kitchen tool',
    'kitchen utensil',
    'pizza cutter',
    'cheese grater',
    'egg separator',
    'jar scraper',
    'microwave cleaner',
    'spoon rest',
    'garlic press',
    'tea strainer',
    'toothpick holder',
    'oven mitt',
  ]],
  'novelty-desk-toys': [['desk toy', 'desktop toy', 'fidget']],
  'secret-santa-gag-gifts': [['secret santa']],
  'funny-gifts-for-dads-who-fish': [['fish', 'fishing', 'tackle']],
  'cat-lover-gag-gifts': [['cat', 'cats', 'kitten', 'kitty']],
  'dog-lover-gag-gifts': [['dog', 'dogs', 'puppy', 'canine']],
  'prank-gifts-for-friends': [['prank', 'fake']],
  'funny-birthday-gag-gifts': [['birthday']],
  'funny-retirement-gifts': [['retirement', 'retired', 'retiree']],
  'funny-gifts-for-bosses': [['boss', 'manager']],
  'office-prank-gifts': [['office', 'coworker', 'workplace'], ['prank']],
  'funny-coffee-mugs': [['coffee'], ['mug', 'cup', 'tumbler']],
  'weird-bathroom-gifts': [['bathroom', 'toilet', 'restroom']],
  'funny-poop-gifts': [['poop', 'fart', 'potty', 'shart', 'turd']],
  'funny-housewarming-gifts': [['housewarming', 'new home']],
  'funny-stocking-stuffers': [['stocking stuffer', 'stocking stuffers']],
  'white-elephant-gifts-for-adults': [['white elephant'], ['adult', 'adults', 'men', 'women']],
  'gifts-for-people-who-have-everything': [['have everything', 'has everything', 'hard to shop']],
  'funny-gifts-for-men': [['men', 'man', 'husband', 'boyfriend']],
  'funny-gifts-for-women': [['women', 'woman', 'wife', 'girlfriend']],
  'sarcastic-gifts': [['sarcastic', 'snark', 'snarky']],
  'funny-cooking-gifts': [['cooking', 'cook', 'chef']],
  'weird-home-decor-gifts': [['home decor', 'house decor', 'room decor', 'wall decor']],
  'optical-illusion-decor-gifts': [['optical illusion', 'illusion']],
  'funny-gifts-for-teachers': [['teacher', 'school', 'classroom']],
  'funny-gifts-for-nurses': [['nurse', 'nurses', 'nursing']],
  'funny-book-lover-gifts': [['book', 'books', 'bookmark', 'bookmarks', 'book lover', 'bookish', 'reader', 'reading']],
  'funny-sports-fan-gifts': [['sports fan', 'game day', 'football fan', 'soccer fan', 'baseball fan', 'basketball fan']],
  'funny-wine-gifts': [['wine']],
  'funny-bath-gifts': [['bath', 'spa'], ['bath bomb', 'soap', 'self care', 'relaxation', 'shower']],
  'adult-coloring-book-gifts': [['coloring book', 'colouring book']],
  'funny-halloween-gifts': [['halloween', 'spooky', 'horror']],
  'funny-christmas-gifts': [['christmas']],
  'funny-valentines-gifts': [['valentine', 'valentines']],
  'funny-gifts-for-moms': [['mom', 'mother', 'mama']],
  'funny-gifts-for-gamers': [['gamer', 'gaming', 'video game', 'controller']],
  'funny-golf-gifts': [['golf', 'golfer']],
  'funny-gardening-gifts': [['garden', 'gardening', 'gardener', 'plant lover']],
  'funny-hostess-gifts': [['hostess', 'host gift', 'host gifts', 'party host']],
};

export const giftGuides: GiftGuideDefinition[] = [
  {
    slug: 'white-elephant-gifts',
    title: 'Funny White Elephant Gifts',
    metadataTitle: 'Funny White Elephant Gifts People Will Actually Steal',
    h1: 'Funny white elephant gifts people will actually steal',
    description: 'Browse funny white elephant gifts people will actually steal, with useful gag-gift ideas, real product images, and current affiliate links.',
    intro: 'The best white elephant gift gets a quick laugh, makes sense from across the room, and gives people a reason to steal it instead of politely passing.',
    keywords: ['white elephant', 'secret santa', 'party', 'exchange', 'holiday', 'funny', 'gag'],
    editorialHeading: 'Choose for the exchange, not one perfect recipient',
    editorialAside: 'A four-part steal test',
    editorialSections: [
      {
        title: 'Start with the room test',
        paragraphs: [
          'A white elephant gift has to land with a mixed group before anyone knows who will take it home. Favor a joke people can understand in a few seconds, at ordinary speaking volume, without a long backstory about one specific recipient.',
          'Broad room fit does not mean bland. A visibly strange useful object, an overcommitted version of an everyday tool, or a harmless gag with a second life usually travels better than clothing sizes, personal insults, dietary assumptions, or a joke that depends on embarrassing someone.',
        ],
        links: [
          { slug: 'funny-gifts-for-coworkers', label: 'Use the office-safe room test' },
          { slug: 'white-elephant-gifts-for-adults', label: 'Browse adult white elephant gifts' },
        ],
      },
      {
        title: 'Use the four-part steal test',
        paragraphs: [
          'Check four things: quick reaction, some usefulness after the laugh, enough visual or practical appeal to invite a steal, and a broad fit for the people in the room. A gift does not need to win every category, but it should have more going for it than shock value alone.',
          'Pure prank packaging can get a reaction and still become dead weight once opened. If the gift underneath is useful, displayable, or satisfyingly odd, the joke keeps working after the exchange instead of ending at the reveal.',
        ],
        links: [
          { slug: 'secret-santa-gag-gifts', label: 'Compare Secret Santa constraints' },
          { slug: 'dirty-santa-gifts', label: 'Plan for a steal-heavy Dirty Santa game' },
        ],
      },
    ],
    faqs: [
      {
        question: 'What makes a good funny white elephant gift?',
        answer: 'A strong white elephant gift gets a quick group reaction, works for more than one person in the room, and has enough usefulness or oddball appeal that somebody may steal it. The joke should be easy to understand without singling out or embarrassing a recipient.',
      },
      {
        question: 'Should a white elephant gift be useful or just a gag?',
        answer: 'Useful and funny is the safest combination. A pure gag can work when the group expects one, but a practical object with a ridiculous shape, message, or function gives people a reason to keep competing for it after the first laugh.',
      },
      {
        question: 'How do you choose a white elephant gift for work?',
        answer: 'Use the strictest room test: no jokes about bodies, protected traits, politics, religion, relationships, health, or private life. Choose a modest gift that can be opened in front of managers and coworkers, then taken home or kept at a desk without creating a problem.',
      },
    ],
  },
  {
    slug: 'funny-gifts-for-coworkers',
    title: 'Funny Gifts for Coworkers',
    h1: 'Funny gifts for coworkers that stay office-safe',
    description: 'Browse funny coworker gifts for bosses, employees, and work colleagues, with office-safe desk ideas from the goose.gifts catalog.',
    intro: 'Office gifts need a narrow lane: funny enough to land, safe enough to hand over in daylight, and useful enough to avoid the junk drawer.',
    keywords: ['coworker', 'office', 'desk', 'boss', 'meeting', 'work', 'safe'],
    editorialHeading: 'Choose the joke before the product',
    editorialAside: 'Useful office-gift criteria',
    editorialSections: [
      {
        title: 'Use the room test, not the shock test',
        paragraphs: [
          'The safest office joke points at work itself: an overbooked calendar, a familiar meeting habit, or a desk ritual. Skip anything about a protected trait, someone’s body, politics, religion, relationships, or private life. If you would hesitate to explain the joke with the recipient’s boss standing there, choose another gift.',
          'A quick laugh is enough. Small useful objects and mildly distracting desk pieces are easier to receive than giant props, messy pranks, or anything that creates a display obligation.',
        ],
        links: [
          { slug: 'novelty-desk-toys', label: 'Browse novelty desk toys' },
          { slug: 'office-prank-gifts', label: 'See office prank gifts for trusted teams' },
        ],
      },
      {
        title: 'Match the joke to the working relationship',
        paragraphs: [
          'For a close coworker, build on a harmless shared bit they already enjoy. For a colleague you know less well, choose something legible and low-pressure: a practical novelty, a small desk object, or a joke about the job rather than the person.',
          'Bosses and direct reports need extra restraint because power changes how a joke lands. Keep the cost modest, avoid personal commentary, and favor team gifts or work-specific humor that does not ask for a particular reaction.',
        ],
        links: [
          { slug: 'funny-gifts-for-bosses', label: 'Choose a funny gift for a boss' },
          { slug: 'secret-santa-gag-gifts', label: 'Plan an office Secret Santa gift' },
        ],
      },
    ],
    faqs: [
      {
        question: 'What makes a funny coworker gift office-safe?',
        answer: 'An office-safe gift makes the job, a shared routine, or a harmless desk habit the joke—not the recipient’s body, identity, politics, religion, relationships, health, or private life. It should be easy to open in a group and easy to put away afterward.',
      },
      {
        question: 'What is a good funny gift for a boss?',
        answer: 'Choose a modest, work-related joke with no personal edge. A team gift, practical novelty, or familiar meeting reference is safer than anything expensive, crude, intimate, or designed to embarrass the boss in front of other people.',
      },
      {
        question: 'Are desk gifts better than pure gag gifts for coworkers?',
        answer: 'Usually, if the recipient actually keeps things at their desk. A useful or mildly distracting object can earn a second life after the joke lands. For a minimalist workspace or a remote colleague, a small consumable or exchange-friendly gift may be a better fit.',
      },
    ],
  },
  {
    slug: 'funny-gifts-for-dads',
    title: 'Funny Gifts for Dads',
    metadataTitle: 'Funny Dad Gifts and Dad Joke Gifts',
    h1: 'Funny dad gifts for birthdays, holidays, and bad puns',
    description: 'Browse funny dad gifts and dad joke gifts for birthdays and holidays, with practical novelty ideas for fishing, grilling, and everyday routines.',
    intro: 'The strongest funny gift for a dad starts with something recognizably his: the pun he repeats, the hobby he disappears into, or the everyday job he has quietly claimed as his department.',
    keywords: ['dad', 'father', 'grandpa', 'pun', 'joke', 'gadget', 'grill'],
    editorialHeading: 'Pick the dad before the punchline',
    editorialAside: 'Dad joke, hobby joke, or useful oddity?',
    editorialSections: [
      {
        title: 'Decide what kind of funny dad gift you mean',
        paragraphs: [
          'A dad-joke gift works when the joke sounds like something he would actually say. A birthday or Christmas gift can be broader, but it should still point to a real habit: guarding the thermostat, making coffee before conversation, narrating a home repair, or treating the grill like a control panel.',
          'Skip a generic “best dad” object unless the object itself fits his routine. A small practical novelty usually lasts longer than a punchline printed on something he will never use, and a specific joke feels chosen even when the gift is inexpensive.',
        ],
        links: [
          { slug: 'funny-coffee-mugs', label: 'Browse funny coffee mugs' },
          { slug: 'sarcastic-gifts', label: 'Find drier, more sarcastic gifts' },
        ],
      },
      {
        title: 'Use hobbies to narrow the field—not to fake expertise',
        paragraphs: [
          'Fishing, grilling, golf, gardening, and tinkering are useful filters only when they describe this dad. If you know his setup well enough to choose compatible gear, a genuinely useful tool can carry the joke. If you do not, stay adjacent: a funny mug, desk object, serving tool, or harmless accessory avoids guessing at sizes, brands, or technical preferences.',
          'For a grandpa, father-in-law, or newer dad you do not know as well, choose the lowest-pressure version of the idea. The gift should be easy to understand, easy to keep, and funny without asking him to perform a stereotype for the room.',
        ],
        links: [
          { slug: 'funny-gifts-for-dads-who-fish', label: 'Choose a fishing-dad gift' },
          { slug: 'weird-kitchen-gadgets', label: 'Compare useful kitchen oddities' },
          { slug: 'funny-golf-gifts', label: 'Browse funny golf gifts' },
        ],
      },
    ],
    faqs: [
      {
        question: 'What makes a good funny gift for a dad?',
        answer: 'Start with a real habit, hobby, or running joke, then choose an object he can understand and use without a long explanation. Specificity matters more than shock value: a modest gift tied to his coffee routine, workshop, grill, fishing habit, or favorite terrible pun usually feels more personal than a generic dad slogan.',
      },
      {
        question: 'What is a good funny birthday gift for Dad?',
        answer: 'A birthday is a good excuse for a practical novelty with one clear joke, such as an odd desk object, exaggerated everyday tool, or mug that fits an existing routine. Avoid clothing sizes and specialized hobby gear unless you know exactly what he uses.',
      },
      {
        question: 'Should I buy a fishing or grilling gift for Dad?',
        answer: 'Only if fishing or grilling is genuinely his thing. Buy technical gear when you know the required size, brand, or setup; otherwise choose a funny adjacent item that does not need to fit his equipment. The goal is to recognize the hobby, not prove that every dad has the same one.',
      },
    ],
  },
  {
    slug: 'weird-kitchen-gadgets',
    title: 'Weird Kitchen Gadgets',
    metadataTitle: 'Funny Kitchen Gadgets and Weird Kitchen Gifts',
    h1: 'Funny kitchen gadgets that earn drawer space',
    description: 'Browse funny kitchen gadgets and weird kitchen gifts, with practical checks for usefulness, cleanup, storage, and cook-friendly fit.',
    intro: 'The best weird kitchen gadget earns its laugh without becoming one more awkward tool the cook has to store.',
    keywords: ['kitchen', 'cook', 'cooking', 'mug', 'coffee', 'ramen', 'food'],
    editorialHeading: 'Make the weird part do some work',
    editorialAside: 'Usefulness, cleanup, and kitchen fit',
    editorialSections: [
      {
        title: 'Choose useful weird, not decorative weird',
        paragraphs: [
          'Start with a kitchen job the recipient already does: cutting pizza, grating cheese, serving snacks, protecting a hand from a hot pan, or making coffee. A funny shape can make that familiar task more memorable. An object with no clear job has to compete for counter or cabinet space after the first laugh.',
          'A novelty mug or serving piece still counts as useful when it fits an existing routine. For a small kitchen, favor one compact tool with an obvious purpose over a large single-use machine. For an experienced cook, avoid novelty versions of specialized gear unless you know the tool will suit the way they cook.',
        ],
        links: [
          { slug: 'funny-cooking-gifts', label: 'Browse funny gifts for cooks' },
          { slug: 'funny-coffee-mugs', label: 'Choose a mug for a real coffee routine' },
        ],
      },
      {
        title: 'Check the boring details before the joke',
        paragraphs: [
          'Look at size, materials, heat limits, moving parts, and the cleaning instructions on the current retailer listing. Dishwasher-safe is useful only when the maker actually says it; otherwise assume the recipient may need to wash an oddly shaped object by hand. Skip tools that appear difficult to dry, sharpen, or fit into a normal drawer.',
          'Match the gadget to the handoff as well as the cook. A visually ridiculous but functional tool can work in a white elephant exchange because the room understands it quickly. A host gift should be smaller and low-pressure, while a close friend can receive the stranger object that connects to a shared meal or kitchen habit.',
        ],
        links: [
          { slug: 'white-elephant-gifts', label: 'Apply the white elephant steal test' },
          { slug: 'funny-hostess-gifts', label: 'Compare low-pressure host gifts' },
        ],
      },
    ],
    faqs: [
      {
        question: 'What makes a funny kitchen gadget a good gift?',
        answer: 'It should have one obvious kitchen job, a joke or shape the recipient will understand quickly, and a realistic place to live after the gift is opened. A useful oddity usually lasts longer than a decorative prop or bulky single-use appliance.',
      },
      {
        question: 'How do I avoid giving a weird kitchen tool that becomes clutter?',
        answer: 'Choose a task the recipient already does, then check the product dimensions, materials, cleaning instructions, and storage needs on the current listing. Compact hand tools, mugs, and serving pieces are generally easier to keep than countertop machines or gadgets with many loose parts.',
      },
      {
        question: 'Are practical kitchen gifts still funny enough for a gag exchange?',
        answer: 'Yes. A familiar tool with an exaggerated shape, visual pun, or surprising mechanism can read immediately across the room and still be useful afterward. For a mixed group, avoid jokes about bodies, diets, health, or cooking ability.',
      },
    ],
  },
  {
    slug: 'novelty-desk-toys',
    title: 'Novelty Desk Toys',
    h1: 'Novelty desk toys for bored hands and bad meetings',
    description: 'Find novelty desk toys, office gadgets, fidgets, and small funny gifts for workspaces and home offices.',
    intro: 'Small desk gifts earn their spot by being glanceable, fiddly, and just distracting enough between calls.',
    keywords: ['desk', 'toy', 'office', 'fidget', 'work', 'meeting', 'gadget'],
  },
  {
    slug: 'secret-santa-gag-gifts',
    title: 'Secret Santa Gag Gifts',
    metadataTitle: 'Funny Secret Santa Gifts and Gag Gift Ideas',
    h1: 'Funny Secret Santa gifts that fit the person and the room',
    description: 'Find funny Secret Santa gifts and gag gift ideas for coworkers, friends, and holiday exchanges, with practical ways to keep the joke low-risk.',
    intro: 'A good Secret Santa gag gift fits one real recipient, stays appropriate for the room where it will be opened, and still has a life after the reveal.',
    keywords: ['secret santa', 'holiday', 'christmas', 'office-safe', 'coworker', 'party', 'gag'],
    editorialHeading: 'Choose for one recipient, then check the room',
    editorialAside: 'Recipient, setting, and handoff',
    editorialSections: [
      {
        title: 'Start with what you actually know about the recipient',
        paragraphs: [
          'Secret Santa is different from a steal-and-swap exchange: you are choosing for one person, even when everyone watches the gift open. Use a harmless habit, shared interest, or running joke that the recipient already enjoys. If the only idea you have is a stereotype about their age, job, body, identity, or relationship, it is not specific enough to be personal.',
          'For a friend, a strange object tied to a familiar bit can work. For a coworker, boss, or newer acquaintance, narrow the joke to something public and low-pressure, such as coffee, meetings, a desk ritual, or a practical object with an absurd shape. The gift should not require the recipient to explain private context to the room.',
        ],
        links: [
          { slug: 'funny-gifts-for-coworkers', label: 'Apply the office-safe gift test' },
          { slug: 'funny-gifts-for-bosses', label: 'Choose a low-pressure boss gift' },
        ],
      },
      {
        title: 'Check the setting, budget, and second life',
        paragraphs: [
          'Before buying, picture the handoff: where will it be opened, who else will be there, and can the recipient carry it home without a cleanup project? Avoid messy pranks, clothing sizes, strong scents, and jokes that depend on politics, religion, health, or embarrassment. Follow the exchange budget and confirm the current price at the retailer instead of relying on an old remembered price.',
          'The strongest gag gift does something after the laugh. A useful novelty, small desk object, funny kitchen tool, or displayable oddity gives the recipient a reason to keep it. Pure prank packaging works better when the real gift inside is still chosen for that person rather than being a random prop for the group.',
        ],
        links: [
          { slug: 'white-elephant-gifts', label: 'Compare a steal-and-swap exchange' },
          { slug: 'funny-christmas-gifts', label: 'Browse broader funny Christmas gifts' },
        ],
      },
    ],
    faqs: [
      {
        question: 'What makes a good funny Secret Santa gift?',
        answer: 'A good Secret Santa gift has one clear joke tied to something the recipient actually likes or does, stays appropriate for the room where it will be opened, and remains useful or displayable after the reveal. Specific and low-pressure usually works better than shocking or generic.',
      },
      {
        question: 'How do I choose a Secret Santa gag gift for a coworker?',
        answer: 'Keep the joke about a public work routine, desk habit, or shared interest rather than the person\'s body, identity, politics, religion, health, relationships, or private life. Choose something modest, easy to open in a group, and easy to take home or keep at a desk.',
      },
      {
        question: 'Are Secret Santa and white elephant gifts the same?',
        answer: 'Not usually. Secret Santa assigns one recipient, so the gift can reflect that person. White elephant gifts move around a group through choosing or stealing, so they need broader appeal and a joke the whole room can understand quickly.',
      },
    ],
  },
  {
    slug: 'dirty-santa-gifts',
    title: 'Dirty Santa Gifts',
    h1: 'Dirty Santa gifts worth stealing',
    description: 'Funny gift ideas for a holiday swap, from a fortune-telling pickle to a tortilla blanket.',
    intro: 'Pick something the whole room gets on sight and at least one person will fight to take home. A useful object with a stupid twist is a good place to start.',
    keywords: ['dirty santa', 'white elephant', 'holiday', 'christmas', 'party', 'exchange', 'gag'],
    curatedProductIds: [
      'B0CYKK1167', // Fortune-telling pickle
      'B07VLBVQBP', // Crab spoon rest
      '0762460806', // Desktop boxing set
      'B082SHCSH6', // Tortilla blanket
      'B0CRRWZHK1', // Sheep toilet paper holders
      'B0FZDRNRH4', // Screaming goat
      'B08TJ1BSDV', // Cowboy cat pillow cover
      'B09T39W736', // Desktop golf pen set
      'B0BHY3K6ZL', // Chicken-leg socks
      'B0FR5J39PR', // Grumpy frog
    ],
    editorialHeading: 'Pick for the swap, not for one person',
    editorialSections: [
      {
        title: 'Go for a joke that needs no explanation',
        paragraphs: [
          'A crab that holds a spoon or a tiny punching bag makes sense before you finish unwrapping it. If the room is a mix of coworkers, relatives, and plus-ones, skip the inside joke and pick something the next person can use or display.',
          'Check the host’s budget and steal rules, then check the current price at the retailer. For a quieter room, lean toward the spoon rest or blanket rather than a gift that makes noise.',
        ],
        links: [
          { slug: 'white-elephant-gifts', label: 'Browse more steal-and-swap gifts' },
          { slug: 'secret-santa-gag-gifts', label: 'Buying for one assigned person instead?' },
        ],
      },
    ],
  },
  {
    slug: 'funny-gifts-for-dads-who-fish',
    title: 'Funny Gifts for Dads Who Fish',
    h1: 'Funny gifts for dads who fish, tinker, and already own enough gear',
    description: 'Shop funny fishing dad gifts, practical gag gifts, and oddball finds for dads who already have the basics.',
    intro: 'For the dad who has a tackle box, a favorite chair, and a story about the one that got away. These lean practical, punny, and easy to hand over.',
    keywords: ['dad', 'father', 'fishing', 'fish', 'tackle', 'outdoor', 'gadget', 'joke'],
  },
  {
    slug: 'cat-lover-gag-gifts',
    title: 'Cat Lover Gag Gifts',
    h1: 'Cat lover gag gifts for people with very specific taste',
    description: 'Find funny cat gifts, cat lover gag gifts, and oddball pet-themed products from the goose.gifts catalog.',
    intro: 'Cat people appreciate specificity. The best gag gift feels like it was chosen by someone who knows the exact household dynamic.',
    keywords: ['cat', 'cats', 'cat-lovers', 'pet', 'pets', 'book', 'coffee', 'gag'],
  },
  {
    slug: 'dog-lover-gag-gifts',
    title: 'Dog Lover Gag Gifts',
    h1: 'Dog lover gag gifts for proud pet people',
    description: 'Browse funny dog gifts, dog dad and dog mom finds, pet gag gifts, and silly catalog picks.',
    intro: 'Dog gifts can be sweet, practical, or completely unnecessary. The best ones make the owner laugh before the dog investigates.',
    keywords: ['dog', 'dogs', 'dog-lovers', 'pet', 'pets', 'dad', 'mom', 'treat'],
  },
  {
    slug: 'prank-gifts-for-friends',
    title: 'Prank Gifts for Friends',
    h1: 'Prank gifts for friends who can take the joke',
    description: 'Find prank gifts for friends, fake product boxes, gag accessories, and funny surprise gifts with real links.',
    intro: 'A good prank gift should land quickly and still leave the recipient with something worth keeping, hiding, or telling people about.',
    keywords: ['prank', 'fake', 'friend', 'friends', 'gag', 'joke', 'surprise', 'party'],
  },
  {
    slug: 'funny-birthday-gag-gifts',
    title: 'Funny Birthday Gag Gifts',
    h1: 'Funny birthday gag gifts that beat another generic card',
    description: 'Shop funny birthday gag gifts, joke presents, novelty candles, and silly surprise ideas.',
    intro: 'Birthday gag gifts work when they feel personal enough to be intentional and ridiculous enough to earn a photo.',
    keywords: ['birthday', 'gag', 'joke', 'candle', 'friend', 'dad', 'mom', 'party'],
  },
  {
    slug: 'funny-retirement-gifts',
    title: 'Funny Retirement Gifts',
    h1: 'Funny retirement gifts for the newly unbothered',
    description: 'Browse funny retirement gifts, coworker farewell gifts, office-safe gag gifts, and novelty keepsakes.',
    intro: 'Retirement gifts should celebrate the escape without turning into a plaque nobody knows where to put.',
    keywords: ['retirement', 'retired', 'coworker', 'office', 'boss', 'work', 'sarcastic', 'gag'],
  },
  {
    slug: 'funny-gifts-for-bosses',
    title: 'Funny Gifts for Bosses',
    h1: 'Funny gifts for bosses that still feel safe to hand over',
    description: 'Find funny boss gifts, office-safe gag gifts, desk finds, and meeting-friendly novelty products.',
    intro: 'The boss gift lane is narrow: funny, useful, and extremely unlikely to require an apology.',
    keywords: ['boss', 'office', 'meeting', 'work', 'desk', 'coworker', 'office-safe', 'safe'],
  },
  {
    slug: 'office-prank-gifts',
    title: 'Office Prank Gifts',
    h1: 'Office prank gifts that stay on the safe side of chaos',
    description: 'Browse office prank gifts, desk jokes, coworker gag gifts, and small workplace-friendly surprises.',
    intro: 'Office prank gifts should be funny at a glance, easy to clean up, and safe enough for shared spaces.',
    keywords: ['office', 'prank', 'desk', 'coworker', 'meeting', 'work', 'safe', 'gag'],
  },
  {
    slug: 'funny-coffee-mugs',
    title: 'Funny Coffee Mugs',
    h1: 'Funny coffee mugs and caffeine-adjacent gifts',
    description: 'Find funny coffee mugs, coffee lover gag gifts, kitchen oddities, and practical novelty drinkware.',
    intro: 'A good mug gift earns counter space by being useful before 9 a.m. and funny after the second sip.',
    keywords: ['coffee', 'mug', 'kitchen', 'drink', 'coworker', 'office', 'dad', 'funny'],
  },
  {
    slug: 'weird-bathroom-gifts',
    title: 'Weird Bathroom Gifts',
    h1: 'Weird bathroom gifts for remodels, housewarmings, and bad taste jokes',
    description: 'Browse weird bathroom gifts, bath gag gifts, novelty decor, and funny housewarming finds.',
    intro: 'Bathroom gifts are where useful, decorative, and deeply unserious all overlap. That makes them perfect for the right recipient.',
    keywords: ['bathroom', 'bath', 'toilet', 'spa', 'housewarming', 'home', 'decor', 'weird'],
  },
  {
    slug: 'funny-poop-gifts',
    title: 'Funny Poop Gifts',
    h1: 'Funny poop gifts for people who think bathroom humor still works',
    description: 'Browse funny poop gifts, toilet jokes, bathroom gag gifts, fart pranks, and ridiculous potty-humor products from the goose.gifts catalog.',
    intro: 'Poop gifts are not subtle, which is exactly the point. These picks work for white elephant exchanges, prank-loving friends, and anyone whose sense of humor never fully grew up.',
    keywords: ['poop', 'toilet', 'bathroom', 'fart', 'potty', 'shart', 'prank', 'gag'],
  },
  {
    slug: 'funny-housewarming-gifts',
    title: 'Funny Housewarming Gifts',
    h1: 'Funny housewarming gifts for people with enough normal candles',
    description: 'Find funny housewarming gifts, weird home decor, novelty kitchen gifts, and practical gag finds.',
    intro: 'Housewarming gifts should survive the party and still make sense on a shelf, counter, or drawer a week later.',
    keywords: ['housewarming', 'home', 'decor', 'kitchen', 'candle', 'bath', 'novelty', 'gag'],
  },
  {
    slug: 'funny-stocking-stuffers',
    title: 'Funny Stocking Stuffers',
    h1: 'Funny stocking stuffers small enough to be dangerous',
    description: 'Browse funny stocking stuffers, small gag gifts, holiday novelty products, and weird little finds.',
    intro: 'Stocking stuffers should be small, fast, and more memorable than their size suggests.',
    keywords: ['stocking', 'stuffer', 'holiday', 'christmas', 'small', 'gag', 'prank', 'funny'],
  },
  {
    slug: 'white-elephant-gifts-for-adults',
    title: 'White Elephant Gifts for Adults',
    h1: 'White elephant gifts for adults who want the room to react',
    description: 'Find white elephant gifts for adults, funny party exchange ideas, and weird gag products.',
    intro: 'Adult gift exchanges reward gifts that are clear, funny, and just useful enough to keep after the laugh.',
    keywords: ['white elephant', 'adult', 'adults', 'party', 'exchange', 'gag', 'weird', 'funny'],
  },
  {
    slug: 'gifts-for-people-who-have-everything',
    title: 'Funny Gifts for People Who Have Everything',
    h1: 'Funny gifts for people who have everything except this nonsense',
    description: 'Find funny gifts for people who have everything, weird catalog picks, practical gag gifts, and oddball products.',
    intro: 'When someone already owns the sensible options, specificity and absurdity become the advantage.',
    keywords: ['everything', 'hard to shop', 'weird', 'novelty', 'gag', 'odd', 'unique', 'funny'],
  },
  {
    slug: 'funny-gifts-for-men',
    title: 'Funny Gifts for Men',
    h1: 'Funny gifts for men that are better than another multitool',
    description: 'Browse funny gifts for men, dad jokes, practical novelty products, and weird finds for hard-to-shop-for guys.',
    intro: 'The best funny gifts for men are specific enough to feel chosen and useful enough not to vanish into a drawer.',
    keywords: ['men', 'man', 'dad', 'grandpa', 'gadget', 'joke', 'sports', 'grill'],
  },
  {
    slug: 'funny-gifts-for-women',
    title: 'Funny Gifts for Women',
    h1: 'Funny gifts for women that are playful without being lazy',
    description: 'Find funny gifts for women, friend gifts, beauty gag gifts, self-care jokes, and novelty products.',
    intro: 'Funny gifts work best when they match a real interest first and make the joke second.',
    keywords: ['women', 'woman', 'friend', 'beauty', 'makeup', 'self care', 'spa', 'birthday'],
  },
  {
    slug: 'sarcastic-gifts',
    title: 'Sarcastic Gifts',
    h1: 'Sarcastic gifts for people fluent in side-eye',
    description: 'Browse sarcastic gifts, snarky desk finds, funny mugs, and gag products for dry-humor people.',
    intro: 'Sarcastic gifts need a sharp edge but not a mean one. The best ones feel like an inside joke.',
    keywords: ['sarcastic', 'snark', 'snarky', 'joke', 'office', 'mug', 'desk', 'gag'],
  },
  {
    slug: 'funny-cooking-gifts',
    title: 'Funny Cooking Gifts',
    h1: 'Funny cooking gifts for kitchens that already have the basics',
    description: 'Shop funny cooking gifts, weird kitchen tools, novelty food gifts, and practical gadgets.',
    intro: 'Kitchen gifts are strongest when they are actually useful once and funny every time they appear.',
    keywords: ['cooking', 'cook', 'kitchen', 'food', 'gadget', 'mug', 'coffee', 'weird'],
  },
  {
    slug: 'weird-home-decor-gifts',
    title: 'Weird Home Decor Gifts',
    h1: 'Weird home decor gifts for people who do not want another beige thing',
    description: 'Find weird home decor gifts, oddball shelf pieces, funny housewarming gifts, and novelty room finds.',
    intro: 'Weird decor works when it gives a room a story without requiring a full explanation.',
    keywords: ['home-decor', 'decor', 'home', 'housewarming', 'weird', 'candle', 'statue', 'novelty'],
  },
  {
    slug: 'optical-illusion-decor-gifts',
    title: 'Optical Illusion Decor Gifts',
    h1: 'Optical illusion decor gifts for rooms that need a double take',
    description: 'Browse optical illusion decor gifts, weird statues, odd shelf pieces, and conversation-starting home finds.',
    intro: 'Optical illusion decor works when the joke is visual before anyone reads the box. These picks are built for shelves, desks, and rooms that need one strange focal point.',
    keywords: ['optical', 'illusion', 'decor', 'statue', 'home', 'weird', 'shelf', 'novelty'],
  },
  {
    slug: 'funny-gifts-for-teachers',
    title: 'Funny Gifts for Teachers',
    h1: 'Funny gifts for teachers who have earned the joke',
    description: 'Browse funny teacher gifts, classroom-safe gag gifts, desk items, mugs, and practical novelty finds.',
    intro: 'Teacher gifts should be useful, respectful, and funny enough to survive the last week of school.',
    keywords: ['teacher', 'school', 'classroom', 'desk', 'coffee', 'mug', 'office-safe', 'work'],
  },
  {
    slug: 'funny-gifts-for-nurses',
    title: 'Funny Gifts for Nurses',
    h1: 'Funny gifts for nurses with a strong tolerance for chaos',
    description: 'Find funny nurse gifts, work-safe gag gifts, coffee gifts, desk finds, and self-care novelty products.',
    intro: 'Nurse gifts should respect the job and still acknowledge that the shift probably deserves a laugh.',
    keywords: ['nurse', 'healthcare', 'work', 'coffee', 'mug', 'self care', 'office-safe', 'sarcastic'],
  },
  {
    slug: 'funny-book-lover-gifts',
    title: 'Funny Book Lover Gifts',
    h1: 'Funny book lover gifts for readers with shelf control issues',
    description: 'Browse funny book lover gifts, trivia books, coloring books, journals, and bookish gag finds.',
    intro: 'Bookish gifts work when they fit the ritual: reading, collecting, annotating, or avoiding people politely.',
    keywords: ['book', 'bookish', 'reader', 'reading', 'journal', 'coloring', 'trivia', 'coffee'],
  },
  {
    slug: 'funny-sports-fan-gifts',
    title: 'Funny Sports Fan Gifts',
    h1: 'Funny sports fan gifts for people who narrate the game from the couch',
    description: 'Find funny sports fan gifts, soccer finds, game-day gag gifts, and novelty products for competitive people.',
    intro: 'Sports gifts are easiest when they combine team-day usefulness with a joke that lands before kickoff.',
    keywords: ['sports', 'soccer', 'game', 'fan', 'dad', 'party', 'gadget', 'funny'],
  },
  {
    slug: 'funny-wine-gifts',
    title: 'Funny Wine Gifts',
    h1: 'Funny wine gifts for people who bring commentary with the bottle',
    description: 'Browse funny wine gifts, drinkware, kitchen gag gifts, party products, and silly host gifts.',
    intro: 'Wine gifts should either help pour the drink, protect the table, or make the next toast a little less dignified.',
    keywords: ['wine', 'drink', 'party', 'kitchen', 'glass', 'host', 'friend', 'gag'],
  },
  {
    slug: 'funny-bath-gifts',
    title: 'Funny Bath Gifts',
    h1: 'Funny bath gifts for people who deserve dramatic relaxation',
    description: 'Find funny bath gifts, bath bombs, spa gag gifts, self-care novelty products, and weird bathroom finds.',
    intro: 'Bath gifts can be soothing and ridiculous at the same time, which is exactly why they work.',
    keywords: ['bath', 'bath bomb', 'spa', 'self care', 'skincare', 'bathroom', 'candle', 'novelty'],
  },
  {
    slug: 'adult-coloring-book-gifts',
    title: 'Adult Coloring Book Gifts',
    h1: 'Adult coloring book gifts for stress, jokes, and questionable themes',
    description: 'Browse adult coloring book gifts, funny activity books, pet coloring books, holiday coloring books, and weird book finds.',
    intro: 'A coloring book gift is low pressure, easy to wrap, and surprisingly specific when the theme is strange enough.',
    keywords: ['adult-coloring', 'coloring', 'book', 'activity', 'stress', 'holiday', 'pet', 'funny'],
  },
  {
    slug: 'funny-halloween-gifts',
    title: 'Funny Halloween Gifts',
    h1: 'Funny Halloween gifts for spooky people with a sense of humor',
    description: 'Find funny Halloween gifts, spooky novelty products, horror coloring books, and weird seasonal gag gifts.',
    intro: 'Halloween gifts get to be theatrical, strange, and seasonal without apologizing for it.',
    keywords: ['halloween', 'horror', 'spooky', 'holiday', 'weird', 'candy', 'party', 'gag'],
  },
  {
    slug: 'funny-christmas-gifts',
    title: 'Funny Christmas Gifts',
    h1: 'Funny Christmas gifts that do more than fill wrapping paper',
    description: 'Browse funny Christmas gifts, holiday gag gifts, stocking stuffers, and white elephant-ready products.',
    intro: 'Christmas gag gifts work best when they fit the person, the party, or the stocking without needing a long setup.',
    keywords: ['christmas', 'holiday', 'stocking', 'white elephant', 'secret santa', 'party', 'gag', 'funny'],
  },
  {
    slug: 'funny-valentines-gifts',
    title: 'Funny Valentines Gifts',
    h1: 'Funny Valentines gifts for people who prefer jokes with affection',
    description: 'Find funny Valentines gifts, silly couple gifts, candles, self-care finds, and romantic gag products.',
    intro: 'A funny Valentines gift should feel affectionate first and unserious second.',
    keywords: ['valentine', 'valentines', 'couple', 'friendship', 'candle', 'spa', 'beauty', 'gag'],
  },
  {
    slug: 'funny-gifts-for-moms',
    title: 'Funny Gifts for Moms',
    h1: 'Funny gifts for moms who deserve better than another plain candle',
    description: 'Browse funny gifts for moms, mom gag gifts, coffee finds, self-care jokes, and useful novelty products.',
    intro: 'Mom gifts work best when they feel useful, personal, and just ridiculous enough to prove you did not panic-buy the first beige thing.',
    keywords: ['mom', 'mother', 'mama', 'coffee', 'self care', 'spa', 'kitchen', 'women'],
  },
  {
    slug: 'funny-gifts-for-gamers',
    title: 'Funny Gifts for Gamers',
    h1: 'Funny gifts for gamers who already have the serious gear',
    description: 'Find funny gamer gifts, gaming desk finds, controller-adjacent jokes, and novelty products for people who live in side quests.',
    intro: 'Gamer gifts should fit the setup, the desk, or the running joke. The best ones feel like a side quest with free shipping.',
    keywords: ['gamer', 'gaming', 'game', 'controller', 'desk', 'keyboard', 'nerd', 'geek'],
  },
  {
    slug: 'funny-golf-gifts',
    title: 'Funny Golf Gifts',
    h1: 'Funny golf gifts for people who narrate every bad shot',
    description: 'Browse funny golf gifts, golfer gag gifts, dad golf finds, and novelty game-day products from the goose.gifts catalog.',
    intro: 'Golf gifts have permission to be practical, smug, and a little too specific. That is the whole sport.',
    keywords: ['golf', 'golfer', 'club', 'tee', 'sports', 'dad', 'outdoor', 'game'],
  },
  {
    slug: 'funny-gardening-gifts',
    title: 'Funny Gardening Gifts',
    h1: 'Funny gardening gifts for plant people with dirt under control',
    description: 'Shop funny gardening gifts, plant lover finds, yard jokes, and useful novelty products for people who treat seedlings like pets.',
    intro: 'Gardening gifts are strongest when they belong outside, near a windowsill, or in the hands of someone who has opinions about soil.',
    keywords: ['garden', 'gardening', 'plant', 'plants', 'yard', 'outdoor', 'mom', 'dad'],
  },
  {
    slug: 'funny-hostess-gifts',
    title: 'Funny Hostess Gifts',
    h1: 'Funny hostess gifts that do more than replace the wine',
    description: 'Find funny hostess gifts, party host finds, kitchen jokes, wine-adjacent gifts, and housewarming-ready novelty products.',
    intro: 'A good host gift should be easy to hand over, useful after the party, and strange enough to remember who brought it.',
    keywords: ['host', 'hostess', 'party', 'wine', 'kitchen', 'home', 'candle', 'housewarming'],
  },
];

export function getGiftGuide(slug: string): GiftGuideDefinition | undefined {
  return giftGuides.find((guide) => guide.slug === slug);
}

export const featuredGiftGuideSlugs = [
  'white-elephant-gifts',
  'funny-gifts-for-coworkers',
  'funny-gifts-for-dads',
  'weird-kitchen-gadgets',
  'novelty-desk-toys',
  'secret-santa-gag-gifts',
  'cat-lover-gag-gifts',
  'dog-lover-gag-gifts',
  'prank-gifts-for-friends',
  'funny-birthday-gag-gifts',
  'funny-coffee-mugs',
  'funny-poop-gifts',
  'funny-gifts-for-dads-who-fish',
  'gifts-for-people-who-have-everything',
  'funny-gifts-for-moms',
  'funny-gifts-for-gamers',
  'funny-golf-gifts',
  'funny-gardening-gifts',
  'funny-hostess-gifts',
];

export function getFeaturedGiftGuides(
  activeSlug?: string,
  limit: number = 12
): GiftGuideDefinition[] {
  const featuredGuides = featuredGiftGuideSlugs
    .map((slug) => getGiftGuide(slug))
    .filter((guide): guide is GiftGuideDefinition => Boolean(guide));

  if (!activeSlug || featuredGuides.some((guide) => guide.slug === activeSlug)) {
    return featuredGuides.slice(0, limit);
  }

  const activeGuide = getGiftGuide(activeSlug);

  return activeGuide
    ? [activeGuide, ...featuredGuides.slice(0, Math.max(0, limit - 1))]
    : featuredGuides.slice(0, limit);
}

