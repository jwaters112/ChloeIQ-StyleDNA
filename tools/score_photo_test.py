"""Score Claude's photo reads against the hand-reviewed labels.

Usage: python3 tools/score_photo_test.py <model_results.json> <photo_styles.csv>

model_results.json: the list returned by /api/tag-photo ({mls, ext, int, note, usage}).
photo_styles.csv:   mls, photo_exterior, photo_interior from the hand review.

Prints exact agreement, near-miss agreement (neighbouring styles a person could
reasonably call either way), the biggest disagreements, and what the run cost.
"""
import csv
import json
import sys
from collections import Counter

# Styles that sit next to each other. A disagreement inside a pair is a near miss, not an error.
NEAR = [
    {'TR', 'TS'}, {'TR', 'CT'}, {'TR', 'RR'}, {'TS', 'MF'}, {'TS', 'MO'}, {'MF', 'FH'},
    {'TU', 'FR'}, {'TU', 'CO'}, {'CR', 'CO'}, {'CR', 'FH'}, {'CO', 'RR'}, {'MC', 'RR'},
    {'MC', 'MO'}, {'ME', 'FR'}, {'HC', 'RR'}, {'HC', 'FH'}, {'TS', 'FR'},
]
NAMES = {'TR': 'Traditional', 'TS': 'Transitional', 'MO': 'Modern', 'MF': 'Modern Farmhouse', 'FH': 'Farmhouse',
         'CR': 'Craftsman', 'TU': 'Tudor', 'ME': 'Mediterranean', 'FR': 'French / European', 'CO': 'Cottage',
         'MC': 'Mid-Century', 'RR': 'Ranch', 'HC': 'Hill Country', 'CT': 'Colonial', 'IN': 'Industrial',
         'NA': 'Not the front'}

# Claude Sonnet 5.5 list price per million tokens (standard, not batch).
PRICE_IN, PRICE_OUT = 2.0, 10.0


def near(a, b):
    return a == b or {a, b} in NEAR


def main():
    results = json.load(open(sys.argv[1]))
    truth = {r['mls']: r['photo_exterior'] for r in csv.DictReader(open(sys.argv[2]))}
    rows = [r for r in results if r.get('mls') in truth and r.get('ext')]
    errors = [r for r in results if r.get('error')]
    n = len(rows)
    exact = sum(r['ext'] == truth[r['mls']] for r in rows)
    close = sum(near(r['ext'], truth[r['mls']]) for r in rows)
    print(f'homes scored: {n}  (errors: {len(errors)})')
    if errors:
        print('  error types:', Counter(e['error'] for e in errors).most_common())
    if not n:
        return
    print(f'exact match:   {exact}/{n} = {exact / n:.0%}')
    print(f'match or near: {close}/{n} = {close / n:.0%}')

    by_style = Counter(truth[r['mls']] for r in rows)
    hit_style = Counter(truth[r['mls']] for r in rows if r['ext'] == truth[r['mls']])
    print('\nby style (hand label: exact matches / homes)')
    for code, total in by_style.most_common():
        print(f'  {NAMES.get(code, code):<18} {hit_style[code]}/{total}')

    misses = Counter((truth[r['mls']], r['ext']) for r in rows if not near(r['ext'], truth[r['mls']]))
    if misses:
        print('\nreal disagreements (hand -> model)')
        for (a, b), c in misses.most_common():
            print(f'  {NAMES.get(a, a)} -> {NAMES.get(b, b)}: {c}')
            for r in rows:
                if truth[r['mls']] == a and r['ext'] == b:
                    print(f'      {r["mls"]}  "{r.get("note", "")}"')

    used = [r['usage'] for r in results if r.get('usage')]
    if used:
        tin = sum(u['in'] for u in used)
        tout = sum(u['out'] for u in used)
        cost = tin / 1e6 * PRICE_IN + tout / 1e6 * PRICE_OUT
        print(f'\ncost: ${cost:.2f} for {len(used)} homes = ${cost / len(used):.4f} each '
              f'(about ${cost / len(used) / 2:.4f} each on the overnight batch rate)')


if __name__ == '__main__':
    main()
