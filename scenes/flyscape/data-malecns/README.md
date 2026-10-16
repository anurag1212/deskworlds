# MaleCNS sensorimotor data (generated, not committed)

`circuit.json`, `brain_points.json` and `meta.json` are built locally by:

```sh
pip install pyarrow   # one-time: Feather tables need Arrow IPC
python3 tools/fetch_malecns_pack.py
```

Raw MaleCNS v1.0 tables (~1.1 GB) live outside the repo in
`~/.cache/deskworlds-malecns` (override with `--cache` or `MALE_CNS_CACHE`).

MaleCNS is **CC BY 4.0** (FlyEM/HHMI Janelia, Cambridge, MRC LMB, Google
Research): attribute, link, note changes. Derived packs are not bundled; each
machine builds its own.
