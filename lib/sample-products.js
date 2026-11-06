// FARQ catalog (from farqthebrand.com, gathered via web search, November 2026).
// Product images are illustrations: replace them with real photos in /admin → Products.
// Individual products are sold inside the kits; the kits are the purchasable items.
const one = (id, stock = 999) => [{ id: `${id}-default`, color: null, size: null, stock }];

export const SAMPLE_PRODUCTS = [
  {
    id: 'farq-full-kit', name: 'The Full Kit', category: 'Kits', active: true,
    price: 198, compareAtPrice: null, priceNote: 'per 3 months · subscription (starting price)',
    images: ['/images/farq/kit-full.svg'],
    description: 'The complete FARQ AM/PM routine: all four products. Two minutes, twice a day, every day. Built on maintenance, not correction, for men’s skin over 35.',
    highlights: ['All 4 products: 001, 002, 003 and 004', 'Complete morning + evening routine', 'Costs less than buying the AM Kit and PM Kit separately'],
    tags: ['kit', 'routine', 'full', 'complete', 'am', 'pm', 'subscription', 'best value', 'anti-aging', 'gift'],
    includes: ['farq-001', 'farq-002', 'farq-003', 'farq-004'],
    variants: one('farq-full-kit'),
  },
  {
    id: 'farq-am-kit', name: 'The AM Kit', category: 'Kits', active: true,
    price: 108, compareAtPrice: null, priceNote: 'per 3 months · subscription (starting price)',
    images: ['/images/farq/kit-am.svg'],
    description: 'The FARQ morning routine: 001 Antioxidant Formula + 002 Active Barrier Moisturizer.',
    highlights: ['001 Antioxidant Formula', '002 Active Barrier Moisturizer', 'Brighten, defend and hydrate every morning'],
    tags: ['kit', 'morning', 'am', 'vitamin c', 'moisturizer', 'subscription'],
    includes: ['farq-001', 'farq-002'],
    variants: one('farq-am-kit'),
  },
  {
    id: 'farq-pm-kit', name: 'The PM Kit', category: 'Kits', active: true,
    price: 108, compareAtPrice: null, priceNote: 'per 3 months · subscription (starting price)',
    images: ['/images/farq/kit-pm.svg'],
    description: 'The FARQ evening routine: 003 Reset Cleanser + 004 Recovery Moisturizer.',
    highlights: ['003 Reset Cleanser', '004 Recovery Moisturizer', 'Clean, then repair overnight'],
    tags: ['kit', 'evening', 'night', 'pm', 'cleanser', 'retinoid', 'subscription'],
    includes: ['farq-003', 'farq-004'],
    variants: one('farq-pm-kit'),
  },
  {
    id: 'farq-001', name: '001 Antioxidant Formula', category: 'AM routine', active: true,
    price: 0, notForSale: true, availableIn: ['farq-am-kit', 'farq-full-kit'],
    images: ['/images/farq/001-antioxidant-formula.svg'],
    description: 'A double vitamin C combination for your face each morning to brighten, defend against oxidative stress and visibly reduce overnight puffiness.',
    highlights: ['15% Ascorbyl Glucoside Solution (vitamin C) – brightens dull skin and helps fade the look of dark spots', '3% THD Ascorbate – a deeper-reaching vitamin C that helps skin look firmer and smooths the look of fine lines', '1% Caffeine – visibly reduces overnight puffiness', '1% Hyaluronic Acid Solution'],
    tags: ['vitamin c', 'antioxidant', 'serum', 'morning', 'puffiness', 'dull skin', 'dark spots', 'fine lines'],
    variants: one('farq-001'),
  },
  {
    id: 'farq-002', name: '002 Active Barrier Moisturizer', category: 'AM routine', active: true,
    price: 0, notForSale: true, availableIn: ['farq-am-kit', 'farq-full-kit'],
    images: ['/images/farq/002-active-barrier-moisturizer.svg'],
    description: 'Strengthens the skin barrier and helps keep moisture where it belongs throughout the day.',
    highlights: ['5% Niacinamide', '2% Ectoin'],
    tags: ['moisturizer', 'barrier', 'niacinamide', 'ectoin', 'morning', 'dry skin', 'shaving irritation'],
    variants: one('farq-002'),
  },
  {
    id: 'farq-003', name: '003 Reset Cleanser', category: 'PM routine', active: true,
    price: 0, notForSale: true, availableIn: ['farq-pm-kit', 'farq-full-kit'],
    images: ['/images/farq/003-reset-cleanser.svg'],
    description: 'By evening your skin has collected a day’s worth of sebum, pollution and dead skin cells. Reset clears it at the pore level without stripping what’s underneath.',
    highlights: ['2% Salicylic Acid', 'Aloe Vera'],
    tags: ['cleanser', 'face wash', 'salicylic acid', 'pores', 'oily skin', 'evening'],
    variants: one('farq-003'),
  },
  {
    id: 'farq-004', name: '004 Recovery Moisturizer', category: 'PM routine', active: true,
    price: 0, notForSale: true, availableIn: ['farq-pm-kit', 'farq-full-kit'],
    images: ['/images/farq/004-recovery-moisturizer.svg'],
    description: 'With your skin clean, it’s ready to repair. HPR, a next-generation retinol, works alongside your skin’s overnight renewal, helping improve texture, tone and smoothness.',
    highlights: ['10% Peptide Complex', '2% Granactive™ Retinoid Pro+ (HPR, next-generation retinol)', '0.5% Ceramide NP'],
    tags: ['retinol', 'retinoid', 'peptides', 'night cream', 'moisturizer', 'wrinkles', 'texture', 'evening'],
    variants: one('farq-004'),
  },
];
