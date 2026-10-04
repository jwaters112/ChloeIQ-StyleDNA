"""Pick the active listings that best fit a StyleDNA lead and write the Lofty note.

Usage:
  python3 tools/styledna_match.py <tags.json> <leads.json> <out.json>

tags.json:  the tagger's JSON (or CSV) output (one record per active listing). Needs mls, address,
            city, zip (when known), price, beds, baths, sqft, styledna_style, style_source,
            archetype, archetype_2, confidence, finish_level, status.
leads.json: [{"leadId": 123, "name": "Jane Doe", "archetype": "The Curator" or "curator",
              "area": "Lakewood", "priceMin": 500000, "priceMax": 750000}, ...]
out.json:   [{"leadId", "name", "matches": [...], "note": "<text for the Lofty note>"}]

A listing fits when it is Active, inside the lead's price band (with a 5% cushion), and
inside their area (city name, or ZIP for neighbourhoods that are not cities). Among those,
listings rank by how well their archetype matches the lead's, then by confidence.
"""
import json
import re
import sys
import urllib.parse

ARCH_NAMES = {
    'the curator': 'curator', 'the sanctuary seeker': 'sanctuary', 'the experience architect': 'architect',
    'the heritage custodian': 'custodian', 'the visionary': 'visionary', 'the authenticist': 'authenticist',
}
ARCH_LABEL = {v: k.title() for k, v in ARCH_NAMES.items()}

# Same neighbourhood-to-ZIP map the quiz and the lead form use.
AREA_ZIPS = {
    'Uptown': ['75201', '75204'], 'Downtown Dallas': ['75201', '75202'], 'Preston Hollow': ['75225', '75229', '75230'],
    'Bishop Arts': ['75208'], 'Lakewood': ['75214'], 'Lake Highlands': ['75238', '75243'], 'M Streets': ['75206'],
    'Oak Lawn': ['75219'], 'Oak Cliff': ['75208', '75211', '75224'], 'Deep Ellum': ['75226'],
    'Knox-Henderson': ['75205', '75206'], 'Turtle Creek': ['75219'], 'Devonshire': ['75209'],
    'TCU/West Cliff': ['76109', '76110'], 'Tanglewood': ['76109'], 'Rivercrest': ['76107'], 'Cultural District': ['76107'],
    'Near Southside': ['76104'], 'Mistletoe Heights': ['76104'], 'Downtown Fort Worth': ['76102'],
    'Las Colinas': ['75038', '75039', '75063'],
}
IDX_BASE = 'https://joshwaters.com/listing'
WEAK = {'Traditional', 'Transitional', 'Ranch', 'Not confirmed'}
CONF_PTS = {'High': 1.0, 'Medium': 0.5, 'Low': 0.0}


def money(v):
    n = re.sub(r'[^\d.]', '', str(v or ''))
    return float(n) if n else 0.0


def arch_key(v):
    v = str(v or '').strip().lower()
    return ARCH_NAMES.get(v, v if v in ARCH_LABEL else '')


def in_area(t, area):
    if not area:
        return True
    if isinstance(area, (list, tuple)):
        return any(in_area(t, a) for a in area if a) or not any(area)
    if area in AREA_ZIPS:
        return str(t.get('zip') or '') in AREA_ZIPS[area]
    return str(t.get('city') or '').strip().lower() == area.strip().lower()


def home_link(t):
    """A joshwaters.com search narrowed to this one home (its ZIP or city plus its exact price)."""
    p = int(money(t.get('price')))
    cond = {'purchasetype': ['For Sale'], 'price': f'{p},{p}'}
    if t.get('zip'):
        cond['location'] = {'zipCode': [str(t['zip'])]}
    elif t.get('city'):
        cond['location'] = {'city': [f"{t['city']}, TX"]}
    q = [('listingSource', 'all listings'), ('condition', json.dumps(cond, separators=(',', ':'))), ('page', '1')]
    return IDX_BASE + '?' + '&'.join(k + '=' + urllib.parse.quote(v, safe='') for k, v in q)


def score(t, arch):
    s = 0.0
    if t.get('archetype') == arch:
        s += 3
    elif t.get('archetype_2') == arch:
        s += 1.5
    else:
        return None
    s += CONF_PTS.get(t.get('confidence'), 0)
    # A distinctive style confirmed by the photo is the strongest signal we have.
    if t.get('styledna_style') not in WEAK and str(t.get('style_source', '')).startswith('photo'):
        s += 0.75
    if t.get('finish_level') == 'Luxury':
        s += 0.25
    return s


def match(tags, lead, n=5):
    arch = arch_key(lead.get('archetype'))
    lo, hi = money(lead.get('priceMin')), money(lead.get('priceMax'))
    lo, hi = lo * 0.95 if lo else 0, hi * 1.05 if hi else float('inf')
    picks = []
    for t in tags:
        if str(t.get('status', 'Active')).lower() not in ('active', ''):
            continue
        price = money(t.get('price'))
        if not (lo <= price <= hi) or not in_area(t, lead.get('area')):
            continue
        s = score(t, arch)
        if s is not None:
            picks.append((s, -price if hi == float('inf') else 0, t))
    picks.sort(key=lambda x: (-x[0], x[1]))
    return [p[2] for p in picks[:n]]


def note(lead, picks):
    arch = arch_key(lead.get('archetype'))
    label = ARCH_LABEL.get(arch, 'their StyleDNA')
    first = (lead.get('name') or '').split(' ')[0] or 'This buyer'
    head = f"StyleDNA matches for {first} ({label}"
    if lead.get('area'):
        a = lead['area']
        head += ', ' + (', '.join(a) if isinstance(a, (list, tuple)) else a)
    head += ')'
    if not picks:
        return head + '\nNo tagged active listings fit yet. The quiz link still shows homes in their price band and area.'
    lines = [head]
    for t in picks:
        bits = [f"{t.get('address', '').strip()}, {t.get('city', '')}", str(t.get('price', ''))]
        if t.get('beds'):
            bits.append(f"{t['beds']} bd / {t.get('baths', '')} ba")
        if t.get('sqft'):
            bits.append(f"{t['sqft']} sq ft")
        style = t.get('styledna_style')
        if style and style != 'Not confirmed':
            bits.append(style)
        lines.append('- ' + ', '.join(b for b in bits if b) + f" (MLS {t.get('mls')})\n  {home_link(t)}")
    lines.append('Picked by StyleDNA from the front photo, listing details and price band. Check each before sending.')
    return '\n'.join(lines)


def load_tags(path):
    if path.endswith('.csv'):
        import csv
        with open(path, encoding='utf-8-sig', newline='') as f:
            return list(csv.DictReader(f))
    return json.load(open(path))


def main():
    tags = load_tags(sys.argv[1])
    leads = json.load(open(sys.argv[2]))
    out = []
    for lead in leads:
        picks = match(tags, lead)
        out.append({'leadId': lead.get('leadId'), 'name': lead.get('name'),
                    'matches': [p.get('mls') for p in picks], 'note': note(lead, picks)})
    json.dump(out, open(sys.argv[3], 'w'), indent=1)
    for o in out:
        print(o['note'], '\n')


if __name__ == '__main__':
    main()
