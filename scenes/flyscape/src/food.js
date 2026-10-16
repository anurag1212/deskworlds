import * as THREE from "three";
import { randomGenerator, vec } from "./math.js";

// Sugar on the desk. The wallpaper menu's Feed drops a scatter of cubes, a click drops
// one where it landed, and the flies walk or fly to them. A cube falls until it reaches
// whatever is under it — desk or book — and dissolves on its own if nobody comes.
//
// Only colour and size are decided here. Who eats what, and how fast, belongs to the fly
// and the circuit: `consume` is the fly's bite made visible.

const CUBE = 0.24;
const DROP_HEIGHT = 7.2;
const LIFE = 34; // seconds on the desk before an untouched cube starts to fade
const FADE = 4;

export function createFood(scene, { supportHeight = () => 0, seed = 2207 } = {}) {
  const random = randomGenerator(seed);
  const geometry = new THREE.BoxGeometry(CUBE, CUBE * 0.86, CUBE);
  const material = new THREE.MeshStandardMaterial({
    color: 0xf3edde,
    roughness: 0.38,
    flatShading: true,
  });
  const items = [];
  let nextId = 1;
  const stats = { dropped: 0, eaten: 0, dissolved: 0 };

  function drop(point) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    const position = vec(point.x, DROP_HEIGHT, point.z);
    mesh.position.copy(position);
    mesh.rotation.set(random() * 3, random() * 3, random() * 3);
    scene.add(mesh);
    const item = {
      id: nextId++,
      mesh,
      position,
      plane: "falling", // falling -> resting -> gone
      amount: 1,
      age: 0,
      spin: vec((random() - 0.5) * 3, (random() - 0.5) * 3, (random() - 0.5) * 3),
      fall: 0.4,
    };
    items.push(item);
    stats.dropped++;
    return item;
  }

  // Every piece a nose could find today: resting, still more than a stain.
  function available() {
    return items.filter((item) => item.plane === "resting" && item.amount > 0.05);
  }

  // The nearest piece to a point, or null. `radius` bounds the interest.
  function nearest(point, radius = Infinity) {
    let best = null;
    let bestDistance = radius * radius;
    for (const item of available()) {
      const distance =
        (item.position.x - point.x) ** 2 + (item.position.z - point.z) ** 2;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = item;
      }
    }
    return best;
  }

  // A bite. Returns true when the piece is finished.
  function consume(item, amount) {
    if (!item || item.plane === "gone") return false;
    item.amount = Math.max(0, item.amount - amount);
    if (item.amount <= 0.3) item.age = Math.max(item.age, LIFE);
    if (item.amount <= 0) {
      finish(item, "eaten");
      return true;
    }
    return false;
  }

  function finish(item, reason) {
    if (item.plane === "gone") return;
    item.plane = "gone";
    scene.remove(item.mesh);
    if (reason === "eaten") stats.eaten++;
    else stats.dissolved++;
  }

  function update(dt) {
    for (const item of items) {
      if (item.plane === "gone") continue;
      if (item.plane === "falling") {
        item.fall = Math.min(6, item.fall + dt * 9);
        item.position.y -= item.fall * dt;
        item.mesh.rotation.x += item.spin.x * dt;
        item.mesh.rotation.y += item.spin.y * dt;
        item.mesh.rotation.z += item.spin.z * dt;
        const rest = supportHeight(item.position.x, item.position.z) + CUBE * 0.45;
        if (item.position.y <= rest) {
          item.position.y = rest;
          item.plane = "resting";
        }
      } else {
        item.age += dt;
        if (item.age > LIFE + FADE) {
          finish(item, "dissolved");
          continue;
        }
      }
      // A bite shows as the cube shrinking; the fade is a slow shrink to nothing.
      const scale = Math.max(0.001, item.amount) ** (1 / 3);
      const fade = item.plane === "resting" ? Math.max(0, 1 - Math.max(0, item.age - LIFE) / FADE) : 1;
      item.mesh.scale.setScalar(scale * fade);
      item.mesh.position.copy(item.position);
    }
    // Finished pieces leave the array; nothing downstream holds an id across frames.
    for (let i = items.length - 1; i >= 0; i--)
      if (items[i].plane === "gone") items.splice(i, 1);
  }

  function dispose() {
    scene.remove(...items.map((item) => item.mesh));
    items.length = 0;
    geometry.dispose();
    material.dispose();
  }

  return { drop, update, available, nearest, consume, dispose, stats };
}
