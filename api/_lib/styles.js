// The home styles StyleDNA works with: architecture you can see from the street, the way the MLS
// files it. Each style finds homes either by the MLS "Style" field or, when the MLS has no such
// value, by words in the listing remarks. "legacy" maps to the six original personas so older
// boards and the Mac-side picks script keep working.
const STYLES = [
  { k: 'traditional', label: 'Traditional', desc: 'Brick, pitched roof, classic front', q: { style: ['Traditional'] }, legacy: 'custodian' },
  { k: 'farmhouse', label: 'Modern Farmhouse', desc: 'White siding, black windows, front porch', q: { keyword: ['modern farmhouse'] }, legacy: 'architect' },
  { k: 'craftsman', label: 'Craftsman', desc: 'Deep porch, tapered columns, wood trim', q: { style: ['Craftsman'] }, legacy: 'custodian' },
  { k: 'modern', label: 'Modern', desc: 'Clean lines, flat roofs, big glass', q: { style: ['Contemporary/Modern'] }, legacy: 'visionary' },
  { k: 'ranch', label: 'Ranch', desc: 'One story, long and low', q: { style: ['Ranch'] }, legacy: 'authenticist' },
  { k: 'midcentury', label: 'Mid-Century Modern', desc: 'Low roofline, walls of windows', q: { style: ['Mid-Century Modern'] }, legacy: 'visionary' },
  { k: 'mediterranean', label: 'Mediterranean', desc: 'Stucco, tile roof, arches', q: { style: ['Mediterranean'] }, legacy: 'architect' },
  { k: 'spanish', label: 'Spanish', desc: 'White stucco, red clay tile', q: { style: ['Spanish'] }, legacy: 'architect' },
  { k: 'tudor', label: 'Tudor', desc: 'Steep gables, brick and timber', q: { style: ['Tudor'] }, legacy: 'custodian' },
  { k: 'french', label: 'French Country', desc: 'Steep hip roof, stone, arched windows', q: { keyword: ['french country', 'french provincial', 'french chateau'] }, legacy: 'curator' },
  { k: 'colonial', label: 'Colonial', desc: 'Two stories, centered door, columns', q: { style: ['Colonial'] }, legacy: 'custodian' },
  { k: 'english', label: 'English Cottage', desc: 'Brick and stone, arched door, steep roof', q: { style: ['English'] }, legacy: 'custodian' },
  { k: 'hillcountry', label: 'Hill Country', desc: 'Limestone, metal roof, deep porches', q: { keyword: ['hill country'] }, legacy: 'authenticist' },
  { k: 'barndo', label: 'Barndominium', desc: 'Metal barn-style home, wide open inside', q: { style: ['Barndominium'] }, legacy: 'authenticist' },
  { k: 'prairie', label: 'Prairie', desc: 'Low hip roof, long horizontal lines', q: { style: ['Prairie'] }, legacy: 'sanctuary' },
  { k: 'victorian', label: 'Victorian', desc: 'Wraparound porch, turrets, ornate trim', q: { style: ['Victorian'] }, legacy: 'custodian' },
  { k: 'southwestern', label: 'Southwestern', desc: 'Earth-tone stucco, flat roof, rounded walls', q: { style: ['Southwestern'] }, legacy: 'authenticist' },
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
