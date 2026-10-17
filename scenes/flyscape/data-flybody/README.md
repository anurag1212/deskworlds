# FlyBody meshes (derived, committed)

`flybody.bin` and `flybody.json` are derived from the **FlyBody** fruit-fly
model by Google DeepMind and HHMI Janelia (TuragaLab/flybody), released under
**Apache-2.0**. They contain decimated, re-baked meshes: every part is
transformed into the rig frames `scenes/flyscape/src/fly.js` animates (thorax
frame, wing hinges, leg hip/knee frames), with int8 normals and 16-bit indices.

Regenerate with:

```sh
python3 tools/fetch_flybody_pack.py
```

The script downloads the original OBJ assets (~116 MB) and `fruitfly.xml` into
`~/.cache/deskworlds-flybody` (override with `--cache` or `FLYBODY_CACHE`),
decimates by grid clustering, and writes the two files above.

FlyBody: Vaxenburg et al., *Whole-body physics simulation of fruit fly
locomotion*, Nature (2025). Cite the publication and keep this notice when
redistributing the derived meshes.
