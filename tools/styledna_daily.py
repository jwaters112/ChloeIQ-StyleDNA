"""StyleDNA daily data steps. The data folder lives on Josh's Mac (never in git: it is MLS data).

  python3 tools/styledna_daily.py merge-export <data> <export.csv>... [--full]
      Add the rows from today's Matrix export(s) to source_active.csv (newest row wins per MLS#).
      --full means the exports cover every active listing in the quiz areas: rows missing from
      them are dropped as no longer active.
  python3 tools/styledna_daily.py todo-photos <data> [--max N]
      Print MLS# batches (51 per line, under Matrix's 500-character MLS# box) for listings
      that have no photo read yet.
  python3 tools/styledna_daily.py merge-photos <data> <results.json> [--zips zips.json]
      Add photo reads (the list /api/tag-photo returns) to photo_styles.csv, with each
      listing's ZIP from the Matrix photo page when given ({mls: zip}).
  python3 tools/styledna_daily.py tag <data>
      Re-run the tagger on everything: writes tags.csv and tags.json and prints a summary.
"""
import csv
import datetime
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PHOTO_COLS = ['mls', 'photo_exterior', 'photo_interior', 'zip', 'tagged_on', 'source']


def read_csv(path):
    if not os.path.exists(path):
        return [], []
    with open(path, encoding='utf-8-sig', newline='') as f:
        r = csv.DictReader(f)
        return list(r), r.fieldnames or []


def write_csv(path, rows, cols):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def merge_export(data, exports, full):
    path = os.path.join(data, 'source_active.csv')
    old, cols = read_csv(path)
    by = {r['ML #']: r for r in old}
    seen = set()
    for e in exports:
        rows, c = read_csv(e)
        for k in c:
            if k not in cols:
                cols.append(k)
        for r in rows:
            if r.get('ML #'):
                by[r['ML #']] = r
                seen.add(r['ML #'])
    dropped = 0
    if full:
        for m in list(by):
            if m not in seen:
                del by[m]
                dropped += 1
    write_csv(path, list(by.values()), cols)
    print(f'source_active.csv: {len(by)} listings ({len(seen)} in today\'s export, {dropped} dropped as no longer active)')


def todo_photos(data, cap):
    src, _ = read_csv(os.path.join(data, 'source_active.csv'))
    done, _ = read_csv(os.path.join(data, 'photo_styles.csv'))
    have = {r['mls'] for r in done}
    todo = sorted(r['ML #'] for r in src if r.get('ML #') and r['ML #'] not in have and r['ML #'].isdigit())
    if cap:
        todo = todo[:cap]
    for i in range(0, len(todo), 51):
        print(','.join(todo[i:i + 51]))
    print(f'# {len(todo)} listings need a photo read', file=sys.stderr)


def merge_photos(data, results, zips_path):
    path = os.path.join(data, 'photo_styles.csv')
    old, _ = read_csv(path)
    by = {r['mls']: r for r in old}
    zips = json.load(open(zips_path)) if zips_path else {}
    today = datetime.date.today().isoformat()
    added = errors = 0
    for r in json.load(open(results)):
        m = str(r.get('mls') or '')
        if not m:
            continue
        if r.get('error'):
            errors += 1
            continue
        by[m] = {'mls': m, 'photo_exterior': r.get('ext', 'NA'), 'photo_interior': '' if r.get('int') in (None, '-') else r['int'],
                 'zip': zips.get(m, by.get(m, {}).get('zip', '')), 'tagged_on': today, 'source': 'claude'}
        added += 1
    for m, z in zips.items():  # ZIPs for listings read earlier
        if m in by and not by[m].get('zip'):
            by[m]['zip'] = z
    write_csv(path, list(by.values()), PHOTO_COLS)
    print(f'photo_styles.csv: {len(by)} listings ({added} added today, {errors} photos failed and will retry tomorrow)')


def tag(data):
    cmd = [sys.executable, os.path.join(HERE, 'style_tagger.py'), os.path.join(data, 'source_active.csv'),
           os.path.join(data, 'tags.csv'), os.path.join(data, 'tags.json'), '--photos', os.path.join(data, 'photo_styles.csv')]
    subprocess.run(cmd, check=True)


def main():
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        return
    cmd, data, rest = a[0], a[1], a[2:]
    os.makedirs(data, exist_ok=True)
    if cmd == 'merge-export':
        merge_export(data, [x for x in rest if x != '--full'], '--full' in rest)
    elif cmd == 'todo-photos':
        cap = int(rest[rest.index('--max') + 1]) if '--max' in rest else 0
        todo_photos(data, cap)
    elif cmd == 'merge-photos':
        merge_photos(data, rest[0], rest[rest.index('--zips') + 1] if '--zips' in rest else None)
    elif cmd == 'tag':
        tag(data)
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
