import * as THREE from "three";
import { randomGenerator, vec } from "./math.js";

// Fly world's room: a desk at dusk. A lamp-lit window throws warm light across books, a
// mug and a sheet of paper, and the desk surface runs to the edges of the screen. The
// flies walk on the desk and the book tops, land on the mug rim, and fly between them;
// the cursor moves across the same space as a hand would.
//
// Everything here is procedural, like the other worlds: no texture files, no external
// assets. `obstacles` are kept as axis-aligned boxes for flight avoidance, `ledges` as
// walkable tops, and `landmarks` as the handful of places a flying fly picks as a
// destination when it has no better reason.

export const DESK = Object.freeze({ halfWidth: 16.5, halfDepth: 7.6, top: 0 });
// The walking and flying bounds are the part of the desk the camera actually shows;
// a fly at the frame's edge is a fly nobody can watch.
export const BOUNDS = Object.freeze({
  minX: -8,
  maxX: 7,
  minY: 0.02,
  maxY: 7.8,
  minZ: -5.2,
  maxZ: 4,
});

const BOOKS = [
  { x: -6.6, z: -2.7, width: 4.9, height: 0.56, depth: 3.3, colour: 0x8a4438, title: 0xa8764e },
  { x: -6.32, z: -2.52, width: 4.35, height: 0.48, depth: 3.0, colour: 0x4a6349, title: 0xa8764e },
  { x: -6.05, z: -2.36, width: 3.8, height: 0.42, depth: 2.7, colour: 0x3d4c6a, title: 0xa8764e },
];
const PAPERBACKS = [
  { x: 0.8, z: -3.5, width: 2.9, height: 0.3, depth: 3.6, colour: 0x6b4a63, title: 0xb9a06a },
  { x: 0.7, z: -3.38, width: 2.75, height: 0.24, depth: 3.35, colour: 0x8a6a35, title: 0xb9a06a },
];
const MUG = { x: 5.9, z: -1.9, radius: 0.72, height: 1.06 };

function boxMesh(material, width, height, depth, position) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function stack(scene, books, startY) {
  const ledges = [];
  const obstacles = [];
  let y = startY;
  for (const book of books) {
    const material = new THREE.MeshStandardMaterial({
      color: book.colour,
      roughness: 0.62,
    });
    const cover = new THREE.MeshStandardMaterial({ color: book.title, roughness: 0.72 });
    const group = new THREE.Group();
    // The spine block, and a slimmer cover slab sticking out on both sides so a stack
    // reads as separate books rather than one striped box.
    const block = boxMesh(material, book.width, book.height, book.depth, vec(0, 0, 0));
    const page = boxMesh(cover, book.width * 0.94, book.height * 0.52, book.depth * 1.045, vec(0, 0, 0));
    group.add(block, page);
    group.position.set(book.x, y + book.height / 2, book.z);
    group.rotation.y = book.rotation ?? 0;
    scene.add(group);
    y += book.height;
    const top = y;
    ledges.push({
      kind: "book",
      minX: book.x - book.width * 0.42,
      maxX: book.x + book.width * 0.42,
      minZ: book.z - book.depth * 0.42,
      maxZ: book.z + book.depth * 0.42,
      top,
    });
    obstacles.push({
      minX: book.x - book.width / 2,
      maxX: book.x + book.width / 2,
      minY: top - book.height,
      maxY: top,
      minZ: book.z - book.depth / 2,
      maxZ: book.z + book.depth / 2,
    });
  }
  return { top: y, ledges, obstacles };
}

export function createEnvironment(scene) {
  // The desk. A slab rather than a plane so its front edge shows a little thickness at
  // the near rim of the frame.
  const desk = new THREE.Mesh(
    new THREE.BoxGeometry(DESK.halfWidth * 2, 0.6, DESK.halfDepth * 2),
    new THREE.MeshStandardMaterial({ color: 0x5c402a, roughness: 0.83 }),
  );
  desk.position.y = DESK.top - 0.3;
  desk.receiveShadow = true;
  desk.castShadow = false;
  scene.add(desk);

  // The room behind: one wall, dark enough that the window reads as its light source.
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 22),
    new THREE.MeshStandardMaterial({ color: 0x2b2116, roughness: 1 }),
  );
  wall.position.set(0, 7, -8.4);
  wall.receiveShadow = true;
  scene.add(wall);

  // The window: a pane of late sun. Emissive rather than lit, so it stays the brightest
  // thing in the room and the flies' landmark. Its values run above 1 on purpose; tone
  // mapping brings them back down as glow. The frame is the backing the pane sits on,
  // with mullions crossing in front — a frame box in front of the pane would simply
  // hide the light it frames. It sits inside the camera's view: the room's light source
  // has to be visible or the desk reads as lit by nothing.
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(6.9, 8.1, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 0.9 }),
  );
  frame.position.set(-6.0, 5.0, -8.46);
  scene.add(frame);
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 7.6),
    // Above 1 so it is the brightest thing in the room, but only a little: pushed much
    // higher, ACES tone mapping rolls the amber off to white. Fog stays off the pane so
    // the far wall's haze does not grey the light itself.
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.25, 0.88, 0.52), fog: false }),
  );
  pane.position.set(-6.0, 5.0, -8.3);
  scene.add(pane);
  const mullion = new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 0.9 });
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.18, 0.06), mullion);
  crossbar.position.set(-6.0, 5.0, -8.26);
  scene.add(crossbar);
  const upright = new THREE.Mesh(new THREE.BoxGeometry(0.18, 7.6, 0.06), mullion);
  upright.position.set(-6.0, 5.0, -8.26);
  scene.add(upright);

  // The book stacks and the mug. The stacks land off-centre so the desk's open middle
  // stays clear for walking and for food.
  const ledges = [];
  const obstacles = [];
  const big = stack(scene, BOOKS, DESK.top);
  ledges.push(...big.ledges);
  obstacles.push(...big.obstacles);
  const small = stack(scene, PAPERBACKS, DESK.top);
  ledges.push(...small.ledges);
  obstacles.push(...small.obstacles);

  const mugMaterial = new THREE.MeshStandardMaterial({ color: 0xcfc3ad, roughness: 0.5 });
  const mug = new THREE.Mesh(
    new THREE.CylinderGeometry(MUG.radius, MUG.radius * 0.92, MUG.height, 26),
    mugMaterial,
  );
  mug.position.set(MUG.x, MUG.height / 2, MUG.z);
  mug.castShadow = true;
  mug.receiveShadow = true;
  scene.add(mug);
  const handle = new THREE.Mesh(
    new THREE.TorusGeometry(0.34, 0.07, 10, 22, Math.PI * 1.3),
    mugMaterial,
  );
  handle.position.set(MUG.x + MUG.radius * 0.94, MUG.height * 0.55, MUG.z);
  handle.rotation.z = -Math.PI / 2.4;
  handle.castShadow = true;
  scene.add(handle);
  ledges.push({
    kind: "mug",
    minX: MUG.x - MUG.radius * 0.62,
    maxX: MUG.x + MUG.radius * 0.62,
    minZ: MUG.z - MUG.radius * 0.62,
    maxZ: MUG.z + MUG.radius * 0.62,
    top: MUG.height,
  });
  obstacles.push({
    minX: MUG.x - MUG.radius,
    maxX: MUG.x + MUG.radius,
    minY: 0,
    maxY: MUG.height,
    minZ: MUG.z - MUG.radius,
    maxZ: MUG.z + MUG.radius,
  });

  // A pencil and a sheet of paper. Neither blocks a fly: the pencil is too small to
  // steer around and the paper is thinner than a leg.
  const pencil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 6.6, 9),
    new THREE.MeshStandardMaterial({ color: 0xc9a13f, roughness: 0.55 }),
  );
  pencil.rotation.z = Math.PI / 2;
  pencil.rotation.y = 0.24;
  pencil.position.set(2.2, 0.05, 1.9);
  pencil.castShadow = true;
  scene.add(pencil);
  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.05, 0.22, 9),
    new THREE.MeshStandardMaterial({ color: 0x2b2119, roughness: 0.8 }),
  );
  tip.rotation.z = -Math.PI / 2;
  tip.position.set(2.2 + 3.35 * Math.cos(0.24), 0.05, 1.9 - 3.35 * Math.sin(0.24));
  scene.add(tip);

  const paper = new THREE.Mesh(
    new THREE.BoxGeometry(5.8, 0.02, 4.1),
    new THREE.MeshStandardMaterial({ color: 0xc4bba7, roughness: 0.94 }),
  );
  paper.rotation.y = -0.2;
  paper.position.set(3.6, DESK.top + 0.01, 1.1);
  paper.receiveShadow = true;
  scene.add(paper);

  // The places a fly heads for when it takes off with nothing else on its mind.
  const landmarks = [
    { name: "books", point: vec(-6.1, big.top + 0.5, -2.5) },
    { name: "paperbacks", point: vec(0.75, small.top + 0.5, -3.4) },
    { name: "mug", point: vec(MUG.x, MUG.height + 0.5, MUG.z) },
    { name: "window", point: vec(-5.2, 5.2, -4.6) },
  ];

  // The height a walking fly stands on at (x, z): the highest ledge whose top covers the
  // point, or the desk itself. Food and feet both use this, so nothing hovers.
  function supportHeight(x, z) {
    let top = DESK.top;
    for (const ledge of ledges) {
      if (x >= ledge.minX && x <= ledge.maxX && z >= ledge.minZ && z <= ledge.maxZ)
        top = Math.max(top, ledge.top);
    }
    return top;
  }

  // The ledge whose footprint holds (x, z), or null for the desk. A walking fly uses it
  // to notice when it has stepped off a book edge.
  function surfaceAt(x, z) {
    for (const ledge of ledges) {
      if (x >= ledge.minX && x <= ledge.maxX && z >= ledge.minZ && z <= ledge.maxZ)
        return ledge;
    }
    return null;
  }

  return {
    obstacles,
    ledges,
    landmarks,
    bounds: BOUNDS,
    supportHeight,
    surfaceAt,
    stats: { books: BOOKS.length + PAPERBACKS.length, ledges: ledges.length },
  };
}

// Dust in the lamplight: slow motes that make the room feel like air. Positions are
// stepped on the CPU — a few hundred points is nothing — and wrapped inside the bounds.
export function createMotes(scene, { count = 220, seed = 5511 } = {}) {
  const random = randomGenerator(seed);
  const positions = new Float32Array(count * 3);
  const velocities = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (random() * 2 - 1) * 13;
    positions[i * 3 + 1] = 0.2 + random() * 7;
    positions[i * 3 + 2] = -5 + random() * 11;
    velocities[i * 3] = (random() - 0.5) * 0.05;
    velocities[i * 3 + 1] = (random() - 0.5) * 0.03;
    velocities[i * 3 + 2] = (random() - 0.5) * 0.05;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const material = new THREE.PointsMaterial({
    color: 0xffe3b3,
    size: 0.05,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  function update(dt) {
    for (let i = 0; i < count; i++) {
      positions[i * 3] += velocities[i * 3] * dt;
      positions[i * 3 + 1] += velocities[i * 3 + 1] * dt;
      positions[i * 3 + 2] += velocities[i * 3 + 2] * dt;
      if (positions[i * 3 + 1] < 0.1) positions[i * 3 + 1] = 7.2;
      if (positions[i * 3 + 1] > 7.6) positions[i * 3 + 1] = 0.15;
      if (positions[i * 3] < -13.5) positions[i * 3] = 13.5;
      if (positions[i * 3] > 13.5) positions[i * 3] = -13.5;
      if (positions[i * 3 + 2] < -5.5) positions[i * 3 + 2] = 6.3;
      if (positions[i * 3 + 2] > 6.3) positions[i * 3 + 2] = -5.5;
    }
    geometry.attributes.position.needsUpdate = true;
  }

  return { update, stats: { motes: count } };
}
