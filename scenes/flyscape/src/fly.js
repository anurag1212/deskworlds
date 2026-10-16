import * as THREE from "three";
import { angleDelta, clamp, damp, randomGenerator, TAU, vec } from "./math.js";

// The flies.
//
// A procedural Drosophila body — thorax, abdomen, head and compound eyes, two wings, six
// two-segment legs, a proboscis — with a small behaviour machine on top. The machine does
// not decide *what* a fly wants; it reads the drive record the brain seam hands it every
// step ({ escape, arousal, steer, hungry }) and turns it into walking, grooming, taking
// off, flying, landing and feeding. Walking is kinematic but the legs are a real tripod
// gait, the wings fold away on foot and beat in the air, and every heading is slewed at a
// rate instead of snapping, so nothing about a fly reads as a snapped animation.
//
// This is the body the connectome engine will drive. Nothing below this file's public
// surface assumes where a drive came from.

export const FLY_COUNT = 4;

const WALK_SPEED = 1.05;
const FLIGHT_SPEED = 3.7;
const FLEE_SPEED = 8.6;
const LAND_SINK = 1.8;
const WALK_STRIDE = 7.5; // leg phase radians per world unit walked
const FLAP_RATE = 52; // wing phase radians per second in flight (~8 Hz, readable)
const LEG_REACH = 0.3; // thorax height above the feet

function buildAnatomy() {
  const group = new THREE.Group();
  group.name = "fly";
  const body = new THREE.Group();
  body.position.y = LEG_REACH;
  group.add(body);

  const shell = new THREE.MeshStandardMaterial({ color: 0x4c4238, roughness: 0.42 });
  const shellDark = new THREE.MeshStandardMaterial({ color: 0x39312a, roughness: 0.5 });
  const eyeMaterial = new THREE.MeshStandardMaterial({
    color: 0x8c3028,
    roughness: 0.28,
    metalness: 0.1,
  });
  const legMaterial = new THREE.MeshStandardMaterial({ color: 0x2c2520, roughness: 0.6 });

  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.155, 20, 14), shell);
  thorax.scale.set(1.0, 0.92, 1.12);
  thorax.position.z = 0.045;
  body.add(thorax);

  const abdomen = new THREE.Mesh(new THREE.SphereGeometry(0.14, 18, 12), shellDark);
  abdomen.scale.set(0.9, 0.82, 1.55);
  abdomen.position.set(0, -0.012, -0.205);
  abdomen.rotation.x = -0.14;
  body.add(abdomen);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.098, 16, 12), shellDark);
  head.scale.set(1, 0.94, 0.9);
  head.position.set(0, 0.03, 0.268);
  body.add(head);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), eyeMaterial);
    eye.scale.set(1, 1.16, 0.85);
    eye.position.set(side * 0.058, 0.047, 0.302);
    body.add(eye);
  }

  // The proboscis: a blunt cone under the head that swings out when a fly feeds.
  const proboscisPivot = new THREE.Group();
  proboscisPivot.position.set(0, -0.052, 0.29);
  const proboscis = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.13, 10), shellDark);
  proboscis.rotation.x = Math.PI;
  proboscis.position.y = -0.065;
  proboscisPivot.add(proboscis);
  proboscisPivot.scale.y = 0.3;
  body.add(proboscisPivot);

  // Wings: a plane hung from a hinge at the root, one mirrored pair. Resting they are
  // swept back over the abdomen; in flight they unfold and beat about the body axis, so
  // the tip travels an arc the way a real stroke does.
  const wings = [];
  for (const side of [-1, 1]) {
    const hinge = new THREE.Group();
    hinge.position.set(side * 0.07, 0.118, 0.02);
    const geometry = new THREE.PlaneGeometry(0.46, 0.15);
    geometry.translate(side * 0.23, 0, 0); // hinge at the wing root
    const material = new THREE.MeshStandardMaterial({
      color: 0xd9dedb,
      roughness: 0.24,
      metalness: 0.06,
      transparent: true,
      opacity: 0.52,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -0.06;
    hinge.add(mesh);
    body.add(hinge);
    wings.push({
      hinge,
      mesh,
      side,
      rest: { sweep: 1.12, lift: side * 0.1 },
      fold: 1, // 1 pushed back on the body, 0 unfolded; animated
    });
  }

  // Legs: fore, mid and hind pairs, each a hip, an upper segment, a knee and a lower
  // segment. Walk phase is the tripod gait: fore-left, mid-right and hind-left step
  // together, the others answer. Indices here are [L1, L2, L3, R1, R2, R3].
  const legs = [];
  const spans = [
    { z: 0.1, upper: 0.12, lower: 0.145, fore: 0.42 },
    { z: 0.01, upper: 0.13, lower: 0.155, fore: 0.04 },
    { z: -0.085, upper: 0.15, lower: 0.175, fore: -0.4 },
  ];
  const tripod = [0, Math.PI, 0, Math.PI, 0, Math.PI];
  for (const side of [-1, 1]) {
    for (const span of spans) {
      const index = legs.length;
      const hip = new THREE.Group();
      hip.position.set(side * 0.072, -0.05, span.z);
      hip.rotation.z = side * 0.3;
      hip.rotation.x = span.fore;
      const upper = new THREE.Mesh(
        new THREE.CylinderGeometry(0.011, 0.01, span.upper, 7),
        legMaterial,
      );
      upper.position.y = -span.upper / 2;
      hip.add(upper);
      const knee = new THREE.Group();
      knee.position.y = -span.upper;
      const lower = new THREE.Mesh(
        new THREE.CylinderGeometry(0.009, 0.008, span.lower, 7),
        legMaterial,
      );
      lower.position.y = -span.lower / 2;
      knee.add(lower);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6), legMaterial);
      foot.position.y = -span.lower;
      knee.add(foot);
      hip.add(knee);
      body.add(hip);
      legs.push({
        hip,
        knee,
        side,
        offset: tripod[index] + side * 0.18,
        rest: { fore: span.fore, splay: side * 0.3 },
      });
    }
  }

  // Everything solid casts a shadow; the translucent wings would only smear theirs.
  const wingMeshes = new Set(wings.map((wing) => wing.mesh));
  body.traverse((object) => {
    if (object.isMesh && !wingMeshes.has(object)) object.castShadow = true;
  });

  return { group, body, wings, legs, proboscis: proboscisPivot };
}

function createFly(index, random) {
  const anatomy = buildAnatomy();
  const fly = {
    id: index,
    group: anatomy.group,
    parts: anatomy,
    mode: "rest",
    modeTime: 0,
    timer: 0.5 + random() * 2,
    heading: random() * TAU,
    velocity: vec(0, 0, 0),
    target: vec(0, 0, 0),
    targetKind: "wander",
    targetFood: null,
    surface: null, // the ledge walked on, null for the desk itself
    wingPhase: random() * TAU,
    legPhase: random() * TAU,
    bobPhase: random() * TAU,
    turnRate: 0,
    random,
  };
  // Start scattered on the desk, all facing somewhere different, inside the frame the
  // camera actually shows.
  const angle = random() * TAU;
  const radius = 2.2 + random() * 3.4;
  fly.group.position.set(
    Math.cos(angle) * radius,
    0.004,
    Math.sin(angle) * radius * 0.45 + 0.3,
  );
  fly.group.rotation.y = fly.heading;
  return fly;
}

export function createFlies(scene, {
  obstacles = [],
  landmarks = [],
  bounds,
  supportHeight = () => 0,
  surfaceAt = () => null,
  seed = 43107,
} = {}) {
  const flies = [];
  for (let index = 0; index < FLY_COUNT; index++)
    flies.push(createFly(index, randomGenerator(seed + index * 7919)));

  const stats = {
    takeoffs: 0,
    flights: 0,
    landings: 0,
    meals: 0,
    walks: 0,
    grooms: 0,
    flees: 0,
  };

  const steer = new THREE.Vector3();
  const delta = new THREE.Vector3();

  function insideObstacle(x, y, z, margin = 0) {
    for (const box of obstacles) {
      if (
        x >= box.minX - margin &&
        x <= box.maxX + margin &&
        z >= box.minZ - margin &&
        z <= box.maxZ + margin &&
        y >= box.minY - margin &&
        y <= box.maxY + margin
      )
        return true;
    }
    return false;
  }

  // Sugar outside the room's bounds is sugar no fly can ever reach; the walk would
  // press a fly against an invisible wall with the cube still out of reach.
  function reachable(point) {
    return (
      point.x >= bounds.minX &&
      point.x <= bounds.maxX &&
      point.z >= bounds.minZ &&
      point.z <= bounds.maxZ
    );
  }

  // A walking destination on the fly's current surface, never inside a book or the mug.
  function pickWalkTarget(fly) {
    const top = fly.surface ? fly.surface.top : 0;
    for (let attempt = 0; attempt < 14; attempt++) {
      let x, z;
      if (fly.surface) {
        const ledge = fly.surface;
        x = ledge.minX + fly.random() * (ledge.maxX - ledge.minX);
        z = ledge.minZ + fly.random() * (ledge.maxZ - ledge.minZ);
      } else {
        x = bounds.minX + fly.random() * (bounds.maxX - bounds.minX);
        z = bounds.minZ + fly.random() * (bounds.maxZ - bounds.minZ);
      }
      // A book is wider than the room's walking bounds; a destination off the edge of
      // the frame would park a fly where nobody can see it.
      x = clamp(x, bounds.minX, bounds.maxX);
      z = clamp(z, bounds.minZ, bounds.maxZ);
      if (!insideObstacle(x, top + 0.1, z, 0.22)) {
        fly.target.set(x, top, z);
        fly.targetKind = "wander";
        return;
      }
    }
    fly.target.set(fly.group.position.x, top, fly.group.position.z);
    fly.targetKind = "wander";
  }

  // A flying destination: the food if the circuit is hungry, else a landmark or an air
  // point over the desk. Whatever it is, landing logic puts the feet under it.
  function pickFlightTarget(fly, ctx, drive, fleeing) {
    if (!fleeing && drive.hungry) {
      const food = ctx.food.nearest(fly.group.position, 12);
      if (food && reachable(food.position)) {
        fly.target.set(food.position.x, food.position.y + 0.35, food.position.z);
        fly.targetKind = "food";
        fly.targetFood = food;
        return;
      }
    }
    if (!fleeing && landmarks.length > 0 && fly.random() < 0.7) {
      const pick = landmarks[Math.floor(fly.random() * landmarks.length)];
      fly.target.set(
        pick.point.x + (fly.random() - 0.5) * 1.6,
        Math.min(pick.point.y + fly.random() * 0.4, bounds.maxY),
        pick.point.z + (fly.random() - 0.5) * 1.6,
      );
      fly.targetKind = "landmark";
      return;
    }
    fly.target.set(
      bounds.minX + fly.random() * (bounds.maxX - bounds.minX),
      0.9 + fly.random() * 2.6,
      bounds.minZ + fly.random() * (bounds.maxZ - bounds.minZ),
    );
    fly.targetKind = "air";
  }

  function beginTakeoff(fly, ctx) {
    fly.mode = "takeoff";
    fly.modeTime = 0;
    fly.timer = 0.42;
    stats.takeoffs++;
    ctx.onEvent?.(fly, "took-off");
  }

  function beginFlee(fly, ctx) {
    fly.mode = "flee";
    fly.modeTime = 0;
    fly.timer = 1.3 + fly.random() * 1.4;
    stats.flees++;
    const away = steer
      .copy(fly.group.position)
      .sub(ctx.pointer ? ctx.pointer.position : vec(0, 0, 0));
    away.y = 0;
    if (away.lengthSq() < 1e-4) away.set(1, 0, 0);
    away.normalize().multiplyScalar(FLEE_SPEED);
    away.y = 2.4;
    fly.velocity.copy(away);
    ctx.onEvent?.(fly, "fled");
  }

  // The frame's drive for this fly, defaulted so the body still runs in a bare test.
  const CALM = { escape: 0, arousal: 0.2, steer: 0, hungry: false };

  function stepFly(fly, dt, time, ctx) {
    const drive = ctx.drives?.[fly.id] ?? CALM;
    fly.modeTime += dt;

    // A loom interrupts anything but a flee already under way.
    if (drive.escape > 0.55 && fly.mode !== "flee") beginFlee(fly, ctx);

    const position = fly.group.position;
    const currentTop = fly.surface ? fly.surface.top : 0;

    switch (fly.mode) {
      case "rest": {
        fly.timer -= dt;
        if (fly.timer > 0) break;
        const candidate = drive.hungry ? ctx.food.nearest(position, 10) : null;
        const food = candidate && reachable(candidate.position) ? candidate : null;
        if (food) {
          if (supportHeight(food.position.x, food.position.z) === currentTop) {
            fly.target.set(food.position.x, food.position.y, food.position.z);
            fly.targetKind = "food";
            fly.targetFood = food;
            fly.mode = "walk";
            fly.modeTime = 0;
            stats.walks++;
          } else {
            fly.target.set(food.position.x, food.position.y + 0.4, food.position.z);
            fly.targetKind = "food";
            fly.targetFood = food;
            beginTakeoff(fly, ctx);
          }
        } else if (drive.arousal > 0.6 && fly.random() < drive.arousal * 0.5) {
          pickFlightTarget(fly, ctx, drive, false);
          beginTakeoff(fly, ctx);
        } else if (fly.random() < 0.16) {
          fly.mode = "groom";
          fly.modeTime = 0;
          fly.timer = 1.6 + fly.random() * 2.2;
          stats.grooms++;
        } else {
          pickWalkTarget(fly);
          fly.mode = "walk";
          fly.modeTime = 0;
          stats.walks++;
        }
        break;
      }

      case "groom": {
        fly.timer -= dt;
        // The front legs come up to the head; everything else holds still.
        for (const leg of fly.parts.legs) {
          const front = leg.hip.position.z > 0.05;
          const lift = front ? Math.max(0, Math.sin(time * 9 + leg.offset)) * 0.85 : 0;
          leg.hip.rotation.x = damp(leg.hip.rotation.x, leg.rest.fore - lift, 14, dt);
          leg.knee.rotation.x = damp(leg.knee.rotation.x, front ? -lift * 1.1 : 0, 14, dt);
        }
        if (fly.timer <= 0) {
          fly.mode = "rest";
          fly.modeTime = 0;
          fly.timer = 0.6 + fly.random() * 3;
        }
        break;
      }

      case "walk": {
        if (fly.targetKind === "food" && (!fly.targetFood || fly.targetFood.plane === "gone")) {
          fly.mode = "rest";
          fly.modeTime = 0;
          fly.timer = 0.4 + fly.random() * 2;
          fly.targetFood = null;
          break;
        }
        const toTarget = steer.copy(fly.target).sub(position);
        toTarget.y = 0;
        const distance = toTarget.length();
        if (distance < 0.16) {
          if (fly.targetKind === "food" && fly.targetFood && fly.targetFood.plane !== "gone") {
            fly.mode = "eat";
            fly.modeTime = 0;
            fly.timer = 7;
          } else {
            fly.mode = "rest";
            fly.modeTime = 0;
            fly.timer = 0.4 + fly.random() * 3.5;
          }
          break;
        }
        toTarget.divideScalar(distance);
        // A lean from the circuit bends the path slightly, the way a walking fly
        // wanders: enough to see, never enough to derail a walk to food.
        fly.heading +=
          angleDelta(fly.heading, Math.atan2(toTarget.x, toTarget.z)) * Math.min(1, dt * 6);
        fly.heading += drive.steer * dt * 0.5;
        // The cord's motor tone sets the walking pace: a resting cord shuffles,
        // a driven one strides. Measured tone on the real cord runs median
        // 0.8 Hz, p90 6.4 Hz, max ~25 Hz; the curve is tuned to that range.
        // Feet never slide: stride per unit distance is constant, only speed
        // changes. Modeled interface; the pace comes from real motor neurons.
        const tone = drive.legTone;
        const pace = tone === undefined ? 1 : clamp(0.5 + tone / 8, 0.5, 1.8);
        const step = Math.min(distance, WALK_SPEED * pace * dt);
        const nextX = clamp(position.x + Math.sin(fly.heading) * step, bounds.minX, bounds.maxX);
        const nextZ = clamp(position.z + Math.cos(fly.heading) * step, bounds.minZ, bounds.maxZ);
        const nextGround = supportHeight(nextX, nextZ);
        if (fly.surface && nextGround < fly.surface.top - 0.05) {
          // The book ran out under the feet: fly the rest of the way.
          fly.target.set(fly.target.x, fly.target.y + 0.4, fly.target.z);
          beginTakeoff(fly, ctx);
          break;
        }
        position.x = nextX;
        position.z = nextZ;
        fly.legPhase += step * WALK_STRIDE;
        break;
      }

      case "takeoff": {
        fly.timer -= dt;
        // A crouch that releases: the legs compress, then the fly is airborne.
        const crouch = Math.max(0, Math.sin(Math.min(1, fly.modeTime / 0.42) * Math.PI));
        fly.parts.body.position.y = LEG_REACH - crouch * 0.06;
        if (fly.timer <= 0) {
          fly.mode = "fly";
          fly.modeTime = 0;
          stats.flights++;
          fly.velocity.set(
            Math.sin(fly.heading) * FLIGHT_SPEED,
            1.6,
            Math.cos(fly.heading) * FLIGHT_SPEED,
          );
        }
        break;
      }

      case "fly":
      case "flee": {
        const fleeing = fly.mode === "flee";
        const maxSpeed = fleeing ? FLEE_SPEED : FLIGHT_SPEED + drive.arousal * 1.2;
        fly.timer -= dt;

        if (!fleeing) {
          delta.copy(fly.target).sub(position);
          const distance = delta.length();
          if (distance < 0.72) {
            fly.mode = "land";
            fly.modeTime = 0;
            fly.target.set(
              fly.target.x,
              supportHeight(fly.target.x, fly.target.z) + 0.004,
              fly.target.z,
            );
            break;
          }
          delta.divideScalar(distance);
          steer.copy(delta).multiplyScalar(maxSpeed);
        } else {
          if (fly.timer <= 0) {
            // The landfall after a scare: head for whatever ledge is nearest in front.
            pickFlightTarget(fly, ctx, drive, false);
            fly.mode = "fly";
            fly.modeTime = 0;
          }
          steer.copy(fly.velocity).normalize().multiplyScalar(maxSpeed);
          // The upward component of the scare levels off as it runs out.
          steer.y = Math.max(steer.y, 0.6) * clamp(fly.timer + 0.4, 0, 1.4);
          steer.x += (fly.random() - 0.5) * 0.7;
          steer.z += (fly.random() - 0.5) * 0.7;
        }

        // Steer clear of the books and the mug, and stay inside the room.
        for (const box of obstacles) {
          const cx = (box.minX + box.maxX) / 2;
          const cz = (box.minZ + box.maxZ) / 2;
          const dx = position.x - cx;
          const dz = position.z - cz;
          const distance = Math.hypot(dx, dz);
          const reach =
            Math.max((box.maxX - box.minX) / 2, (box.maxZ - box.minZ) / 2) + 0.6;
          if (distance < reach && position.y < box.maxY + 0.4) {
            steer.x += (dx / (distance || 1)) * maxSpeed * 0.9;
            steer.z += (dz / (distance || 1)) * maxSpeed * 0.9;
            steer.y += 0.9;
          }
        }
        // Neighbours keep a little room; nobody stacks on one spot in the air.
        for (const other of flies) {
          if (other === fly) continue;
          delta.copy(position).sub(other.group.position);
          const distance = delta.length();
          if (distance < 0.42 && distance > 1e-4)
            steer.addScaledVector(delta.normalize(), (0.42 - distance) * 12);
        }
        if (position.x < bounds.minX + 0.5) steer.x += maxSpeed * 0.6;
        if (position.x > bounds.maxX - 0.5) steer.x -= maxSpeed * 0.6;
        if (position.z < bounds.minZ + 0.5) steer.z += maxSpeed * 0.6;
        if (position.z > bounds.maxZ - 0.5) steer.z -= maxSpeed * 0.6;

        fly.velocity.lerp(steer, Math.min(1, dt * 3.4));
        const speed = fly.velocity.length();
        if (speed > maxSpeed) fly.velocity.multiplyScalar(maxSpeed / speed);
        position.addScaledVector(fly.velocity, dt);
        const floor = supportHeight(position.x, position.z) + LEG_REACH * 0.4;
        position.y = clamp(position.y, floor, bounds.maxY);
        position.x = clamp(position.x, bounds.minX, bounds.maxX);
        position.z = clamp(position.z, bounds.minZ, bounds.maxZ);
        break;
      }

      case "land": {
        position.y = Math.max(fly.target.y, position.y - LAND_SINK * dt);
        delta.copy(fly.target).sub(position);
        delta.y = 0;
        const distance = delta.length();
        if (distance > 0.05) {
          delta.divideScalar(distance);
          position.addScaledVector(delta, Math.min(distance, dt * 0.8));
          position.x = clamp(position.x, bounds.minX, bounds.maxX);
          position.z = clamp(position.z, bounds.minZ, bounds.maxZ);
          fly.heading += angleDelta(fly.heading, Math.atan2(delta.x, delta.z)) * dt * 8;
        }
        if (position.y <= fly.target.y + 0.01) {
          position.y = fly.target.y;
          fly.surface = surfaceAt(position.x, position.z);
          stats.landings++;
          ctx.onEvent?.(fly, "landed");
          if (fly.targetKind === "food" && fly.targetFood && fly.targetFood.plane !== "gone") {
            fly.mode = "eat";
            fly.modeTime = 0;
            fly.timer = 7;
          } else {
            fly.mode = "rest";
            fly.modeTime = 0;
            fly.timer = 0.5 + fly.random() * 3;
          }
        }
        break;
      }

      case "eat": {
        const food = fly.targetFood;
        fly.timer -= dt;
        if (!food || food.plane === "gone") {
          fly.mode = "rest";
          fly.modeTime = 0;
          fly.timer = 1 + fly.random() * 2;
          fly.targetFood = null;
          break;
        }
        delta.copy(food.position).sub(position);
        delta.y = 0;
        const distance = delta.length();
        if (distance > 0.25) {
          position.addScaledVector(delta.divideScalar(distance), Math.min(distance - 0.22, dt * 0.5));
          position.x = clamp(position.x, bounds.minX, bounds.maxX);
          position.z = clamp(position.z, bounds.minZ, bounds.maxZ);
        }
        fly.heading +=
          angleDelta(
            fly.heading,
            Math.atan2(food.position.x - position.x, food.position.z - position.z),
          ) * dt * 6;
        const finished = ctx.food.consume(food, dt * 0.34);
        // Proboscis out while feeding, folded back the moment it stops.
        fly.parts.proboscis.scale.y = damp(
          fly.parts.proboscis.scale.y,
          finished || fly.timer <= 0 ? 0.3 : 1,
          10,
          dt,
        );
        if (finished || fly.timer <= 0) {
          if (finished) {
            stats.meals++;
            ctx.onEvent?.(fly, "fed");
          }
          fly.mode = "rest";
          fly.modeTime = 0;
          fly.timer = 1 + fly.random() * 2;
          fly.targetFood = null;
        }
        break;
      }
    }

    // Wings: folded on foot, unfolded and beating in the air. Phase runs on its own
    // clock, so a resting fly's wings only breathe and a paused world holds still.
    const airborne = fly.mode === "fly" || fly.mode === "flee" || fly.mode === "land";
    const flying = fly.mode === "fly" || fly.mode === "flee";
    fly.wingPhase = (fly.wingPhase + dt * (flying ? FLAP_RATE : 6)) % TAU;
    const breathe = Math.sin(fly.wingPhase) * 0.03;
    for (const wing of fly.parts.wings) {
      wing.fold = damp(wing.fold, airborne ? 0 : 1, 12, dt);
      const lift = airborne ? 0.85 * Math.sin(fly.wingPhase) : breathe;
      const sweep = wing.rest.sweep * wing.fold + (airborne ? 0.22 : 0);
      wing.hinge.rotation.y = wing.side * sweep;
      wing.hinge.rotation.z = wing.rest.lift * wing.fold + (wing.side < 0 ? -lift : lift);
      wing.mesh.material.opacity = 0.52 + (airborne ? 0.1 : 0);
    }

    // Legs: a tripod gait while walking, a settled stance otherwise. The phase carries
    // between steps, so no foot ever teleports back to the start of a cycle.
    if (fly.mode === "walk") {
      for (const leg of fly.parts.legs) {
        const swing = Math.sin(fly.legPhase + leg.offset);
        const stance = Math.max(0, -Math.cos(fly.legPhase + leg.offset));
        leg.hip.rotation.x = leg.rest.fore + swing * 0.42;
        leg.knee.rotation.x = stance * 0.5;
      }
    } else if (fly.mode !== "groom") {
      for (const leg of fly.parts.legs) {
        leg.hip.rotation.x = damp(leg.hip.rotation.x, leg.rest.fore, 10, dt);
        leg.knee.rotation.x = damp(leg.knee.rotation.x, 0, 10, dt);
      }
    }

    // Heading and body attitude: turn toward the direction of travel at a limited rate;
    // in flight, pitch with the climb and bank into the turn.
    if (flying) {
      const horizontal = Math.hypot(fly.velocity.x, fly.velocity.z);
      if (horizontal > 0.2) {
        const wanted = Math.atan2(fly.velocity.x, fly.velocity.z);
        const turn = angleDelta(fly.heading, wanted);
        fly.heading += turn * Math.min(1, dt * 7);
        fly.turnRate = damp(fly.turnRate, turn, 8, dt);
      }
      const pitch = clamp(-fly.velocity.y * 0.09, -0.42, 0.42);
      const bank = clamp(-fly.turnRate * 0.6, -0.5, 0.5);
      fly.parts.body.rotation.x = damp(fly.parts.body.rotation.x, pitch, 8, dt);
      fly.parts.body.rotation.z = damp(fly.parts.body.rotation.z, bank, 8, dt);
      fly.bobPhase += dt * 18;
      fly.parts.body.position.y = LEG_REACH + Math.sin(fly.bobPhase) * 0.02;
    } else {
      fly.parts.body.rotation.x = damp(fly.parts.body.rotation.x, 0, 10, dt);
      fly.parts.body.rotation.z = damp(fly.parts.body.rotation.z, 0, 10, dt);
      fly.bobPhase = 0;
      if (fly.mode === "takeoff") {
        // The crouch owns the body height until the wings take over.
      } else {
        const idle = Math.sin(time * 1.7 + fly.id) * 0.006;
        fly.parts.body.position.y = LEG_REACH + idle;
        if (fly.mode === "eat")
          fly.parts.proboscis.scale.y = Math.max(fly.parts.proboscis.scale.y, 0.45);
        else if (fly.mode !== "groom")
          fly.parts.proboscis.scale.y = damp(fly.parts.proboscis.scale.y, 0.3, 8, dt);
      }
    }
    fly.group.rotation.y = fly.heading;
    if (!airborne && fly.mode !== "takeoff")
      position.y = damp(position.y, supportHeight(position.x, position.z), 14, dt);
  }

  function update(dt, time, ctx = {}) {
    for (const fly of flies) stepFly(fly, dt, time, ctx);
  }

  function dispose() {
    for (const fly of flies) {
      scene.remove(fly.group);
      fly.group.traverse((object) => {
        if (object.isMesh) {
          object.geometry.dispose();
          if (Array.isArray(object.material)) object.material.forEach((m) => m.dispose());
          else object.material.dispose();
        }
      });
    }
    flies.length = 0;
  }

  for (const fly of flies) scene.add(fly.group);

  return { flies, update, dispose, stats };
}
