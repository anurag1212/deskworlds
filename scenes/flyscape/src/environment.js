import * as THREE from "three";
import { randomGenerator, vec } from "./math.js";

// Fly world's room: a desk at dusk, now dressed properly. Oak planks with
// grain, knots and seams; cloth-bound books with striated page edges; a lathe
// ceramic mug with coffee; a printed sheet with a coffee ring; a hexagonal
// pencil; sticky notes, an eraser, a pen. A branch of leaf-shadow falls across
// the desk where the window light lands. All textures are procedural canvases
// (node tests skip them; the room still runs headless).

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
  { x: -6.6, z: -2.7, width: 4.9, height: 0.56, depth: 3.3, colour: 0x7c3b31 },
  { x: -6.32, z: -2.52, width: 4.35, height: 0.48, depth: 3.0, colour: 0x40573f },
  { x: -6.05, z: -2.36, width: 3.8, height: 0.42, depth: 2.7, colour: 0x33405b },
];
const PAPERBACKS = [
  { x: 0.8, z: -3.5, width: 2.9, height: 0.3, depth: 3.6, colour: 0x6b4a63 },
  { x: 0.7, z: -3.38, width: 2.75, height: 0.24, depth: 3.35, colour: 0x8a6a35 },
];
const MUG = { x: 5.9, z: -1.9, radius: 0.72, height: 1.06 };

const hasDOM = typeof document !== "undefined";

function canvasTexture(width, height, draw, { srgb = true, repeat = null } = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext("2d"), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  if (repeat) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
  }
  return texture;
}

// Deterministic per-texture noise so the room is identical run to run.
function noiseMaker(seed) {
  const random = randomGenerator(seed);
  return random;
}

function woodTexture() {
  const random = noiseMaker(0x51ab);
  return canvasTexture(1024, 512, (ctx, w, h) => {
    const planks = 6;
    const plankH = h / planks;
    for (let p = 0; p < planks; p++) {
      const tone = 0.92 + random() * 0.16;
      ctx.fillStyle = `rgb(${Math.round(106 * tone)},${Math.round(74 * tone)},${Math.round(46 * tone)})`;
      ctx.fillRect(0, p * plankH, w, plankH);
      // Grain: long strokes within the plank.
      for (let i = 0; i < 26; i++) {
        const y = p * plankH + random() * plankH;
        const light = random() > 0.5;
        ctx.strokeStyle = light
          ? `rgba(158,118,80,${0.04 + random() * 0.08})`
          : `rgba(48,32,19,${0.05 + random() * 0.11})`;
        ctx.lineWidth = 0.7 + random() * 2.2;
        ctx.beginPath();
        let x = -20, yy = y;
        ctx.moveTo(x, yy);
        while (x < w + 20) {
          x += 16 + random() * 34;
          yy = y + Math.sin(x * 0.014 + i * 2.1) * (2 + random() * 4) + (random() - 0.5) * 1.6;
          ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
      // A knot now and then.
      if (random() < 0.75) {
        const kx = random() * w;
        const ky = p * plankH + plankH * (0.3 + random() * 0.4);
        for (let r = 14; r > 0; r -= 3) {
          ctx.strokeStyle = `rgba(52,34,20,${0.12 + random() * 0.12})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.ellipse(kx, ky, r * 1.7, r * 0.7, 0.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      // The seam between planks.
      ctx.fillStyle = "rgba(28,18,10,0.85)";
      ctx.fillRect(0, (p + 1) * plankH - 2, w, 3);
      ctx.fillStyle = "rgba(210,170,120,0.16)";
      ctx.fillRect(0, p * plankH, w, 1);
    }
    // Pore speckle.
    for (let i = 0; i < 4200; i++) {
      ctx.fillStyle = `rgba(${random() > 0.5 ? "34,22,13" : "150,110,72"},${0.04 + random() * 0.08})`;
      ctx.fillRect(random() * w, random() * h, 1 + random(), 0.6 + random() * 0.7);
    }
  });
}

function clothTexture(tint) {
  const random = noiseMaker(0x77e1 + tint);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 3) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + random() * 0.05})`;
      ctx.fillRect(0, y, w, 1);
    }
    for (let x = 0; x < w; x += 3) {
      ctx.fillStyle = `rgba(255,255,255,${0.05 + random() * 0.05})`;
      ctx.fillRect(x, 0, 1, h);
    }
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = `rgba(${random() > 0.5 ? "0,0,0" : "255,255,255"},${0.03 + random() * 0.05})`;
      ctx.fillRect(random() * w, random() * h, 2, 1);
    }
  }, { repeat: [2, 1] });
}

function pageTexture() {
  const random = noiseMaker(0x9c3f);
  return canvasTexture(256, 64, (ctx, w, h) => {
    ctx.fillStyle = "#e6dcc4";
    ctx.fillRect(0, 0, w, h);
    for (let x = 0; x < w; x += 1) {
      const shade = 190 + Math.round(random() * 40);
      ctx.fillStyle = `rgba(${shade},${shade - 12},${shade - 34},${0.5})`;
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillStyle = "rgba(120,100,70,0.25)";
    ctx.fillRect(0, 0, w, 1);
    ctx.fillRect(0, h - 1, w, 1);
  }, { repeat: [8, 1] });
}

function paperTexture() {
  const random = noiseMaker(0x2b77);
  return canvasTexture(512, 384, (ctx, w, h) => {
    ctx.fillStyle = "#d8cfb8";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 5200; i++) {
      ctx.fillStyle = `rgba(${random() > 0.5 ? "120,108,84" : "244,238,220"},${0.05 + random() * 0.07})`;
      ctx.fillRect(random() * w, random() * h, 1.4, 1);
    }
    // Faint ruled lines, like a page torn from a notebook.
    ctx.strokeStyle = "rgba(110,120,150,0.14)";
    ctx.lineWidth = 1;
    for (let y = 26; y < h; y += 22) {
      ctx.beginPath();
      ctx.moveTo(14, y);
      ctx.lineTo(w - 14, y);
      ctx.stroke();
    }
    // A coffee ring: the desk's own history.
    ctx.strokeStyle = "rgba(96,62,30,0.5)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(w * 0.72, h * 0.3, 46, 40, 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = "rgba(120,80,40,0.22)";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.ellipse(w * 0.72, h * 0.3, 50, 44, 0.3, 0, Math.PI * 2);
    ctx.stroke();
    // Soft corner shading.
    const vignette = ctx.createRadialGradient(w / 2, h / 2, h * 0.3, w / 2, h / 2, w * 0.75);
    vignette.addColorStop(0, "rgba(0,0,0,0)");
    vignette.addColorStop(1, "rgba(90,76,52,0.18)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, w, h);
  });
}

function leafShadowTexture() {
  const random = noiseMaker(0x3ea5);
  return canvasTexture(512, 512, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "rgba(12,8,5,0.55)";
    for (let i = 0; i < 26; i++) {
      const x = random() * w;
      const y = random() * h;
      const r = 16 + random() * 40;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(random() * Math.PI);
      ctx.beginPath();
      // A leaf: two arcs meeting at the tips.
      ctx.moveTo(-r, 0);
      ctx.quadraticCurveTo(0, -r * 0.7, r, 0);
      ctx.quadraticCurveTo(0, r * 0.7, -r, 0);
      ctx.fill();
      ctx.restore();
    }
    // A twig or two.
    ctx.strokeStyle = "rgba(12,8,5,0.45)";
    ctx.lineWidth = 6;
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      let x = random() * w * 0.4;
      let y = random() * h;
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += 30 + random() * 50;
        y += (random() - 0.5) * 60;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
}

function paneTexture() {
  return canvasTexture(128, 256, (ctx, w, h) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#fff2d4");
    gradient.addColorStop(0.55, "#ffdfae");
    gradient.addColorStop(1, "#f3bd7c");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);
    // A hint of distant hills at the bottom of the view.
    ctx.fillStyle = "rgba(196,150,96,0.5)";
    ctx.beginPath();
    ctx.moveTo(0, h * 0.86);
    ctx.quadraticCurveTo(w * 0.3, h * 0.8, w * 0.6, h * 0.87);
    ctx.quadraticCurveTo(w * 0.85, h * 0.92, w, h * 0.88);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.fill();
  });
}

function wallTexture() {
  const random = noiseMaker(0x6d12);
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = "#2b2116";
    ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 2600; i++) {
      ctx.fillStyle = `rgba(${random() > 0.5 ? "12,8,5" : "74,58,40"},${0.05 + random() * 0.08})`;
      ctx.fillRect(random() * w, random() * h, 1.5, 1.5);
    }
  }, { repeat: [8, 4] });
}

function shaftTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 128);
  gradient.addColorStop(0, "rgba(255,214,160,0.16)");
  gradient.addColorStop(0.55, "rgba(255,206,150,0.07)");
  gradient.addColorStop(1, "rgba(255,200,140,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 128);
  // Feather the sides too, so the sheet has no straight cut anywhere.
  const side = ctx.createLinearGradient(0, 0, 64, 0);
  side.addColorStop(0, "rgba(0,0,0,0)");
  side.addColorStop(0.25, "rgba(0,0,0,1)");
  side.addColorStop(0.75, "rgba(0,0,0,1)");
  side.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, 64, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function boxMesh(material, width, height, depth, position) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
  mesh.position.copy(position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function stack(scene, books, startY, cloth, pages) {
  const ledges = [];
  const obstacles = [];
  let y = startY;
  for (const book of books) {
    const material = new THREE.MeshStandardMaterial({
      color: book.colour,
      map: cloth,
      roughness: 0.85,
    });
    const cover = new THREE.MeshStandardMaterial({
      color: 0xd9cdb2,
      map: pages,
      roughness: 0.9,
    });
    const group = new THREE.Group();
    const block = boxMesh(material, book.width, book.height, book.depth, vec(0, 0, 0));
    // The page block sticks out of the cover, as a closed book's pages do.
    const page = boxMesh(cover, book.width * 0.94, book.height * 0.5, book.depth * 1.045, vec(0, 0, 0));
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
  const wood = hasDOM ? woodTexture() : null;
  const cloth = hasDOM ? clothTexture(1) : null;
  const pages = hasDOM ? pageTexture() : null;
  const paperMap = hasDOM ? paperTexture() : null;
  const wallMap = hasDOM ? wallTexture() : null;
  const leafShadow = hasDOM ? leafShadowTexture() : null;

  const desk = new THREE.Mesh(
    new THREE.BoxGeometry(DESK.halfWidth * 2, 0.6, DESK.halfDepth * 2),
    new THREE.MeshPhysicalMaterial({
      color: wood ? 0xffffff : 0x5c402a,
      map: wood,
      bumpMap: wood,
      bumpScale: 0.02,
      roughness: 0.62,
      clearcoat: 0.12,
      clearcoatRoughness: 0.5,
    }),
  );
  desk.position.y = DESK.top - 0.3;
  desk.receiveShadow = true;
  scene.add(desk);

  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 22),
    new THREE.MeshStandardMaterial({ color: wallMap ? 0xffffff : 0x2b2116, map: wallMap, roughness: 1 }),
  );
  wall.position.set(0, 7, -8.4);
  wall.receiveShadow = true;
  scene.add(wall);

  // The window: sky gradient in the pane, backing frame, mullions, and the
  // light shaft slanting to the desk.
  const paneMap = hasDOM ? paneTexture() : null;
  const frame = new THREE.Mesh(
    new THREE.BoxGeometry(6.9, 8.1, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 0.85 }),
  );
  frame.position.set(-6.0, 5.0, -8.46);
  scene.add(frame);
  const pane = new THREE.Mesh(
    new THREE.PlaneGeometry(6.4, 7.6),
    new THREE.MeshBasicMaterial({
      color: paneMap ? new THREE.Color(1.32, 1.26, 1.12) : new THREE.Color(1.25, 0.88, 0.52),
      map: paneMap,
      fog: false,
    }),
  );
  pane.position.set(-6.0, 5.0, -8.3);
  scene.add(pane);
  const mullion = new THREE.MeshStandardMaterial({ color: 0x33261a, roughness: 0.85 });
  const crossbar = new THREE.Mesh(new THREE.BoxGeometry(6.4, 0.18, 0.06), mullion);
  crossbar.position.set(-6.0, 5.0, -8.26);
  scene.add(crossbar);
  const upright = new THREE.Mesh(new THREE.BoxGeometry(0.18, 7.6, 0.06), mullion);
  upright.position.set(-6.0, 5.0, -8.26);
  scene.add(upright);

  if (hasDOM) {
    const shaft = new THREE.Mesh(
      new THREE.PlaneGeometry(5.6, 6.4),
      new THREE.MeshBasicMaterial({
        map: shaftTexture(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: false,
      }),
    );
    shaft.position.set(-6.0, 1.35, -3.4);
    shaft.rotation.x = -1.18;
    scene.add(shaft);

    // Leaf shadow: the window light falls through a branch onto the desk and
    // the wall. Dark, soft, multiplied into the light.
    const deskLeaves = new THREE.Mesh(
      new THREE.PlaneGeometry(7.5, 5.2),
      new THREE.MeshBasicMaterial({
        map: leafShadow, transparent: true, opacity: 0.75, depthWrite: false, fog: true,
      }),
    );
    deskLeaves.rotation.x = -Math.PI / 2;
    deskLeaves.rotation.z = 0.35;
    deskLeaves.position.set(-4.6, DESK.top + 0.008, 0.6);
    deskLeaves.receiveShadow = false;
    scene.add(deskLeaves);
    const wallLeaves = new THREE.Mesh(
      new THREE.PlaneGeometry(6.5, 5.0),
      new THREE.MeshBasicMaterial({
        map: leafShadow, transparent: true, opacity: 0.5, depthWrite: false, fog: true,
      }),
    );
    wallLeaves.rotation.z = -0.4;
    wallLeaves.position.set(-3.6, 3.6, -8.34);
    scene.add(wallLeaves);
  }

  const ledges = [];
  const obstacles = [];
  const big = stack(scene, BOOKS, DESK.top, cloth, pages);
  ledges.push(...big.ledges);
  obstacles.push(...big.obstacles);
  const small = stack(scene, PAPERBACKS, DESK.top, cloth, pages);
  ledges.push(...small.ledges);
  obstacles.push(...small.obstacles);

  // The mug: a lathe profile with a rounded rim, an inner wall, coffee, and a
  // handle. Same footprint and height as before.
  const mugMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xd8ccb6,
    roughness: 0.35,
    clearcoat: 0.6,
    clearcoatRoughness: 0.3,
  });
  const profile = [
    [0.0, 0.0], [0.55, 0.0], [0.66, 0.02], [0.72, 0.12], [0.74, 0.5],
    [0.73, 0.9], [0.70, 1.02], [0.62, 1.06], [0.56, 1.04], [0.52, 0.9], [0.5, 0.78],
  ].map(([r, y]) => new THREE.Vector2(r * (MUG.radius / 0.72), y * (MUG.height / 1.06)));
  const mug = new THREE.Mesh(new THREE.LatheGeometry(profile, 40), mugMaterial);
  mug.position.set(MUG.x, 0, MUG.z);
  mug.castShadow = true;
  mug.receiveShadow = true;
  scene.add(mug);
  const coffee = new THREE.Mesh(
    new THREE.CircleGeometry(MUG.radius * 0.72, 30),
    new THREE.MeshPhysicalMaterial({
      color: 0x2a1708, roughness: 0.15, clearcoat: 0.9, clearcoatRoughness: 0.2,
    }),
  );
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.set(MUG.x, MUG.height * 0.74, MUG.z);
  scene.add(coffee);
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

  // A hexagonal pencil, wood and graphite.
  const pencilWood = new THREE.MeshStandardMaterial({ color: 0xc9a13f, roughness: 0.55, flatShading: true });
  const pencil = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 6.6, 6, 1), pencilWood);
  pencil.rotation.z = Math.PI / 2;
  pencil.rotation.y = 0.24;
  pencil.position.set(2.2, 0.075, 1.9);
  pencil.castShadow = true;
  scene.add(pencil);
  const tipWood = new THREE.Mesh(
    new THREE.ConeGeometry(0.075, 0.3, 6),
    new THREE.MeshStandardMaterial({ color: 0xb08a52, roughness: 0.7, flatShading: true }),
  );
  tipWood.rotation.z = -Math.PI / 2;
  tipWood.position.set(2.2 + 3.3 * Math.cos(0.24), 0.075, 1.9 - 3.3 * Math.sin(0.24));
  scene.add(tipWood);
  const graphite = new THREE.Mesh(
    new THREE.ConeGeometry(0.03, 0.12, 8),
    new THREE.MeshStandardMaterial({ color: 0x22201e, roughness: 0.4 }),
  );
  graphite.rotation.z = -Math.PI / 2;
  graphite.position.set(2.2 + 3.48 * Math.cos(0.24), 0.075, 1.9 - 3.48 * Math.sin(0.24));
  scene.add(graphite);

  // The sheet of paper, gently curled at the far edge, with a coffee ring.
  const paperGeometry = new THREE.PlaneGeometry(5.8, 4.1, 22, 14);
  {
    const position = paperGeometry.attributes.position;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      const y = position.getY(i);
      position.setZ(i, 0.05 * Math.exp(-((x + 2.9) ** 2) / 2.2) + 0.03 * Math.exp(-((y - 2.0) ** 2) / 1.4));
    }
    paperGeometry.computeVertexNormals();
  }
  const paperMesh = new THREE.Mesh(
    paperGeometry,
    new THREE.MeshStandardMaterial({
      color: paperMap ? 0xffffff : 0xc4bba7,
      map: paperMap,
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
  );
  paperMesh.rotation.x = -Math.PI / 2;
  paperMesh.rotation.z = -0.2;
  paperMesh.position.set(3.6, DESK.top + 0.02, 1.1);
  paperMesh.receiveShadow = true;
  scene.add(paperMesh);

  // Lived-in props, outside the flies' walking bounds where possible.
  const stickyColours = [0xe8d98a, 0xdba6a0, 0x9fc4d8];
  stickyColours.forEach((colour, i) => {
    const note = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.02, 1.1),
      new THREE.MeshStandardMaterial({ color: colour, roughness: 0.85 }),
    );
    note.position.set(-9.6 + i * 0.25, DESK.top + 0.012 + i * 0.022, 1.4 - i * 0.3);
    note.rotation.y = 0.2 + i * 0.22;
    note.castShadow = true;
    note.receiveShadow = true;
    scene.add(note);
  });
  const eraser = new THREE.Mesh(
    new THREE.BoxGeometry(1.15, 0.3, 0.6),
    new THREE.MeshStandardMaterial({ color: 0xd9b8ad, roughness: 0.95 }),
  );
  eraser.position.set(-9.1, DESK.top + 0.15, -3.6);
  eraser.rotation.y = -0.5;
  eraser.castShadow = true;
  scene.add(eraser);
  const pen = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.045, 5.2, 12),
    new THREE.MeshPhysicalMaterial({ color: 0x1d232c, roughness: 0.3, clearcoat: 0.7 }),
  );
  pen.rotation.z = Math.PI / 2;
  pen.rotation.y = -0.35;
  pen.position.set(-8.9, 0.06, 3.1);
  pen.castShadow = true;
  scene.add(pen);

  const landmarks = [
    { name: "books", point: vec(-6.1, big.top + 0.5, -2.5) },
    { name: "paperbacks", point: vec(0.75, small.top + 0.5, -3.4) },
    { name: "mug", point: vec(MUG.x, MUG.height + 0.5, MUG.z) },
    { name: "window", point: vec(-5.2, 5.2, -4.6) },
  ];

  function supportHeight(x, z) {
    let top = DESK.top;
    for (const ledge of ledges) {
      if (x >= ledge.minX && x <= ledge.maxX && z >= ledge.minZ && z <= ledge.maxZ)
        top = Math.max(top, ledge.top);
    }
    return top;
  }

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
    stats: { books: BOOKS.length + PAPERBACKS.length, ledges: ledges.length, props: 7 },
  };
}

// Dust in the lamplight: slow motes that make the room feel like air. Positions are
// stepped on the CPU — a few hundred points is nothing — and wrapped inside the bounds.
export function createMotes(scene, { count = 260, seed = 5511 } = {}) {
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
    size: 0.055,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.5,
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
