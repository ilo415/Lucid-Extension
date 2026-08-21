#!/usr/bin/env python3
"""Pack a desktop-ONLY install zip from ../Lucid (the folder in this repo)."""
import os, zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, '..', 'Lucid')
OUT = os.path.join(os.path.dirname(ROOT), 'dist', 'Lucid-desktop.zip')
os.makedirs(os.path.dirname(OUT), exist_ok=True)

# Zip the Lucid FOLDER itself so unzip produces a `Lucid/` directory the user
# can Load-unpacked directly (same flow as selecting the folder).
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    for dirpath, dirnames, filenames in os.walk(SRC):
        # skip the icons? NO — icons are required by the manifest. Keep everything.
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            arc = os.path.relpath(full, os.path.dirname(SRC))  # => Lucid/icons/...
            z.write(full, arc)

total = sum(os.path.getsize(os.path.join(dp, f)) for dp,_,fs in os.walk(SRC) for f in fs)
print('Wrote', OUT, f'({total} bytes of source, zipped)')
print('Contains:')
with zipfile.ZipFile(OUT) as z:
    for n in z.namelist(): print('  ', n)