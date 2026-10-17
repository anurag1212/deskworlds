#!/usr/bin/env python3
"""Fetch FlyBody meshes and pack an animation-ready fly for the browser.

Source: TuragaLab/flybody (Apache-2.0), the anatomically detailed Drosophila
from Google DeepMind + HHMI Janelia. Downloads a subset of the fruitfly assets
(~116 MB of OBJ, cached outside the repo) plus fruitfly.xml, decimates, bakes
every mesh into the rig frames Fly world animates, and writes:

  scenes/flyscape/data-flybody/flybody.bin   packed meshes (committed, Apache-2.0)
  scenes/flyscape/data-flybody/flybody.json  rig description (committed)

Bake conventions (match scenes/flyscape/src/fly.js):
  * model space (x forward, y left, z up) -> rig space (x right-ish, y up,
    z forward) by the proper rotation (x,y,z) -> (y, z, x). Bilaterally
    symmetric meshes make the left/right swap invisible; the wing animation
    signs are derived from baked x, not from names.
  * frames: body = thorax origin; wing hinges at the wing roots; each leg's
    hip frame at the coxa origin and knee frame at the tibia joint, all with
    rig-space axes so rotation.x = swing and rotation.z = lift behave like the
    procedural rig.
  * decimation is grid clustering (visual meshes for a wallpaper fly), then
    area-weighted vertex normals quantized to int8.

Usage:
  python3 tools/fetch_flybody_pack.py [--cache DIR] [--out DIR]
"""

import argparse
import json
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

import numpy as np

BASE = "https://raw.githubusercontent.com/TuragaLab/flybody/main/flybody/fruitfly/assets"

# Body group (baked into the thorax frame), proboscis group (own pivot), wings,
# and per-leg segments. Names are asset stems.
BODY_MESHES = (
    ["thorax_body", "thorax_black", "head_body", "head_black", "head_red", "head_ocelli"]
    + [f"abdomen_{i}_body" for i in range(1, 9)]
    + [f"abdomen_{i}_lower" for i in range(1, 8)]
    + ["haltere_left_body", "haltere_right_body"]
    + ["antenna_left_body", "antenna_left_black", "antenna_right_body", "antenna_right_black"]
)
PROBOSCIS_MESHES = ["rostrum_body", "haustellum_body", "labrum_left_lower", "labrum_right_lower"]
WING_MESHES = ["wing_left_membrane", "wing_left_brown", "wing_right_membrane", "wing_right_brown"]
LEG_SEGMENTS = ["coxa", "femur", "tibia", "tarsus_1", "tarsus_2", "tarsus_3", "tarsus_4", "claw"]
LEG_SIDES = ["left", "right"]
LEG_ROW = ["T1", "T2", "T3"]

# Grid cells across a mesh's longest axis, per part class: enough to read as
# anatomy at wallpaper size without shipping 140 MB of OBJ to a browser.
CELLS = {"body": 52, "eye": 40, "proboscis": 36, "wing": 44, "leg": 34, "small": 22}
TARGET_LENGTH = 0.72  # rig units, matching the procedural fly's ~0.79 span


def fetch(name, cache):
    path = os.path.join(cache, name)
    if os.path.exists(path):
        return path
    url = f"{BASE}/{name}"
    print(f"  fetch {name}", flush=True)
    tmp = path + ".part"
    urllib.request.urlretrieve(url, tmp)
    os.replace(tmp, path)
    return path


def qmul(a, b):
    w1, x1, y1, z1 = a
    w2, x2, y2, z2 = b
    return np.array([
        w1 * w2 - x1 * x2 - y1 * y2 - z1 * z2,
        w1 * x2 + x1 * w2 + y1 * z2 - z1 * y2,
        w1 * y2 - x1 * z2 + y1 * w2 + z1 * x2,
        w1 * z2 + x1 * y2 - y1 * x2 + z1 * w2,
    ])


def qrot(q, v):
    w, x, y, z = q
    # v' = v + 2 * q_v x (q_v x v + w v)
    qv = np.array([x, y, z])
    t = np.cross(qv, v) + w * v
    return v + 2 * np.cross(qv, t)


def parse_obj(path):
    verts = []
    faces = []
    with open(path) as f:
        for line in f:
            if line.startswith("v "):
                verts.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("f "):
                parts = line.split()[1:]
                idx = [int(p.split("/")[0]) - 1 for p in parts]
                for k in range(1, len(idx) - 1):
                    faces.append([idx[0], idx[k], idx[k + 1]])
    return np.array(verts, dtype=np.float64), np.array(faces, dtype=np.int64)


def decimate(verts, faces, cells):
    """Grid clustering: snap to a cell grid, merge, rebuild, drop degenerates."""
    if len(verts) == 0 or len(faces) == 0:
        return verts, faces
    lo = verts.min(axis=0)
    hi = verts.max(axis=0)
    extent = float(np.max(hi - lo))
    cell = max(extent / cells, 1e-12)
    keys = np.floor((verts - lo) / cell).astype(np.int64)
    # Unique cells, first-occurrence order (stable).
    _, first, inverse = np.unique(keys, axis=0, return_index=True, return_inverse=True)
    order = np.argsort(first)
    remap = np.empty(len(order), dtype=np.int64)
    remap[order] = np.arange(len(order))
    inverse = remap[inverse]
    # Cell centroids.
    counts = np.bincount(inverse, minlength=len(order))
    sums = np.zeros((len(order), 3))
    np.add.at(sums, inverse, verts)
    new_verts = sums / counts[:, None]
    # Rebuild faces; drop degenerate and duplicate triangles.
    f = inverse[faces]
    keep = (f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])
    f = f[keep]
    if len(f) == 0:
        return new_verts, np.zeros((0, 3), dtype=np.int64)
    f = np.sort(f, axis=1)  # duplicate detection is order-insensitive
    _, uniq = np.unique(f, axis=0, return_index=True)
    f = f[np.sort(uniq)]
    return new_verts, f


def vertex_normals(verts, faces):
    normals = np.zeros_like(verts)
    if len(faces):
        a = verts[faces[:, 0]]
        b = verts[faces[:, 1]]
        c = verts[faces[:, 2]]
        n = np.cross(b - a, c - a)  # area-weighted
        for k in range(3):
            np.add.at(normals, faces[:, k], n)
    lengths = np.linalg.norm(normals, axis=1)
    lengths[lengths == 0] = 1
    return normals / lengths[:, None]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    default_cache = os.path.join(os.environ.get("HOME", "/tmp"), ".cache", "deskworlds-flybody")
    ap.add_argument("--cache", default=os.environ.get("FLYBODY_CACHE", default_cache))
    ap.add_argument(
        "--out",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "scenes", "flyscape", "data-flybody",
        ),
    )
    args = ap.parse_args()
    os.makedirs(args.cache, exist_ok=True)
    os.makedirs(args.out, exist_ok=True)

    # --- skeleton: body world transforms from the MJCF -------------------------
    print("fetch:")
    xml_path = fetch("fruitfly.xml", args.cache)
    tree = ET.parse(xml_path)
    root = tree.getroot()

    bodies = {}  # name -> (parent, pos, quat)
    geoms = []   # (body, file_stem, geom_pos, geom_quat)
    # The asset table maps mesh *names* to files; geoms reference the names.
    mesh_files = {}
    for mesh in root.findall("./asset/mesh"):
        file = mesh.get("file")
        if file:
            mesh_files[mesh.get("name")] = file[:-4] if file.endswith(".obj") else file

    def walk(node, parent):
        for child in node.findall("body"):
            name = child.get("name")
            pos = np.array([float(x) for x in (child.get("pos") or "0 0 0").split()])
            quat = np.array([float(x) for x in (child.get("quat") or "1 0 0 0").split()])
            bodies[name] = (parent, pos, quat)
            for geom in child.findall("geom"):
                mesh = geom.get("mesh")
                if mesh:
                    gpos = np.array([float(x) for x in (geom.get("pos") or "0 0 0").split()])
                    gquat = np.array([float(x) for x in (geom.get("quat") or "1 0 0 0").split()])
                    geoms.append((name, mesh_files.get(mesh, mesh), gpos, gquat))
            walk(child, name)

    worldbody = root.find("worldbody")
    # The fly hangs off the first top-level body chain; walk it all.
    walk(worldbody, None)

    def world_transform(name):
        chain = []
        while name is not None:
            chain.append(name)
            name = bodies[name][0]
        pos = np.zeros(3)
        quat = np.array([1.0, 0, 0, 0])
        for node in reversed(chain):
            _, p, q = bodies[node]
            pos = pos + qrot(quat, p)
            quat = qmul(quat, q)
        return pos, quat

    # --- mesh geometry ----------------------------------------------------------
    # geom name -> (file stem, world matrix). Only meshes in our subset load.
    wanted = set(BODY_MESHES + PROBOSCIS_MESHES + WING_MESHES)
    leg_meshes = {}
    for side in LEG_SIDES:
        for row in LEG_ROW:
            for seg in LEG_SEGMENTS:
                if seg == "claw":
                    stem = f"tarsal_claw_{row}_{side}_brown"
                elif seg.startswith("tarsus_"):
                    stem = f"tarsus_{row}_{seg.split('_')[1]}_{side}_body"
                else:
                    stem = f"{seg}_{row}_{side}_body"
                leg_meshes[stem] = (side, row, seg)
    wanted |= set(leg_meshes)

    # Load every wanted mesh that the XML references with a geom transform.
    # Several geoms may share a file (body + _black variants use distinct files,
    # but lower/upper halves reuse); the first reference wins, which is the
    # primary one in the MJCF's own ordering.
    cache = {}
    refs = {}
    for body, stem, gpos, gquat in geoms:
        if stem not in wanted or stem in refs:
            continue
        refs[stem] = (body, gpos, gquat)

    print(f"meshes referenced: {len(refs)} of {len(wanted)} wanted")
    missing = sorted(wanted - set(refs))
    if missing:
        print("  not referenced by the MJCF (skipped):", ", ".join(missing[:6]),
              f"... {len(missing)} total" if len(missing) > 6 else "")

    for mesh in sorted(refs):
        path = fetch(f"{mesh}.obj", args.cache)
        verts, faces = parse_obj(path)
        cache[mesh] = (verts * 0.1, faces)  # MJCF compiler scale

    def bake(mesh):
        """Mesh vertices in rig space (x,y,z)->(y,z,x), scaled; returns verts, faces."""
        body, gpos, gquat = refs[mesh]
        bpos, bquat = world_transform(body)
        world_quat = qmul(bquat, gquat)
        world_pos = bpos + qrot(bquat, gpos)
        verts, faces = cache[mesh]
        v = np.array([qrot(world_quat, p) + world_pos for p in verts])
        return v, faces

    # Rig transform: model (x fwd, y left, z up) -> rig (y up, z fwd), keeping
    # handedness: rig = model[[1, 2, 0]].
    def to_rig(v):
        return v[:, [1, 2, 0]]

    # --- assembly ----------------------------------------------------------------
    print("bake:")
    # Overall extents decide the scale and the reach.
    all_v = []
    for mesh in sorted(refs):
        v, _ = bake(mesh)
        all_v.append(to_rig(v))
    all_v = np.concatenate(all_v)
    lo, hi = all_v.min(axis=0), all_v.max(axis=0)
    length = float(hi[2] - lo[2])
    scale = TARGET_LENGTH / length
    print(f"  model length {length:.4f} -> scale {scale:.3f}")

    def bake_rig(mesh, origin):
        v, faces = bake(mesh)
        v = to_rig(v) * scale
        if origin is not None:
            v = v - origin
        return v, faces

    parts = {}  # name -> (verts, faces, cells)

    def add(name, mesh, origin, cells):
        v, faces = bake_rig(mesh, origin)
        v, faces = decimate(v, faces, cells)
        parts[name] = (v, faces)

    thorax_origin = np.zeros(3)  # thorax is the model root
    for mesh in BODY_MESHES:
        if mesh not in refs:
            continue
        cells = CELLS["eye"] if mesh.startswith("head_red") else CELLS["body"]
        if mesh.startswith(("haltere", "antenna")):
            cells = CELLS["small"]
        add(mesh, mesh, thorax_origin, cells)

    # Proboscis pivot: rostrum body position (rig space, scaled).
    rpos, _ = world_transform("rostrum")
    proboscis_origin = to_rig(rpos[None, :])[0] * scale
    for mesh in PROBOSCIS_MESHES:
        if mesh in refs:
            add(mesh, mesh, proboscis_origin, CELLS["proboscis"])

    # Wings: hinge at the wing root; rig-space axes.
    wings = []
    for side in LEG_SIDES:
        root_body = f"wing_{side}"
        wpos, _ = world_transform(root_body)
        hinge = to_rig(wpos[None, :])[0] * scale
        meshes = []
        for mesh in WING_MESHES:
            if mesh.startswith(f"wing_{side}") and mesh in refs:
                add(mesh, mesh, hinge, CELLS["wing"])
                meshes.append(mesh)
        wings.append({"side": 1 if hinge[0] >= 0 else -1, "hinge": hinge.tolist(),
                      "meshes": meshes})

    # Legs: hip frame at the coxa, knee frame at the tibia.
    legs = []
    for row in LEG_ROW:
        for side in LEG_SIDES:
            coxa_body = f"coxa_{row}_{side}"
            tibia_body = f"tibia_{row}_{side}"
            hip_pos, _ = world_transform(coxa_body)
            knee_pos, _ = world_transform(tibia_body)
            hip = to_rig(hip_pos[None, :])[0] * scale
            knee = to_rig(knee_pos[None, :])[0] * scale
            hip_meshes, knee_meshes = [], []
            for seg in ("coxa", "femur"):
                stem = f"{seg}_{row}_{side}_body"
                if stem in refs:
                    add(stem, stem, hip, CELLS["leg"])
                    hip_meshes.append(stem)
            for seg in ("tibia", "tarsus_1", "tarsus_2", "tarsus_3", "tarsus_4", "claw"):
                if seg == "claw":
                    stem = f"tarsal_claw_{row}_{side}_brown"
                elif seg.startswith("tarsus_"):
                    stem = f"tarsus_{row}_{seg.split('_')[1]}_{side}_body"
                else:
                    stem = f"{seg}_{row}_{side}_body"
                if stem in refs:
                    add(stem, stem, knee, CELLS["leg"])
                    knee_meshes.append(stem)
            legs.append({
                "row": row, "side": "left" if hip[0] >= 0 else "right",
                "sign": 1 if hip[0] >= 0 else -1,
                "hip": {"pos": hip.tolist(), "meshes": hip_meshes},
                "knee": {"pos": (knee - hip).tolist(), "meshes": knee_meshes},
            })

    # Reach: distance from the thorax origin to the lowest baked vertex.
    reach = 0.0
    for name, (v, _) in parts.items():
        for leg in legs:
            if name in leg["hip"]["meshes"]:
                reach = max(reach, -(v[:, 1].min() + leg["hip"]["pos"][1] * 0))
            if name in leg["knee"]["meshes"]:
                pass
    # Simpler and exact: lowest point of any leg mesh in body frame.
    reach = 0.0
    for leg in legs:
        for name in leg["hip"]["meshes"]:
            v = parts[name][0]
            reach = max(reach, -(v[:, 1].min() + leg["hip"]["pos"][1]))
        for name in leg["knee"]["meshes"]:
            v = parts[name][0]
            reach = max(reach, -(v[:, 1].min() + leg["hip"]["pos"][1] + leg["knee"]["pos"][1]))
    print(f"  reach {reach:.3f}")

    # --- binary ---------------------------------------------------------------
    blobs = []
    manifest_parts = {}
    offset = 0
    total_v = total_f = 0
    for name in sorted(parts):
        v, faces = parts[name]
        if len(faces) == 0:
            continue
        n = vertex_normals(v, faces)
        pos_bytes = v.astype("<f4").tobytes()
        nrm_bytes = np.clip(np.round(n * 127), -127, 127).astype("<i1").tobytes()
        # Pad the normal section so the index section starts 4-byte aligned:
        # Uint16Array/Float32Array views require aligned byte offsets.
        pad = (-len(nrm_bytes)) % 4
        nrm_bytes += b"\x00" * pad
        if len(v) < 65536:
            idx_bytes = faces.astype("<u2").tobytes()
            dtype = "u16"
        else:
            idx_bytes = faces.astype("<u4").tobytes()
            dtype = "u32"
        # Pad the whole part to 4 bytes so the next part's float view is aligned.
        idx_bytes += b"\x00" * ((-len(idx_bytes)) % 4)
        manifest_parts[name] = {
            "pos": [offset, len(pos_bytes)],
            "nrm": [offset + len(pos_bytes), len(nrm_bytes)],
            "idx": [offset + len(pos_bytes) + len(nrm_bytes), len(idx_bytes)],
            "verts": int(len(v)), "tris": int(len(faces)), "dtype": dtype,
        }
        blobs += [pos_bytes, nrm_bytes, idx_bytes]
        offset += len(pos_bytes) + len(nrm_bytes) + len(idx_bytes)
        total_v += len(v)
        total_f += len(faces)

    with open(os.path.join(args.out, "flybody.bin"), "wb") as f:
        f.write(b"".join(blobs))

    manifest = {
        "version": 1,
        "source": "TuragaLab/flybody fruitfly assets (Apache-2.0), decimated",
        "scale": scale,
        "reach": reach,
        "parts": manifest_parts,
        "rig": {
            "body": [m for m in BODY_MESHES if m in manifest_parts],
            "proboscis": {"pivot": proboscis_origin.tolist(),
                          "meshes": [m for m in PROBOSCIS_MESHES if m in manifest_parts]},
            "wings": wings,
            "legs": legs,
        },
    }
    with open(os.path.join(args.out, "flybody.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    bin_size = os.path.getsize(os.path.join(args.out, "flybody.bin"))
    print(f"  parts: {len(manifest_parts)}, verts: {total_v}, tris: {total_f}")
    print(f"  flybody.bin {bin_size / 1e6:.2f} MB, flybody.json "
          f"{os.path.getsize(os.path.join(args.out, 'flybody.json')) / 1e3:.0f} kB")


if __name__ == "__main__":
    main()
