// The home styles StyleDNA works with: architecture you can see from the street.
// A home's style comes from reading its front photo (see phototag.js), because MLS style labels
// are often wrong. "q" is only how we go looking for candidates of each style on joshwaters.com
// (the MLS Style field, or words in the remarks), and how "see them all" links search.
// "legacy" maps to the six original personas so older boards and the Mac-side picks keep working.
const STYLES = [
  { k: 'traditional', label: 'Traditional', desc: 'Brick or stone, pitched roofs, classic front', q: { style: ['Traditional'] }, legacy: 'custodian' },
  { k: 'transitional', label: 'Transitional', desc: 'Light brick, black windows, simple lines', q: { keyword: ['transitional'] }, legacy: 'sanctuary' },
  { k: 'farmhouse', label: 'Modern Farmhouse', desc: 'Board and batten, black trim, gables', q: { keyword: ['modern farmhouse'] }, legacy: 'architect' },
  { k: 'modern', label: 'Modern', desc: 'Clean lines, flat roofs, big glass', q: { style: ['Contemporary/Modern'] }, legacy: 'visionary' },
  { k: 'craftsman', label: 'Craftsman', desc: 'Front porch, tapered columns, wood trim', q: { style: ['Craftsman'] }, legacy: 'custodian' },
  { k: 'ranch', label: 'Ranch', desc: 'One story, long and low', q: { style: ['Ranch'] }, legacy: 'authenticist' },
  { k: 'midcentury', label: 'Mid-Century Modern', desc: 'Low roofline, wide overhangs, big windows', q: { style: ['Mid-Century Modern'] }, legacy: 'visionary' },
  { k: 'tudor', label: 'Tudor', desc: 'Steep gables, brick, stone and timber', q: { style: ['Tudor'] }, legacy: 'custodian' },
  { k: 'mediterranean', label: 'Mediterranean', desc: 'Stucco, tile roof, arches', q: { style: ['Mediterranean', 'Spanish'] }, legacy: 'architect' },
  { k: 'french', label: 'French Country', desc: 'Tall hip roof, stone, formal symmetry', q: { keyword: ['french country', 'french provincial', 'french chateau'] }, legacy: 'curator' },
  { k: 'colonial', label: 'Colonial', desc: 'Symmetrical two-story, columns, shutters', q: { style: ['Colonial'] }, legacy: 'custodian' },
  { k: 'cottage', label: 'Cottage', desc: 'Smaller scale, painted brick, charm', q: { style: ['English'] }, legacy: 'custodian' },
  { k: 'hillcountry', label: 'Hill Country', desc: 'Limestone, metal roof, deep porches', q: { keyword: ['hill country'] }, legacy: 'authenticist' },
  { k: 'barndo', label: 'Barndominium', desc: 'Metal barn-style home, wide open inside', q: { style: ['Barndominium'] }, legacy: 'authenticist' },
];
const BY_KEY = Object.fromEntries(STYLES.map((s) => [s.k, s]));
const label = (k) => (BY_KEY[k] && BY_KEY[k].label) || '';

// Counties StyleDNA covers, with a center point for "closest area" suggestions.
const COUNTIES = {
  Dallas: [32.77, -96.78], Collin: [33.19, -96.57], Denton: [33.21, -97.12], Tarrant: [32.77, -97.29],
  Rockwall: [32.90, -96.40], Kaufman: [32.60, -96.29], Ellis: [32.35, -96.80], Johnson: [32.38, -97.37],
  Parker: [32.78, -97.80], Wise: [33.22, -97.65], Hunt: [33.12, -96.08], Grayson: [33.63, -96.68], Hood: [32.43, -97.83],
};

module.exports = { STYLES, BY_KEY, label, COUNTIES };
