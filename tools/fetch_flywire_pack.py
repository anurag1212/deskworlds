#!/usr/bin/env python3
"""Fetch FlyWire Codex v783 data and pack a reduced circuit for Fly world.

Raw inputs (downloaded once into a cache dir outside the repo, ~95 MB total):
  classification.csv.gz          root_id, flow, super_class, class, sub_class, hemilineage, side, nerve
  coordinates.csv.gz             root_id, position "[x y z]" (nm), supervoxel_id
  consolidated_cell_types.csv.gz root_id, primary_type, additional_type(s)
  connections.csv.gz             pre_root_id, post_root_id, neuropil, syn_count, nt_type (>=5 syn)
  neuron_annotations.tsv         FlyWire supplemental annotations (cell_sub_class, top_nt, side, ...)

Outputs (scenes/flyscape/data/, git-ignored: FlyWire data is CC BY-NC 4.0):
  circuit.json       reduced LIF circuit: real neurons, real signed synapse weights
  brain_points.json  downsampled soma point cloud for the brain visualization
  meta.json          sizes, groups, Shiu model constants, sources, licences

The selection follows DenisSergeevitch/desktop-fly's ETL: core command
populations plus their strongest partners, with reserved slots for small
populations and ascending/sensory feedback. Sugar-sensing GRNs and proboscis
motor neurons (the Shiu et al. 2024 headline circuit) come from the supplemental
annotations' cell_sub_class, as in dtecx/doodle-fly.

Neuron dynamics are NOT in this pack; they are the Shiu et al. 2024 LIF
constants recorded in meta.json, implemented by the browser engine next.

Usage:
  python3 tools/fetch_flywire_pack.py [--cache DIR] [--out DIR]

Stdlib only: no dependencies to install, per repo convention.
"""

import argparse
import csv
import gzip
import json
import os
import sys
import urllib.request
from collections import defaultdict

BASE = "https://storage.googleapis.com/flywire-data/codex/data/fafb/783"
SOURCES = {
    "classification.csv.gz": f"{BASE}/classification.csv.gz",
    "coordinates.csv.gz": f"{BASE}/coordinates.csv.gz",
    "consolidated_cell_types.csv.gz": f"{BASE}/consolidated_cell_types.csv.gz",
    "connections.csv.gz": f"{BASE}/connections.csv.gz",
    "neuron_annotations.tsv": "https://raw.githubusercontent.com/flyconnectome/"
    "flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv",
}

# primary_type -> role. Counts in parens are the v783 expectations from desktop-fly.
CORE_TYPES = {
    "LC4": "lc4",        # looming detector (giant-fiber input, ~104)
    "LPLC2": "lplc2",    # looming detector (giant-fiber input, ~210)
    "DNp01": "gf",       # giant fiber, escape command neuron (2)
    "DNa02": "dna02",    # steering descending neuron (2)
    "DNa01": "dna01",    # steering descending neuron (2)
    "DNp09": "dnp09",    # forward-walking command neuron (2)
    "DNg11": "dng11",    # grooming command neuron (6)
    "MDN": "mdn",        # moonwalker, backward walking (4)
    "DNp02": "escw",     # loom-responsive escape-maneuver DNs (wing responses)
    "DNp04": "escw",
    "DNp11": "escw",
    "LC10a": "lc10a",    # small-object detector, steering input (~237)
}
# cell_sub_class (annotations TSV) -> role, for the taste->proboscis circuit.
SUBCLASS_TYPES = {
    "sugar": "sugar",                          # sugar-sensing gustatory neurons
    "proboscis_motor_neuron": "proboscis_mn",  # proboscis motor neurons (MN9 et al.)
}

# Neurotransmitter -> sign of the synapse. Matches desktop-fly: fast inhibition
# (GABA, glutamate) is negative, acetylcholine excitatory, monoamines weak.
NT_SIGN = {"ACH": 1.0, "GABA": -1.0, "GLUT": -1.0, "DA": 0.5, "SER": 0.5, "OCT": 0.5}

MAX_PARTNERS = 330
MAX_POINTS = 22000

# Shiu et al. 2024 LIF constants (philshiu/Drosophila_brain_model, MIT).
# Recorded here so the browser engine implements exactly these, in SI units.
SHIU = {
    "v_0": -52e-3, "v_rst": -52e-3, "v_th": -45e-3,
    "t_mbr": 20e-3, "tau": 5e-3, "t_rfc": 2.2e-3, "t_dly": 1.8e-3,
    "w_syn": 0.275e-3, "r_poi": 150.0, "r_poi2": 0.0, "f_poi": 250,
    "dt": 0.1e-3,
}


def fetch(name, cache):
    path = os.path.join(cache, name)
    if os.path.exists(path):
        print(f"  cached {name} ({os.path.getsize(path) / 1e6:.1f} MB)")
        return path
    url = SOURCES[name]
    print(f"  downloading {name} ...", flush=True)
    tmp = path + ".part"

    def progress(blocks, block_size, total):
        done = blocks * block_size
        if total > 0 and blocks % 200 == 0:
            print(f"    {done / 1e6:.0f}/{total / 1e6:.0f} MB", flush=True)

    urllib.request.urlretrieve(url, tmp, reporthook=progress)
    os.replace(tmp, path)
    print(f"  saved {name} ({os.path.getsize(path) / 1e6:.1f} MB)")
    return path


def gz_rows(path):
    with gzip.open(path, "rt") as f:
        reader = csv.reader(f)
        next(reader)  # header
        yield from reader


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    default_cache = os.path.join(
        os.environ.get("HOME", "/tmp"), ".cache", "deskworlds-flywire"
    )
    ap.add_argument("--cache", default=os.environ.get("FLYWIRE_CACHE", default_cache))
    ap.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "scenes",
            "flyscape",
            "data",
        ),
    )
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    print("fetch:")
    paths = {name: fetch(name, args.cache) for name in SOURCES}

    # --- core populations from primary_type ----------------------------------
    core = {}       # root_id -> role
    type_of = {}    # root_id -> primary_type (circuit members only)
    counts = defaultdict(int)
    with gzip.open(paths["consolidated_cell_types.csv.gz"], "rt") as f:
        reader = csv.reader(f)
        next(reader)
        for row in reader:
            role = CORE_TYPES.get(row[1].strip())
            if role:
                core[row[0]] = role
                type_of[row[0]] = row[1].strip()
                counts[row[1].strip()] += 1
    print("core populations:", dict(counts))
    for need in ("LC4", "LPLC2", "DNp01", "DNa01", "DNa02"):
        if not counts.get(need):
            sys.exit(f"FATAL: missing core population {need} - check type names")

    # --- taste circuit from the supplemental annotations ----------------------
    n_sugar = n_prob = 0
    with open(paths["neuron_annotations.tsv"]) as f:
        reader = csv.DictReader(f, delimiter="\t")
        for row in reader:
            role = SUBCLASS_TYPES.get((row.get("cell_sub_class") or "").strip())
            if role and row.get("root_id"):
                rid = row["root_id"].strip()
                if rid not in core:
                    core[rid] = role
                    type_of[rid] = row.get("cell_type", "").strip() or role
                    if role == "sugar":
                        n_sugar += 1
                    else:
                        n_prob += 1
    print(f"taste circuit: {n_sugar} sugar GRNs, {n_prob} proboscis motor neurons")
    if not n_sugar or not n_prob:
        sys.exit("FATAL: taste circuit missing - check cell_sub_class names")

    # --- classification + coordinates ------------------------------------------
    klass = {}
    for row in gz_rows(paths["classification.csv.gz"]):
        klass[row[0]] = (row[2], row[6])
    pos = {}
    for row in gz_rows(paths["coordinates.csv.gz"]):
        rid = row[0]
        if rid in pos:
            continue
        p = row[1].strip("[]").split()
        if len(p) == 3:
            pos[rid] = (float(p[0]), float(p[1]), float(p[2]))
    print(f"classification: {len(klass)}, coordinates: {len(pos)}")

    # --- connections pass 1: core-core edges + partner strengths ----------------
    partner_strength = defaultdict(int)
    strength_by_role = defaultdict(lambda: defaultdict(int))
    n_edges_seen = 0
    for row in gz_rows(paths["connections.csv.gz"]):
        pre, post, syn = row[0], row[1], int(row[3])
        n_edges_seen += 1
        pre_core, post_core = pre in core, post in core
        if pre_core and not post_core:
            partner_strength[post] += syn
            strength_by_role[core[pre]][post] += syn
        elif post_core and not pre_core:
            partner_strength[pre] += syn
            strength_by_role[core[post]][pre] += syn
    print(f"connections rows: {n_edges_seen}, candidate partners: {len(partner_strength)}")

    usable = lambda r: r in pos and r in klass
    ranked = [
        rid
        for rid, _ in sorted(partner_strength.items(), key=lambda kv: -kv[1])
        if usable(rid)
    ]
    partners, seen = [], set()

    def take(cands, k):
        n = 0
        for r in cands:
            if r in seen or not usable(r):
                continue
            seen.add(r)
            partners.append(r)
            n += 1
            if n == k:
                break

    # Every small command population gets its own strongest partners, so no DN
    # ends up driven by noise alone. Taste populations included: the sugar drive
    # must reach the proboscis through real wiring, not through strangers.
    for role in ("gf", "dna01", "dna02", "dnp09", "dng11", "mdn", "escw",
                 "sugar", "proboscis_mn"):
        take(
            [
                r
                for r, _ in sorted(
                    strength_by_role[role].items(), key=lambda kv: -kv[1]
                )
            ],
            10,
        )
    take([r for r in ranked if klass[r][0] == "ascending"], 24)
    take([r for r in ranked if klass[r][0] == "sensory"], 16)
    take(ranked, MAX_PARTNERS - len(partners))
    members = list(core.keys()) + partners
    member_idx = {rid: i for i, rid in enumerate(members)}
    print(f"circuit members: {len(members)} ({len(core)} core + {len(partners)} partners)")

    # --- connections pass 2: all edges within the circuit -----------------------
    edges = []
    nt_missing = 0
    for row in gz_rows(paths["connections.csv.gz"]):
        i, j = member_idx.get(row[0]), member_idx.get(row[1])
        if i is None or j is None:
            continue
        syn, nt = int(row[3]), row[4].strip().upper()
        sign = NT_SIGN.get(nt)
        if sign is None:
            sign, nt_missing = 1.0, nt_missing + 1
        edges.append((i, j, round(syn * sign, 1)))
    print(f"circuit edges: {len(edges)} (unknown nt on {nt_missing})")

    # --- normalization: whole brain into [-10, 10] --------------------------------
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    zs = [p[2] for p in pos.values()]
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    scale = 20.0 / max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))

    def norm(p):
        # FAFB: x = left-right, y = dorsal-ventral (image y down),
        # z = anterior-posterior.
        return (
            round((p[0] - cx) * scale, 3),
            round(-(p[1] - cy) * scale, 3),
            round(-(p[2] - cz) * scale, 3),
        )

    # --- brain point cloud ------------------------------------------------------
    SUPER_CLASSES = [
        "optic", "central", "sensory", "visual_projection", "visual_centrifugal",
        "descending", "ascending", "motor", "endocrine",
    ]
    sc_idx = {s: i for i, s in enumerate(SUPER_CLASSES)}
    cloud_ids = sorted(rid for rid in pos if rid in klass)
    stride = max(1, len(cloud_ids) // MAX_POINTS)
    points = []
    for rid in cloud_ids[::stride]:
        x, y, z = norm(pos[rid])
        points.append([x, y, z, sc_idx.get(klass[rid][0], 1)])
    with open(os.path.join(args.out, "brain_points.json"), "w") as f:
        json.dump(
            {
                "classes": SUPER_CLASSES,
                "points": points,
                "source": "FlyWire Codex FAFB v783 coordinates.csv + classification.csv",
            },
            f,
        )
    print(f"brain_points.json: {len(points)} points")

    # --- circuit.json -----------------------------------------------------------
    neurons = []
    for rid in members:
        sc, side = klass.get(rid, ("", ""))
        p = norm(pos[rid]) if rid in pos else (0, 0, 0)
        neurons.append(
            {
                "id": rid,
                "type": type_of.get(rid, sc or "?"),
                "role": core.get(rid, "other"),
                "side": side,
                "pos": list(p),
            }
        )
    with open(os.path.join(args.out, "circuit.json"), "w") as f:
        json.dump(
            {
                "neurons": neurons,
                "edges": edges,
                "source": "FlyWire Codex FAFB v783 connections.csv "
                "(syn>=5, signed by nt_type)",
            },
            f,
        )
    print(f"circuit.json: {len(neurons)} neurons, {len(edges)} edges")

    groups = defaultdict(list)
    for i, rid in enumerate(members):
        groups[core.get(rid, "other")].append(i)
    meta = {
        "dataset": "FlyWire FAFB v783",
        "neurons": len(neurons),
        "edges": len(edges),
        "groups": {role: idx for role, idx in groups.items()},
        "model": SHIU,
        "licences": {
            "connectome": "CC BY-NC 4.0 (FlyWire; attribution, non-commercial)",
            "model_constants": "MIT via philshiu/Drosophila_brain_model",
            "annotations": "CC BY 4.0 via flyconnectome/flywire_annotations",
        },
        "sources": SOURCES,
    }
    with open(os.path.join(args.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    for f in sorted(os.listdir(args.out)):
        size = os.path.getsize(os.path.join(args.out, f))
        print(f"  {f:18s} {size / 1e6:6.2f} MB")

    # --- sanity: the circuits that must exist ------------------------------------
    gf = set(groups["gf"])
    loom = set(groups["lc4"]) | set(groups["lplc2"])
    loom_gf = [e for e in edges if e[0] in loom and e[1] in gf]
    print(
        f"sanity: direct loom->GF edges: {len(loom_gf)}, "
        f"total syn: {sum(abs(e[2]) for e in loom_gf):.0f}"
    )
    idx_of_role = defaultdict(set)
    for i, rid in enumerate(members):
        if rid in core:
            idx_of_role[core[rid]].add(i)
    for role in ("gf", "dna01", "dna02", "dnp09", "dng11", "mdn", "escw",
                 "sugar", "proboscis_mn", "lc10a"):
        ids = idx_of_role.get(role, set())
        drive = sum(abs(e[2]) for e in edges if e[1] in ids)
        print(f"  in-circuit drive onto {role}: {drive:.0f} syn")
    if not loom_gf:
        sys.exit("FATAL: no loom->GF edges - the escape circuit did not survive")
    sugar_idx = idx_of_role.get("sugar", set())
    prob_idx = idx_of_role.get("proboscis_mn", set())
    sugar_prob = [e for e in edges if e[0] in sugar_idx and e[1] in prob_idx]
    taste = [e for e in edges if e[0] in sugar_idx or e[1] in prob_idx]
    print(
        f"  taste edges touching sugar/proboscis: {len(taste)}, "
        f"direct sugar->proboscis: {len(sugar_prob)}"
    )


if __name__ == "__main__":
    main()
