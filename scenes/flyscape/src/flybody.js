// The anatomical fly: FlyBody meshes assembled into the rig fly.js animates.
//
// tools/fetch_flybody_pack.py decimates the TuragaLab/flybody meshes
// (Apache-2.0) and bakes every part into the same frames the procedural rig
// uses, so this module only has to glue groups and materials together:
// rotation.x = leg swing, rotation.z = wing lift, proboscis scale.y = feeding.
//
// Materials follow the procedural palette so the world stays coherent:
// dark grey-brown shell, darker abdomen, near-black head, the same red eyes.

import * as THREE from "three";

const COLOURS = {
  shell: 0x5a4a3a, shellDark: 0x42372c, black: 0x211c17, eye: 0x7a2018,
  ocelli: 0x6a5a48, brown: 0x5f4330, membrane: 0xdfe8ea,
};

// Chitin: a warm diffuse body with a soft sheen, glossy eyes, and wings that
// read as wings: translucent but with visible veins and a blue edge.
function materialFor(name) {
  if (name.includes("_membrane")) {
    return new THREE.MeshPhysicalMaterial({
      color: COLOURS.membrane,
      roughness: 0.3,
      metalness: 0,
      transparent: true,
      opacity: 0.38,
      side: THREE.DoubleSide,
      depthWrite: false,
      sheen: 0.8,
      sheenColor: new THREE.Color(0x9fc4e8),
      sheenRoughness: 0.6,
    });
  }
  if (name.includes("_red")) {
    return new THREE.MeshPhysicalMaterial({
      color: COLOURS.eye, roughness: 0.14, metalness: 0.05,
      clearcoat: 1.0, clearcoatRoughness: 0.1,
    });
  }
  if (name.includes("_ocelli"))
    return new THREE.MeshStandardMaterial({ color: COLOURS.ocelli, roughness: 0.45 });
  if (name.includes("_black"))
    return new THREE.MeshStandardMaterial({ color: COLOURS.black, roughness: 0.5 });
  if (name.includes("_brown"))
    return new THREE.MeshStandardMaterial({ color: 0x4a3322, roughness: 0.55 });
  if (name.includes("_lower")) {
    return new THREE.MeshPhysicalMaterial({
      color: COLOURS.shellDark, roughness: 0.52, clearcoat: 0.25, clearcoatRoughness: 0.5,
    });
  }
  return new THREE.MeshPhysicalMaterial({
    color: COLOURS.shell, roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.45,
  });
}

export async function loadFlybodyPack(base) {
  const [manifest, binary] = await Promise.all([
    fetch(`${base}/flybody.json`).then((response) => {
      if (!response.ok) throw new Error("flybody.json missing");
      return response.json();
    }),
    fetch(`${base}/flybody.bin`).then((response) => {
      if (!response.ok) throw new Error("flybody.bin missing");
      return response.arrayBuffer();
    }),
  ]);
  return { manifest, binary };
}

function geometryFor(pack, name) {
  const part = pack.manifest.parts[name];
  const buffer = pack.binary;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(buffer, part.pos[0], part.verts * 3), 3),
  );
  geometry.setAttribute(
    "normal",
    new THREE.BufferAttribute(new Int8Array(buffer, part.nrm[0], part.verts * 3), 3, true),
  );
  const indices =
    part.dtype === "u16"
      ? new Uint16Array(buffer, part.idx[0], part.tris * 3)
      : new Uint32Array(buffer, part.idx[0], part.tris * 3);
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

// One rig per fly: shared geometry, fresh materials (wings animate opacity per
// fly). Shape matches buildAnatomy() in fly.js exactly.
export function createFlybodyRigFactory(pack) {
  const manifest = pack.manifest;
  const rig = manifest.rig;
  const geometries = new Map();
  for (const name of Object.keys(manifest.parts))
    geometries.set(name, geometryFor(pack, name));

  function meshFor(name) {
    const mesh = new THREE.Mesh(geometries.get(name), materialFor(name));
    if (!name.includes("_membrane")) mesh.castShadow = true;
    return mesh;
  }

  return function createRig() {
    const group = new THREE.Group();
    group.name = "fly";
    const body = new THREE.Group();
    body.position.y = manifest.reach;
    group.add(body);

    for (const name of rig.body) body.add(meshFor(name));

    const proboscis = new THREE.Group();
    proboscis.position.fromArray(rig.proboscis.pivot);
    for (const name of rig.proboscis.meshes) proboscis.add(meshFor(name));
    proboscis.scale.y = 0.3; // retracted, as the procedural rig starts
    body.add(proboscis);

    const wings = rig.wings.map((wing) => {
      const hinge = new THREE.Group();
      hinge.position.fromArray(wing.hinge);
      let membrane = null;
      for (const name of wing.meshes) {
        const mesh = meshFor(name);
        if (name.includes("_membrane")) membrane = mesh;
        hinge.add(mesh);
      }
      body.add(hinge);
      return {
        hinge,
        mesh: membrane,
        side: wing.side,
        // The MJCF zero pose spreads the wings for flight; walking folds them
        // back over the abdomen (sweep) and lifts them just clear of it (lift),
        // which is why the fold lifts with the side's sign.
        rest: { sweep: 1.15, lift: wing.side * 0.14 },
        fold: 1,
        opacityBase: 0.38,
      };
    });

    const legs = rig.legs.map((leg, index) => {
      const hip = new THREE.Group();
      hip.position.fromArray(leg.hip.pos);
      for (const name of leg.hip.meshes) hip.add(meshFor(name));
      const knee = new THREE.Group();
      knee.position.fromArray(leg.knee.pos);
      for (const name of leg.knee.meshes) knee.add(meshFor(name));
      hip.add(knee);
      body.add(hip);
      return {
        hip,
        knee,
        side: leg.sign,
        offset: [0, Math.PI, 0, Math.PI, 0, Math.PI][index] + leg.sign * 0.18,
        rest: { fore: 0, splay: leg.sign * 0.3 },
      };
    });

    return { group, body, wings, legs, proboscis, reach: manifest.reach };
  };
}
