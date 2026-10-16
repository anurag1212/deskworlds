# Connectome data (generated, not committed)

`circuit.json`, `brain_points.json` and `meta.json` are built locally by:

```sh
python3 tools/fetch_flywire_pack.py
```

Raw FlyWire Codex downloads (~95 MB) live outside the repo in
`~/.cache/deskworlds-flywire` (override with `--cache` or `FLYWIRE_CACHE`).

FlyWire data is **CC BY-NC 4.0**: attribution, non-commercial. Derived packs
are therefore not bundled in the repo; each machine builds its own.
