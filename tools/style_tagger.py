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


# Structured MLS field values (exact Matrix picklist values) -> (archetype, points, label).
# These are more reliable than remarks because the listing agent picks them from a list.
FIELD_SIGNALS = {
    'Appliances': {
        'Commercial Grade Range': [('curator', 1.0, 'commercial range'), ('architect', 0.5, 'commercial range')],
        'Commercial Grade Vent': [('curator', 0.5, 'commercial vent')],
        'Built-in Refrigerator': [('curator', 0.75, 'built-in fridge')],
        'Built-in Gas Range': [('curator', 0.5, 'built-in gas range')],
        'Oven-Double': [('architect', 0.5, 'double oven')],
        'Warming Drawer': [('architect', 0.5, 'warming drawer')],
        'Built-in Coffee Maker': [('curator', 0.5, 'built-in coffee')],
        'Indoor Grill': [('architect', 0.5, 'indoor grill')],
        'Ice Maker': [('architect', 0.25, 'ice maker')],
        'Water Purifier': [('sanctuary', 0.25, 'water purifier')],
        'Water Filter': [('sanctuary', 0.25, 'water filter')],
    },
    'Interior Features': {
        'Wet Bar': [('architect', 1.0, 'wet bar')],
        'Dry Bar': [('architect', 0.75, 'dry bar')],
        'Built-in Wine Cooler': [('curator', 0.5, 'wine cooler'), ('architect', 0.5, 'wine cooler')],
        'Sound System Wiring': [('architect', 0.5, 'sound system')],
        'Flat Screen Wiring': [('architect', 0.25, 'media wiring')],
        'Open Floorplan': [('architect', 0.5, 'open floorplan')],
        'Smart Home System': [('visionary', 1.0, 'smart home')],
        'Wired for Data': [('visionary', 0.5, 'wired for data')],
        'Elevator': [('visionary', 0.5, 'elevator'), ('curator', 0.5, 'elevator')],
        'Natural Woodwork': [('custodian', 1.0, 'natural woodwork')],
        'Paneling': [('custodian', 0.75, 'paneling')],
        'Wainscoting': [('custodian', 0.75, 'wainscoting')],
        'Built-in Features': [('custodian', 0.5, 'built-ins')],
        'Cedar Closet(s)': [('custodian', 0.5, 'cedar closet')],
        'Cathedral Ceiling(s)': [('architect', 0.25, 'cathedral ceiling')],
        'In-Law Suite Floorplan': [('sanctuary', 0.5, 'in-law suite')],
        'Second Primary Bedroom': [('sanctuary', 0.5, 'second primary')],
        'Double Vanity': [('sanctuary', 0.25, 'double vanity')],
        'Eat-in Kitchen': [('custodian', 0.25, 'eat-in kitchen')],
    },
    'Exterior Features': {
        'Outdoor Kitchen': [('architect', 1.5, 'outdoor kitchen')],
        'Outdoor Living Center': [('architect', 1.0, 'outdoor living center')],
        'Built-in Barbecue': [('architect', 0.75, 'built-in BBQ')],
        'Attached Grill': [('architect', 0.5, 'grill')],
        'Outdoor Grill': [('architect', 0.5, 'grill')],
        'Fire Pit': [('architect', 0.5, 'fire pit')],
        'Putting Green': [('architect', 0.75, 'putting green')],
        'Sport Court': [('architect', 0.75, 'sport court')],
        'Basketball Court': [('architect', 0.5, 'basketball court')],
        'Tennis Court(s)': [('architect', 0.75, 'tennis court')],
        'Courtyard': [('sanctuary', 0.75, 'courtyard')],
        'Covered Courtyard': [('sanctuary', 0.75, 'courtyard')],
        'Uncovered Courtyard': [('sanctuary', 0.75, 'courtyard')],
        'Private Yard': [('sanctuary', 0.5, 'private yard')],
        'Private Entrance': [('sanctuary', 0.5, 'private entrance')],
        'Garden(s)': [('authenticist', 0.75, 'gardens')],
        'Outdoor Shower': [('sanctuary', 0.5, 'outdoor shower')],
        'Stable/Barn': [('authenticist', 1.5, 'stable or barn')],
        'RV/Boat Parking': [('authenticist', 0.5, 'RV or boat parking')],
        'RV Hookup': [('authenticist', 0.5, 'RV hookup')],
        'Dog Run': [('authenticist', 0.5, 'dog run')],
        'Kennel': [('authenticist', 0.5, 'kennel')],
        'Rain Barrel/Cistern(s)': [('authenticist', 0.75, 'rain barrels')],
        'Permeable Paving': [('visionary', 0.5, 'permeable paving')],
    },
    'Construction Materials': {
        'Stucco': [('architect', 0.5, 'stucco'), ('custodian', 0.25, 'stucco')],
        'Board & Batten Siding': [('architect', 0.5, 'board and batten'), ('authenticist', 0.5, 'board and batten')],
        'Rock/Stone': [('authenticist', 0.5, 'stone exterior')],
        'Stone Veneer': [('authenticist', 0.25, 'stone veneer')],
        'Wood': [('authenticist', 0.5, 'wood exterior')],
        'Cedar': [('authenticist', 0.75, 'cedar')],
        'Log': [('authenticist', 1.0, 'log')],
        'Concrete': [('visionary', 0.75, 'concrete')],
        'Steel Siding': [('visionary', 0.75, 'steel siding')],
        'Metal Siding': [('visionary', 0.75, 'metal siding')],
        'Plaster': [('curator', 0.5, 'plaster')],
    },
    'Flooring': {
        'Marble': [('curator', 1.0, 'marble floors')],
        'Travertine Stone': [('curator', 0.5, 'travertine'), ('architect', 0.25, 'travertine')],
        'Terrazzo': [('visionary', 0.75, 'terrazzo'), ('curator', 0.5, 'terrazzo')],
        'Concrete': [('visionary', 0.75, 'concrete floors')],
        'Hardwood': [('custodian', 0.5, 'hardwood')],
        'Parquet': [('custodian', 0.75, 'parquet')],
        'Wood Under Carpet': [('custodian', 0.5, 'original wood under carpet')],
        'Reclaimed Wood': [('authenticist', 1.0, 'reclaimed wood')],
        'Slate': [('authenticist', 0.5, 'slate')],
        'Brick': [('authenticist', 0.75, 'brick floors')],
        'Brick/Adobe': [('authenticist', 0.75, 'brick floors')],
        'Stone': [('authenticist', 0.5, 'stone floors')],
        'Bamboo': [('visionary', 0.5, 'bamboo')],
    },
    'Pool Features': {
        'Pool/Spa Combo': [('sanctuary', 0.5, 'pool and spa'), ('architect', 0.25, 'pool and spa')],
        'Separate Spa/Hot Tub': [('sanctuary', 0.75, 'separate spa')],
        'Cabana': [('architect', 0.75, 'cabana')],
        'Sport': [('architect', 0.5, 'sport pool')],
        'Infinity': [('curator', 0.75, 'infinity edge')],
        'Lap': [('visionary', 0.5, 'lap pool'), ('sanctuary', 0.25, 'lap pool')],
        'Water Feature': [('sanctuary', 0.25, 'water feature')],
        'Indoor': [('curator', 0.75, 'indoor pool')],
    },
    'Parking Features': {
        'Porte-Cochere': [('curator', 0.75, 'porte-cochere')],
        'Electric Gate': [('curator', 0.5, 'gated drive')],
        'Circular Driveway': [('curator', 0.25, 'circular drive')],
        'Workshop in Garage': [('authenticist', 0.75, 'garage workshop')],
        'Oversized': [('authenticist', 0.25, 'oversized garage')],
        'Electric Vehicle Charging Station(s)': [('visionary', 0.5, 'EV charging')],
    },
    'Heating': {
        'Geothermal': [('visionary', 0.75, 'geothermal')],
        'Active Solar': [('visionary', 0.75, 'solar')],
        'Solar': [('visionary', 0.75, 'solar')],
        'Passive Solar': [('visionary', 0.5, 'passive solar')],
        'Radiant Heat Floors': [('sanctuary', 0.5, 'radiant floors')],
        'Wood Stove': [('authenticist', 0.5, 'wood stove')],
    },
}
LUX_FIELD_MARKERS = {'Commercial Grade Range', 'Commercial Grade Vent', 'Built-in Refrigerator', 'Warming Drawer', 'Built-in Coffee Maker', 'Indoor Grill', 'Marble', 'Travertine Stone', 'Terrazzo', 'Elevator'}

LUX_APPLIANCES = [r'sub[- ]?zero', r'\bwolf\b', r'thermador', r'viking', r'miele', r'gaggenau', r'la cornue', r'monogram', r'dacor', r'jennair', r'jenn[- ]air', r'commercial grade', r'built[- ]in refrigerator', r'wine (cooler|refrigerator|fridge)']
LUX_SURFACES = [r'quartzite', r'marble', r'calacatta', r'waterfall']
MID_SURFACES = [r'quartz', r'granite']


FREQ = {}  # label -> share of listings with it, filled in main()


def rarity(label):
    f = FREQ.get(label, 0.1)
    return max(0.3, min(1.0, 0.25 / f)) if f else 1.0


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
            score[arch] += w * rarity('t:' + label)
            signals.append(label)
    # Structured MLS fields (picklists)
    field_hits = []
    lux_fields = set()
    for fname, mapping in FIELD_SIGNALS.items():
        vals = {v.strip() for v in (row.get(fname, '') or '').split(',') if v.strip()}
        for v in vals:
            if v in LUX_FIELD_MARKERS:
                lux_fields.add(v)
            for arch, pts, label in mapping.get(v, []):
                score[arch] += pts * rarity('f:' + v)
                if label not in field_hits:
                    field_hits.append(label)
    if signals:
        why.append('remarks: ' + ', '.join(signals))
    if field_hits:
        why.append('MLS fields: ' + ', '.join(field_hits))

    # Size: square feet per bedroom and overall scale
    sqft = int(re.sub(r'\D', '', row.get('SqFt', '') or '0') or 0)
    beds = int(re.sub(r'\D', '', row.get('Beds Total', '') or '0') or 0)
    size_note = ''
    if sqft and beds:
        per_bed = sqft / beds
        if per_bed >= 1100:
            score['curator'] += 0.5; score['architect'] += 0.5
            size_note = f'{int(per_bed)} sq ft per bedroom (generous rooms)'
        elif per_bed <= 550:
            score['sanctuary'] += 0.25
            size_note = f'{int(per_bed)} sq ft per bedroom (compact)'
    if size_note:
        why.append('size: ' + size_note)

    # Age and era nudges, kept small.
    if year and year < 1950:
        score['custodian'] += 1.0
    elif year >= 2022:
        score['visionary'] += 0.5

    lux = find(LUX_APPLIANCES, text) + find(LUX_SURFACES, text)
    mid = find(MID_SURFACES, text)
    lux_all = {x.lower() for x in lux} | {x.lower() for x in lux_fields}
    granite = 'Granite Counters' in (row.get('Interior Features', '') or '')
    finish = 'Luxury' if len(lux_all) >= 2 else ('Upgraded' if lux_all or mid or granite else 'Standard')
    lux = sorted(lux_all)
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
        'field_signals': '; '.join(field_hits),
        'kitchen': ', '.join(v for v in ['Commercial Grade Range','Built-in Refrigerator','Oven-Double','Warming Drawer','Gas Cooktop','Electric Cooktop','Built-in Coffee Maker'] if v in (row.get('Appliances','') or '')),
        'why': ' | '.join(why),
        **{f'score_{a}': round(score[a], 1) for a in ARCHES},
        'description': desc,
    }


def main():
    src, out = sys.argv[1], sys.argv[2]
    rows = list(csv.DictReader(open(src, encoding='utf-8-sig')))
    # Pass 1: how common is each signal across this market?
    from collections import Counter
    cnt = Counter()
    for r in rows:
        desc = r.get('Property Description', '') or ''
        feats = ' | '.join(r.get(k, '') or '' for k in ['Appliances', 'Interior Features', 'Exterior Features', 'Construction Materials', 'Flooring', 'Pool Features'])
        for label, arch, w, pats in SIGNALS:
            if find(pats, desc + ' || ' + feats):
                cnt['t:' + label] += 1
        for fname in FIELD_SIGNALS:
            for v in {v.strip() for v in (r.get(fname, '') or '').split(',') if v.strip()}:
                cnt['f:' + v] += 1
    FREQ.update({k: v / len(rows) for k, v in cnt.items()})
    tagged = [tag(r) for r in rows]
    # Pass 2: judge each home against the market average for each archetype.
    means = {a: sum(t['score_' + a] for t in tagged) / len(tagged) for a in ARCHES}
    for t in tagged:
        rel = {a: t['score_' + a] - means[a] for a in ARCHES}
        ranked = sorted(ARCHES, key=lambda a: -rel[a])
        t['archetype'], t['archetype_2'] = ranked[0], ranked[1]
        lead = rel[ranked[0]] - rel[ranked[1]]
        styled = t['styledna_style'] != 'Not confirmed'
        t['confidence'] = 'High' if styled and lead >= 2 else ('Low' if (not styled and rel[ranked[0]] < 2) else 'Medium')
        t['stands_out_by'] = round(rel[ranked[0]], 1)
        if not styled and rel[ranked[0]] < 0.75:
            t['archetype'], t['archetype_2'], t['confidence'] = 'unclear', '', 'Low'
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
