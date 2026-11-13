from pathlib import Path
import argparse
root = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--check', action='store_true')
args = p.parse_args()
for source in sorted((root / 'client-shared').glob('*.js')):
    for directory in ('web', 'pc/web'):
        target = root / directory / source.name
        if args.check:
            if not target.exists() or target.read_bytes() != source.read_bytes():
                raise SystemExit(f'Shared client copy differs: {target}')
        else:
            target.write_bytes(source.read_bytes())
print('Shared browser core is synchronized')
