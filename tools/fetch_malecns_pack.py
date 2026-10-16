#!/usr/bin/env python3
"""Fetch MaleCNS v1.0 tables and pack a sensorimotor circuit for Fly world.

Raw inputs (downloaded once into a cache dir outside the repo, ~1.1 GB total):
  body-annotations-male-cns-v1.0-minconf-0.5.feather
  body-neurotransmitters-male-cns-v1.0.feather
  connectome-weights-male-cns-v1.0-minconf-0.5.feather
from https://male-cns.janelia.org/download/ (CC BY 4.0).

Outputs (scenes/flyscape/data-malecns/, git-ignored):
  circuit.json       sensorimotor circuit: real neurons, real signed synapses
  brain_points.json  soma cloud spanning brain AND ventral nerve cord
  meta.json          sizes, motor-pool groups, model constants, sources

Selection: the same identified command populations as the FlyWire pack (DNa01,
DNa02, DNp01, DNp09, DNg11, MDN, LC4, LPLC2, LC10a, gustatory GRNs, MN9), PLUS
the full descending highway (1,314), all leg motor neurons (708, grouped by
neuromere x flexor/extensor/rotator pools), the ascending feedback highway, and
the strongest partners of the core. Signs from consensus_nt (acetylcholine +1,
GABA -1, glutamate -1); unsigned edges are dropped and counted, following
drosophila-brain-mlx. Neuron order is ascending bodyId, same convention.

The Shiu 2024 LIF constants carry over as the engine, not as tuned physiology:
they were fitted to FlyWire, not to this male specimen with its cord attached.
The pack records that plainly.

Requires pyarrow (pip install pyarrow): Feather tables are Arrow IPC, and no
stdlib parser exists. The browser runtime stays dependency-free.

Usage:
  python3 tools/fetch_malecns_pack.py [--cache DIR] [--out DIR]
"""

import argparse
import json
import os
import sys
import urllib.request
from collections import defaultdict

BASE = "https://storage.googleapis.com/flyem-male-cns/v1.0/connectome-data/flat-connectome"
SOURCES = {
    "annotations": "body-annotations-male-cns-v1.0-minconf-0.5.feather",
    "neurotransmitters": "body-neurotransmitters-male-cns-v1.0.feather",
    "connectivity": "connectome-weights-male-cns-v1.0-minconf-0.5.feather",
}

CORE_TYPES = {  # MaleCNS type -> role (same command set as the FlyWire pack)
    "DNa01": "dna01", "DNa02": "dna02", "DNp01": "gf", "DNp09": "dnp09",
    "DNg11": "dng11", "MDN": "mdn", "LC4": "lc4", "LPLC2": "lplc2",
    "LC10a": "lc10a", "MN9": "proboscis_mn",
}
# The cord extract is deliberately tight. A first pass kept the whole descending
# highway plus 1,200 partners and produced 757k edges, ~40% of them
# highway-to-highway recurrence: the network seized at any real drive and ran at
# 0.23x real time. This selection keeps the identified command cells, the leg
# motor pools, and a bounded set of the strongest local partners per command
# population; the highways are present as drive targets, not as whole recurrent
# graphs. Sparser wiring that can be held at a physiological rate beats a bigger
# one that rings.
MAX_PARTNERS = 400
MAX_PARTNERS_PER_POPULATION = 40
MAX_HIGHWAY_DN = 120
MAX_HIGHWAY_AN = 60
SIGNS = {"acetylcholine": 1, "gaba": -1, "glutamate": -1}
ALIASES = {"ach": "acetylcholine", "glu": "glutamate"}

MAX_POINTS = 26000

SHIU = {  # same engine constants as the FlyWire pack; fitted to FlyWire, not here
    "v_0": -52e-3, "v_rst": -52e-3, "v_th": -45e-3,
    "t_mbr": 20e-3, "tau": 5e-3, "t_rfc": 2.2e-3, "t_dly": 1.8e-3,
    "w_syn": 0.275e-3, "r_poi": 150.0, "r_poi2": 0.0, "f_poi": 250,
    "dt": 0.1e-3,
}


def fetch(name, cache):
    from pathlib import Path  # noqa: lazy, stdlib either way

    del Path
    path = os.path.join(cache, SOURCES[name])
    if os.path.exists(path):
        print(f"  cached {SOURCES[name]} ({os.path.getsize(path) / 1e6:.0f} MB)")
        return path
    url = f"{BASE}/{SOURCES[name]}"
    print(f"  downloading {SOURCES[name]} ...", flush=True)
    tmp = path + ".part"

    def progress(blocks, block_size, total):
        if total > 0 and blocks % 500 == 0:
            print(f"    {blocks * block_size / 1e6:.0f}/{total / 1e6:.0f} MB", flush=True)

    urllib.request.urlretrieve(url, tmp, reporthook=progress)
    os.replace(tmp, path)
    return path


def motor_pool(motor_type, neuromere):
    """(T1|T2|T3, flex|ext|rot|other) from a motor neuron type name."""
    leg = neuromere if neuromere in ("T1", "T2", "T3") else "T?"
    name = (motor_type or "").lower()
    if "flexor" in name or "reductor" in name:
        pool = "flex"
    elif "extensor" in name:
        pool = "ext"
    elif "rotator" in name or "promotor" in name or "remotor" in name:
        pool = "rot"
    else:
        pool = "other"
    return f"mn_{leg}_{pool}"


def main():
    try:
        from pyarrow import feather, ipc
    except ImportError:
        sys.exit("FATAL: pip install pyarrow (Feather tables need Arrow IPC)")

    ap = argparse.ArgumentParser(description=__doc__)
    default_cache = os.path.join(
        os.environ.get("HOME", "/tmp"), ".cache", "deskworlds-malecns"
    )
    ap.add_argument("--cache", default=os.environ.get("MALE_CNS_CACHE", default_cache))
    ap.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "scenes", "flyscape", "data-malecns",
        ),
    )
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    print("fetch:")
    paths = {name: fetch(name, args.cache) for name in SOURCES}

    # --- nodes ---------------------------------------------------------------
    print("nodes:")
    ann = feather.read_table(
        paths["annotations"],
        columns=["bodyId", "superclass", "type", "class", "somaSide",
                 "somaNeuromere", "somaLocation"],
    )
    bodies = ann["bodyId"].to_numpy()
    sc = ann["superclass"].to_pylist()
    ty = ann["type"].to_pylist()
    cl = ann["class"].to_pylist()
    side = ann["somaSide"].to_pylist()
    nm = ann["somaNeuromere"].to_pylist()
    loc = ann["somaLocation"].to_pylist()
    n_rows = len(bodies)

    core = {}    # bodyId -> role
    role_of = {}  # bodyId -> role (all selected)
    for i in range(n_rows):
        bid = int(bodies[i])
        role = CORE_TYPES.get(ty[i])
        if role:
            core[bid] = role
            role_of[bid] = role
        elif (cl[i] or "") == "gustatory":
            core[bid] = "sugar"
            role_of[bid] = "sugar"
        elif sc[i] == "vnc_motor":
            # All leg motor neurons: they are the point of this pack.
            role_of[bid] = motor_pool(ty[i], nm[i])
    # Descending and ascending cells are candidates, not automatic members: the
    # whole highway is 3,142 neurons whose interconnections were ~40% of the
    # first extract's edges. The strongest few hundred join below instead.
    highway = {}
    sup_of = {}
    for i in range(n_rows):
        bid = int(bodies[i])
        sup_of[bid] = sc[i]
        if sc[i] == "descending_neuron":
            highway[bid] = "dn"
        elif sc[i] == "ascending_neuron":
            highway[bid] = "an"
    print(f"  command core: {len(core)}, motor+core: {len(role_of)}, highway candidates: {len(highway)}")

    # --- signs ---------------------------------------------------------------
    nt = feather.read_table(paths["neurotransmitters"], columns=["body", "consensus_nt"])
    sign_of = {}
    for b, label in zip(nt["body"].to_pylist(), nt["consensus_nt"].to_pylist()):
        norm = (label or "").strip().casefold()
        sign_of[int(b)] = SIGNS.get(ALIASES.get(norm, norm), 0)

    # --- partner selection: stream connectivity twice -------------------------
    print("partners (pass 1):")
    reader = ipc.open_file(paths["connectivity"])
    ncol = {n: reader.schema.get_field_index(n) for n in ("body_pre", "body_post", "weight")}
    strength = defaultdict(int)
    strength_by_role = defaultdict(lambda: defaultdict(int))
    vnc_target = defaultdict(lambda: defaultdict(int))
    n_edge_rows = 0
    for b in range(reader.num_record_batches):
        batch = reader.get_batch(b)
        pre = batch.column(ncol["body_pre"]).to_numpy().astype("int64")
        post = batch.column(ncol["body_post"]).to_numpy().astype("int64")
        w = batch.column(ncol["weight"]).to_numpy().astype("int64")
        n_edge_rows += pre.size
        for a, o, weight in zip(pre, post, w):
            a, o = int(a), int(o)
            ra, ro = role_of.get(a), role_of.get(o)
            if ra is not None and ro is None:
                strength[o] += int(weight)
                strength_by_role[ra][o] += int(weight)
            elif ro is not None and ra is None:
                strength[a] += int(weight)
                strength_by_role[ro][a] += int(weight)
            # Direction-aware: what a command cell actually drives in the cord.
            # Without this the top "partners" of DNa are its brain-side inputs,
            # and the extract loses the very edges that carry steering down.
            if ra in ("dna01", "dna02", "gf", "dnp09", "dng11", "mdn") and ro is None:
                sup = sup_of.get(o)
                if sup is not None and sup.startswith("vnc_"):
                    vnc_target[ra][o] += int(weight)
    print(f"  rows: {n_edge_rows}, candidates: {len(strength)}")

    # Partner must be an annotated body (superclass non-null) with a soma.
    annotated = {}
    for i in range(n_rows):
        if sc[i] is not None and loc[i] is not None:
            annotated[int(bodies[i])] = (ty[i], sc[i], side[i], nm[i], loc[i])
    ranked = sorted(
        ((s, bid) for bid, s in strength.items() if bid in annotated),
        reverse=True,
    )
    partners, seen = [], set()

    def take(cands, k):
        n = 0
        for _, bid in cands:
            if k <= 0 or n >= k:
                break
            if bid in seen:
                continue
            seen.add(bid)
            partners.append(bid)
            n += 1
        return n

    for role in ("gf", "dna01", "dna02", "dnp09", "dng11", "mdn",
                 "sugar", "proboscis_mn"):
        take(sorted(strength_by_role[role].items(), key=lambda kv: -kv[1]),
             MAX_PARTNERS_PER_POPULATION)
    # And their actual cord targets, so steering and escape reach the motor pools.
    for role in ("dna01", "dna02", "gf", "dnp09", "dng11", "mdn"):
        take(sorted(((w, bid) for bid, w in vnc_target[role].items()),
                    key=lambda kv: -kv[0]), 24)
    # The strongest descending cells (drive targets for the cord) and a smaller
    # ascending set (feedback), then sensory, then the rest.
    take(sorted((p for p in ranked if p[1] in highway and highway[p[1]] == "dn"),
                key=lambda kv: -kv[0]), MAX_HIGHWAY_DN)
    take(sorted((p for p in ranked if p[1] in highway and highway[p[1]] == "an"),
                key=lambda kv: -kv[0]), MAX_HIGHWAY_AN)
    take([p for p in ranked if (annotated[p[1]][1] or "").endswith("sensory")], 16)
    take(ranked, MAX_PARTNERS - len(partners))
    for bid in partners:
        role_of.setdefault(bid, highway.get(bid, "other"))
    members = sorted(role_of.keys())
    index_of = {bid: i for i, bid in enumerate(members)}
    print(f"  circuit: {len(members)} neurons "
          f"({len(core)} command + {len(role_of) - len(core) - len(partners)} highway/motor + {len(partners)} partners)")

    # --- edges pass 2 ----------------------------------------------------------
    print("edges (pass 2):")
    import numpy as np

    ids = np.array(members, dtype=np.int64)
    signs = np.array([sign_of.get(bid, 0) for bid in members], dtype=np.int8)
    edge_lists = []
    drop_unsigned = 0
    for b in range(reader.num_record_batches):
        batch = reader.get_batch(b)
        pre = batch.column(ncol["body_pre"]).to_numpy().astype("int64")
        post = batch.column(ncol["body_post"]).to_numpy().astype("int64")
        w = batch.column(ncol["weight"]).to_numpy().astype("int64")
        pi = np.searchsorted(ids, pre)
        qi = np.searchsorted(ids, post)
        ok = (pi < ids.size) & (ids[np.minimum(pi, ids.size - 1)] == pre) & \
             (qi < ids.size) & (ids[np.minimum(qi, ids.size - 1)] == post)
        s = signs[np.minimum(pi, ids.size - 1)]
        keep = ok & (s != 0) & (w > 0)
        drop_unsigned += int(((ok) & (s == 0)).sum())
        if keep.any():
            edge_lists.append(
                np.stack([pi[keep].astype(np.int32), qi[keep].astype(np.int32),
                          (s[keep].astype(np.int64) * w[keep]).astype(np.int64)], axis=1)
            )
    edges = np.concatenate(edge_lists).tolist() if edge_lists else []
    print(f"  kept {len(edges)} edges ({drop_unsigned} dropped: unsigned transmitter)")

    # --- normalization over the whole annotated dataset --------------------------
    xs, ys, zs = [], [], []
    for p in loc:
        if p is not None and len(p) == 3:
            xs.append(p[0]); ys.append(p[1]); zs.append(p[2])
    cx, cy, cz = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2
    scale = 20.0 / max(max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))

    def norm(p):
        return (round((p[0] - cx) * scale, 3),
                round(-(p[1] - cy) * scale, 3),
                round(-(p[2] - cz) * scale, 3))

    # --- brain+cord point cloud ----------------------------------------------------
    cloud_ids = sorted(annotated.keys())
    stride = max(1, len(cloud_ids) // MAX_POINTS)
    SUPER = ["optic", "central", "sensory", "descending", "ascending", "motor"]
    points = []
    for bid in cloud_ids[::stride]:
        _, superclass, _, _, p = annotated[bid]
        x, y, z = norm(p)
        try:
            cls = SUPER.index(superclass)
        except ValueError:
            cls = 1
        points.append([x, y, z, cls])
    with open(os.path.join(args.out, "brain_points.json"), "w") as f:
        json.dump({"classes": SUPER, "points": points,
                   "source": "MaleCNS v1.0 body annotations (brain + VNC)"}, f)
    print(f"brain_points.json: {len(points)} points")

    # --- circuit.json ----------------------------------------------------------------
    SIDE_NAMES = {"L": "left", "R": "right", "C": "center"}
    neurons = []
    for bid in members:
        t, _, sside, _, p = annotated.get(bid, ("?", None, "", None, None))
        neurons.append({"id": str(bid), "type": t or "?",
                        "role": role_of[bid],
                        "side": SIDE_NAMES.get(sside, sside or ""),
                        "pos": list(norm(p)) if p else [0, 0, 0]})
    with open(os.path.join(args.out, "circuit.json"), "w") as f:
        json.dump({"neurons": neurons, "edges": [[int(a), int(o), int(w)] for a, o, w in edges],
                   "source": "MaleCNS v1.0 flat connectome (known transmitters only)"}, f)
    print(f"circuit.json: {len(neurons)} neurons, {len(edges)} edges")

    groups = defaultdict(list)
    for i, bid in enumerate(members):
        groups[role_of[bid]].append(i)
    meta = {"dataset": "MaleCNS v1.0 (male, brain + VNC)",
            "neurons": len(neurons), "edges": len(edges),
            "groups": {r: idx for r, idx in groups.items()},
            "model": SHIU,
            "caution": "Shiu 2024 constants fitted to FlyWire, not to this specimen.",
            "licences": {"connectome": "CC BY 4.0 (MaleCNS collaboration)"},
            "sources": {k: f"{BASE}/{v}" for k, v in SOURCES.items()}}
    with open(os.path.join(args.out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    for f in sorted(os.listdir(args.out)):
        print(f"  {f:18s} {os.path.getsize(os.path.join(args.out, f)) / 1e6:6.2f} MB")

    # --- sanity -------------------------------------------------------------------------
    idx = defaultdict(set)
    for i, bid in enumerate(members):
        idx[role_of[bid]].add(i)
    edge_set = [(a, o, w) for a, o, w in edges]
    for role in ("gf", "dna01", "dna02", "sugar", "proboscis_mn", "dn",
                 "mn_T1_flex", "mn_T1_ext", "mn_T2_flex", "mn_T3_flex"):
        drive = sum(abs(w) for a, o, w in edge_set if o in idx.get(role, set()))
        print(f"  in-circuit drive onto {role}: {drive:.0f} syn")
    motor_roles = sorted(r for r in groups if r.startswith("mn_"))
    print(f"  motor pools: {len(motor_roles)} "
          f"({sum(len(groups[r]) for r in motor_roles)} neurons)")


if __name__ == "__main__":
    main()
