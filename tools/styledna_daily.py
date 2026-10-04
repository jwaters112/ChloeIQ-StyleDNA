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
  python3 tools/styledna_daily.py board-picks <data> <boards.json> <out.json>
      For each home board (the admin-list from the preview site), pick up to 3 of today's new
      listings that fit its StyleDNA, budget and area. Writes [{id, homes:[...]}] for postPicks().
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
    before = set(by)
    # source_active.csv is too big to keep on the Mac, so yesterday's MLS list lives in active_mls.txt.
    mls_path = os.path.join(data, 'active_mls.txt')
    if not before and os.path.exists(mls_path):
        before = set(open(mls_path).read().split())
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
    # New on the market since the last run. The very first run has nothing to compare with.
    new = sorted(m for m in seen if m not in before) if before else []
    with open(os.path.join(data, 'new_today.txt'), 'w') as f:
        f.write('\n'.join(new))
    with open(mls_path, 'w') as f:
        f.write('\n'.join(sorted(by)))
    print(f'source_active.csv: {len(by)} listings ({len(seen)} in today\'s export, {dropped} dropped as no longer active, {len(new)} new)')


def todo_photos(data, cap):
    src, _ = read_csv(os.path.join(data, 'source_active.csv'))
    done, _ = read_csv(os.path.join(data, 'photo_styles.csv'))
    have = {r['mls'] for r in done}
    new_path = os.path.join(data, 'new_today.txt')
    new = set(open(new_path).read().split()) if os.path.exists(new_path) else set()
    # Today's new listings first (their buyers get alerts), then the newest MLS numbers.
    todo = sorted((r['ML #'] for r in src if r.get('ML #') and r['ML #'] not in have and r['ML #'].isdigit()),
                  key=lambda m: (m not in new, -int(m)))
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


BUDGETS = {0: (0, 300000), 1: (300000, 500000), 2: (500000, 750000), 3: (750000, 1000000), 4: (1000000, 0)}


def board_picks(data, boards_path, out_path, per_board=3):
    sys.path.insert(0, HERE)
    import styledna_match as sm
    new_path = os.path.join(data, 'new_today.txt')
    new = set(open(new_path).read().split()) if os.path.exists(new_path) else set()
    tags = [t for t in sm.load_tags(os.path.join(data, 'tags.csv')) if str(t.get('mls')) in new]
    boards = json.load(open(boards_path))
    if isinstance(boards, dict):
        boards = boards.get('boards', [])
    out, skipped = [], 0
    for b in boards:
        c = b.get('criteria') or {}
        # Style tags cover single-family homes only for now.
        if c.get('homeType') and c.get('homeType') != 'Single Family Home':
            skipped += 1
            continue
        if not c.get('archetype'):
            continue
        lo, hi = BUDGETS.get(c.get('budget'), (0, 0))
        lead = {'archetype': c['archetype'], 'area': c.get('area') or '', 'priceMin': lo, 'priceMax': hi}
        have = set(b.get('mls') or [])
        picks = [t for t in sm.match(tags, lead, n=per_board + len(have)) if str(t.get('mls')) not in have][:per_board]
        if not picks:
            continue
        homes = [{'mls': str(t.get('mls')), 'address': (t.get('address') or '').strip(), 'city': t.get('city') or '',
                  'price': t.get('price') or '', 'beds': t.get('beds') or '', 'baths': t.get('baths') or '',
                  'sqft': t.get('sqft') or '', 'style': t.get('styledna_style') if t.get('styledna_style') not in ('', 'Not confirmed') else '',
                  'url': sm.home_link(t), 'isNew': True} for t in picks]
        out.append({'id': b['id'], 'homes': homes})
    json.dump(out, open(out_path, 'w'), indent=1)
    print(f'board picks: {len(out)} boards get new listings ({sum(len(x["homes"]) for x in out)} homes); '
          f'{len(new)} new listings today; {skipped} boards skipped (not single family)')


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
    elif cmd == 'board-picks':
        board_picks(data, rest[0], rest[1])
    else:
        print(__doc__)


if __name__ == '__main__':
    main()
