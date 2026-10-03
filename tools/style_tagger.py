"""StyleDNA listing tagger.

Reads a Matrix "Export for Chloe Data - Active Listings" CSV (private remarks removed)
and tags every listing with a StyleDNA style, archetype scores, finish level and the
signals behind them. Text-only: photo checks are done separately and recorded as overrides.

Usage: python3 style_tagger.py <in.csv> <out.csv> [<out.json>]
"""
import csv
import json
import re
import sys

ARCHES = ['curator', 'sanctuary', 'architect', 'custodian', 'visionary', 'authenticist']

# Style vocabulary. Order matters: more specific phrases first.
# (style, primary archetype, secondary archetype, patterns)
STYLES = [
    ('Modern Farmhouse', 'architect', 'sanctuary', [r'modern farm ?house', r'farmhouse[- ]modern']),
    ('Mid-Century Modern', 'custodian', 'visionary', [r'mid[- ]?century', r'\bmcm\b', r'atomic ranch']),
    ('Tudor', 'custodian', 'curator', [r'\btudor\b']),
    ('Craftsman', 'custodian', 'authenticist', [r'\bcraftsman(?!ship)(?! quality)', r'\bbungalow\b', r'prairie[- ]style']),
    ('Colonial / Georgian', 'custodian', 'curator', [r'georgian', r'\bcolonial\b', r'federal[- ]style']),
    ('French / European', 'curator', 'custodian', [r'french (country|provincial|chateau|inspired|traditional|normandy|style)', r'chateau', r'european[- ](estate|villa|manor)', r'old[- ]world']),
    ('Mediterranean / Spanish', 'architect', 'custodian', [r'mediterranean', r'spanish', r'tuscan', r'hacienda', r'santa barbara']),
    ('Hill Country', 'authenticist', 'custodian', [r'hill country', r'austin stone', r'texas (limestone|stone)', r'limestone (exterior|facade)']),
    ('Organic Modern', 'visionary', 'sanctuary', [r'organic modern', r'japandi', r'warm modern', r'soft modern']),
    ('Scandinavian', 'sanctuary', 'visionary', [r'scandinavian', r'nordic']),
    ('Modern / Contemporary', 'visionary', 'curator', [r'(modern|contemporary) (home|residence|design|architecture|masterpiece|build|estate|retreat|compound|style)', r'(sleek|striking|stunning|architecturally (considered|significant|designed)|custom|true|bold|ultra|soft) (modern|contemporary)', r'architectural (masterpiece|gem)', r'clean[- ]lined', r'clean lines', r'minimalist']),
    ('Industrial', 'visionary', 'architect', [r'industrial (style|design|chic|vibe|modern|loft|feel)', r'warehouse (conversion|loft)', r'exposed (ductwork|concrete ceiling)']),
    ('Transitional', 'sanctuary', 'custodian', [r'transitional']),
    ('Farmhouse', 'authenticist', 'sanctuary', [r'farm ?house']),
    ('Ranch / Rustic', 'authenticist', 'architect', [r'\branch[- ]style\b', r'rustic', r'barndominium', r'reclaimed']),
    ('Cottage', 'custodian', 'sanctuary', [r'cottage', r'storybook']),
    ('Traditional', 'custodian', 'sanctuary', [r'traditional (home|style|architecture|design|elegance|two[- ]story|brick)', r'classic (home|elegance|design|architecture|traditional)', r'timeless (architecture|traditional|elegance)']),
]

# Lifestyle and character signals: (label, archetype, weight, patterns)
SIGNALS = [
    ('entertaining', 'architect', 0.75, [r'entertainer\'?s (dream|paradise|delight)', r'made for (entertaining|hosting)', r'host(ing)? (large|holiday|friends|family)', r'perfect for (entertaining|hosting)']),
    ('outdoor kitchen', 'architect', 1.5, [r'outdoor kitchen', r'summer kitchen', r'outdoor living (center|area|space)']),
    ('game or media room', 'architect', 1.0, [r'game ?room', r'media ?room', r'theater', r'theatre', r'bonus room']),
    ('wet bar', 'architect', 1.0, [r'wet bar', r'dry bar', r'wine bar', r'bar area']),
    ('open concept', 'architect', 0.5, [r'open[- ]concept', r'open floor ?plan', r'open layout']),
    ('pool', 'architect', 1.0, [r'\bpool\b']),
    ('spa primary', 'sanctuary', 1.5, [r'spa[- ]like', r'spa[- ]inspired', r'sanctuary', r'serene', r'tranquil', r'peaceful', r'private retreat']),
    ('sunroom', 'sanctuary', 1.0, [r'sun ?room', r'sunroom', r'light[- ]filled', r'bright and airy', r'abundant natural light']),
    ('quiet street', 'sanctuary', 0.5, [r'quiet (street|cul|neighborhood)', r'cul[- ]de[- ]sac', r'private (backyard|yard|setting)']),
    ('designer finishes', 'curator', 1.5, [r'designer', r'custom (millwork|cabinetry|finishes)', r'curated', r'bespoke', r'gallery', r'art (wall|niche|lighting)']),
    ('wine room', 'curator', 1.5, [r'wine (room|cellar|storage|wall)']),
    ('statement kitchen', 'curator', 1.0, [r'chef\'?s kitchen', r'gourmet kitchen', r'waterfall (island|edge)', r'statement (lighting|chandelier|kitchen|staircase)']),
    ('historic character', 'custodian', 1.5, [r'historic', r'original (hardwood|wood|built|trim|character|details)', r'restored', r'period (details|charm)', r'vintage charm', r'old[- ]world charm', r'exposed brick', r'(19[0-4]\d)s? (home|charm|bungalow|tudor)']),
    ('formal rooms', 'custodian', 1.0, [r'formal (dining|living)', r'library', r'study with']),
    ('natural materials', 'authenticist', 1.5, [r'shiplap', r'(exposed|wood|cedar) beams?', r'barn door', r'stone fireplace', r'reclaimed', r'natural (stone|wood|materials)', r'butcher ?block']),
    ('land', 'authenticist', 1.5, [r'\bbarn\b', r'workshop', r'horse', r'pasture', r'\bstalls?\b', r'vegetable garden', r'garden beds']),
    ('smart and new', 'visionary', 1.0, [r'smart home', r'smart[- ]home', r'floor[- ]to[- ]ceiling', r'walls? of (glass|windows)', r'flat roof', r'innovative', r'sleek', r'floating (stair|vanit)']),
]

LUX_APPLIANCES = [r'sub[- ]?zero', r'\bwolf\b', r'thermador', r'viking', r'miele', r'gaggenau', r'la cornue', r'monogram', r'dacor', r'jennair', r'jenn[- ]air', r'bosch', r'commercial grade', r'built[- ]in refrigerator', r'wine (cooler|refrigerator|fridge)']
LUX_SURFACES = [r'quartzite', r'marble', r'calacatta', r'waterfall']
MID_SURFACES = [r'quartz', r'granite']


def find(patterns, text):
    hits = []
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            hits.append(m.group(0).lower())
    return hits


def tag(row):
    desc = row.get('Property Description', '') or ''
    feats = ' | '.join(row.get(k, '') or '' for k in ['Appliances', 'Interior Features', 'Exterior Features', 'Construction Materials', 'Flooring', 'Pool Features'])
    text = desc + ' || ' + feats
    year = int(re.sub(r'\D', '', row.get('Year Built', '') or '0') or 0)
    acres = float(re.sub(r'[^\d.]', '', row.get('Lot Size Area', '') or '0') or 0)
    if acres > 200:  # Matrix reports small lots in square feet
        acres = round(acres / 43560, 2)
    pool = (row.get('Pool YN', '') or '').lower() == 'yes'

    score = {a: 0.0 for a in ARCHES}
    why = []

    # Style: first match in the description wins; features text only as a fallback.
    style, style_hits = None, []
    for name, prim, sec, pats in STYLES:
        h = find(pats, desc)
        if h:
            style, style_hits = (name, prim, sec), h
            break
    if style:
        name, prim, sec = style
        if name == 'Farmhouse' and year >= 2015:
            style = ('Modern Farmhouse', 'architect', 'sanctuary')
            name, prim, sec = style
        score[prim] += 4
        score[sec] += 1.5
        why.append(f'style words: {", ".join(sorted(set(style_hits)))}')

    signals = []
    for label, arch, w, pats in SIGNALS:
        h = find(pats, text)
        if label == 'pool' and not (pool or h):
            continue
        if label == 'land' and acres >= 1:
            h = h or [f'{acres:g} acres']
        if h:
            score[arch] += w
            signals.append(label)
    if signals:
        why.append('signals: ' + ', '.join(signals))

    # Age and era nudges, kept small.
    if year and year < 1950:
        score['custodian'] += 1.0
    elif year >= 2022:
        score['visionary'] += 0.5

    lux = find(LUX_APPLIANCES, text) + find(LUX_SURFACES, text)
    mid = find(MID_SURFACES, text)
    finish = 'Luxury' if len(set(lux)) >= 2 else ('Upgraded' if lux or mid else 'Standard')
    if finish == 'Luxury':
        score['curator'] += 1.0
    why.append(f'finish: {finish}' + (f' ({", ".join(sorted(set(lux))[:4])})' if lux else ''))

    ranked = sorted(ARCHES, key=lambda a: -score[a])
    top, second = ranked[0], ranked[1]
    total = sum(score.values())
    confident = bool(style) and score[top] >= 4
    if not style and score[top] < 3:
        confidence = 'Low'
    elif confident and score[top] - score[second] >= 2:
        confidence = 'High'
    else:
        confidence = 'Medium'

    return {
        'mls': row.get('ML #', ''),
        'status': row.get('Mls Status', ''),
        'address': re.sub(r'\s+', ' ', row.get('Address', '')).strip(),
        'city': row.get('City', ''),
        'subdivision': row.get('Subdivision Name', ''),
        'price': row.get('Current Price', ''),
        'year_built': year or '',
        'sqft': row.get('SqFt', ''),
        'beds': row.get('Beds Total', ''),
        'baths': row.get('Bath Total', ''),
        'acres': acres or '',
        'pool': 'Yes' if pool else 'No',
        'cdom': row.get('CDOM', ''),
        'styledna_style': style[0] if style else 'Not confirmed',
        'style_source': 'listing text' if style else 'blank',
        'archetype': top,
        'archetype_2': second,
        'confidence': confidence,
        'finish_level': finish,
        'signals': '; '.join(signals),
        'why': ' | '.join(why),
        **{f'score_{a}': round(score[a], 1) for a in ARCHES},
        'description': desc,
    }


def main():
    src, out = sys.argv[1], sys.argv[2]
    rows = list(csv.DictReader(open(src, encoding='utf-8-sig')))
    tagged = [tag(r) for r in rows]
    cols = list(tagged[0].keys())
    with open(out, 'w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(tagged)
    if len(sys.argv) > 3:
        json.dump(tagged, open(sys.argv[3], 'w'))
    from collections import Counter
    print('rows', len(tagged))
    print('styles', Counter(t['styledna_style'] for t in tagged).most_common())
    print('archetypes', Counter(t['archetype'] for t in tagged).most_common())
    print('confidence', Counter(t['confidence'] for t in tagged).most_common())
    print('finish', Counter(t['finish_level'] for t in tagged).most_common())


if __name__ == '__main__':
    main()
