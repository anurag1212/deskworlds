import { qualityName, frameRate } from '../../shared/render-policy.js';
import { installControls, reportSceneError, preferredQuality } from '../../shared/controls.js';
import * as THREE from "three";
import { createEnvironment, createMotes } from "./environment.js";
import { createFlies } from "./fly.js";
import { createFood } from "./food.js";
import { createBrain } from "./brain.js";
import { createConnectomeBrain, loadPack } from "./connectome.js";
import { createBrainView } from "./brainview.js";
import { loadFlybodyPack, createFlybodyRigFactory } from "./flybody.js";
import { clamp, randomGenerator } from "./math.js";
import { createFrameLoop } from "../../shared/frame-loop.js";
import { renderSettings, framebufferSize } from "./render-policy.js";
import { createComposite } from "./composite.js";

const canvas = document.querySelector("#scene");
const stage = document.querySelector("#stage");
const loading = document.querySelector("#loading");
// A page that says the host owns its motion leaves the system's reduced-motion
// preference to the host, which is the only one that can offer a way back: the wallpaper
// sits at the desktop window level and never sees a key, so a preview's Space would never
// reach it and the desk would be frozen for good. The preview keeps the preference
// itself, where Space can clear it.
let paused =
  document.documentElement.dataset.motion !== "host" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;
const query = new URLSearchParams(location.search);
const wallpaper = document.documentElement.dataset.motion === "host";
let profile = query.get("quality") === "reference" ? "reference" : preferredQuality(query);
if (query.get("still") === "1") paused = true;
let onBattery = false;
let settings = renderSettings({ profile, wallpaper, pixelRatio: devicePixelRatio });
let requestedRate = wallpaper ? 0 : 60;
let loop = null, applyPower = null, updateControls = () => {};

window.scenePause = (value) => { paused = Boolean(value); loop?.setPaused(paused); updateControls(); };
window.sceneRate = (fps) => {
  requestedRate = Number.isFinite(fps) && fps > 0 ? Math.min(120, fps) : 0;
  loop?.setRate(frameRate(profile, requestedRate, onBattery));
  updateControls();
};
window.scenePower = (battery) => {
  const next = Boolean(battery);
  if (next === onBattery) return;
  onBattery = next;
  settings = renderSettings({ profile, wallpaper, pixelRatio: devicePixelRatio, onBattery });
  applyPower?.();
  loop?.setRate(frameRate(profile, requestedRate, onBattery));
  updateControls();
};
// A pinch of sugar, for a host with no pointer to click with. Defined before the scene
// exists and harmless until it does. Nothing is dropped while the desk is still: sugar
// nobody is drawing is sugar the flies never smell, and it would all arrive at once
// whenever the world started again.
let sprinkle = null;
// The live brain HUD, for the wallpaper's menu as well as the preview's
// button: the host calls sceneBrain(true/false) before or after the pack
// loads, so the intent is kept and applied when the view is ready. It is on
// by default; ?brain=0 or B turns it off.
let brainWanted = query.get("brain") !== "0";
let brainView = null;
let setBrainVisible = (on) => {
  brainWanted = Boolean(on);
  brainView?.setVisible(brainWanted);
  document.querySelector("#brain")?.setAttribute("aria-pressed", String(brainWanted));
};
window.sceneBrain = setBrainVisible;
window.sceneFeed = () => {
  if (sprinkle && loop?.state.running) sprinkle();
};

async function start() {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: settings.powerPreference,
  });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.18;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#161009");
  // A warm haze thickens toward the back wall, so the window glows through the room
  // while the near desk keeps its contrast.
  scene.fog = new THREE.FogExp2("#1c130c", 0.022);
  const camera = new THREE.PerspectiveCamera(32, 1420 / 740, 0.2, 70);
  camera.position.set(-0.3, 5.0, 13.4);
  camera.lookAt(-0.3, 2.3, -0.9);
  // A close-up rig for tuning the fly and props: ?zoom=1 rides the camera
  // behind the fly so screenshots can judge detail at fly scale.
  const zoomMode = query.get("zoom") === "1";
  if (zoomMode) {
    camera.position.set(0.6, 1.15, 3.4);
    camera.lookAt(0.6, 0.35, 0.4);
    camera.fov = 30;
    camera.updateProjectionMatrix();
  }

  // Dusk indoors: a dim sky and a weak bounce, plus the window's low sun as the key.
  // The lower bound of the hemisphere sits almost black so the desk falls away into
  // shadow at the frame's edges.
  scene.add(new THREE.HemisphereLight(0x8d7c66, 0x1c130d, 0.46));
  const key = new THREE.DirectionalLight(0xffcf9e, 2.7);
  key.position.set(-7.5, 10, -1.4);
  key.target.position.set(1.6, 0, 1.2);
  key.castShadow = true;
  key.shadow.mapSize.set(settings.shadowSize, settings.shadowSize);
  Object.assign(key.shadow.camera, {
    left: -17,
    right: 17,
    top: 12,
    bottom: -8,
    near: 1,
    far: 32,
  });
  key.shadow.bias = -0.00012;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3 * settings.shadowSize / 4096;
  scene.add(key, key.target);
  const fill = new THREE.DirectionalLight(0x5d6f85, 0.55);
  fill.position.set(7, 5, 9);
  scene.add(fill);
  const bounce = new THREE.DirectionalLight(0xc4a276, 0.45);
  bounce.position.set(4, 2, 12);
  scene.add(bounce);

  // A small HDR environment: dark room with one warm window strip. Glossy
  // chitin, ceramic and book cloth pick it up as soft reflections.
  const envScene = new THREE.Scene();
  envScene.background = new THREE.Color("#17110b");
  const strip = new THREE.Mesh(
    new THREE.PlaneGeometry(11, 6),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.4, 1.8, 1.15),
      side: THREE.DoubleSide,
    }),
  );
  strip.position.set(-6, 5, -8.2);
  envScene.add(strip);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(envScene, 0.04, 0.1, 40).texture;
  scene.environmentIntensity = 0.5;
  pmrem.dispose();
  strip.geometry.dispose();
  strip.material.dispose();

  const environment = createEnvironment(scene);
  const motes = createMotes(scene);
  const food = createFood(scene, { supportHeight: environment.supportHeight });
  // The anatomical fly meshes (FlyBody, Apache-2.0, packed by
  // tools/fetch_flybody_pack.py). A clone without the pack keeps the
  // procedural anatomy: nothing here may assume the fetch succeeds.
  const flybodyPack = await loadFlybodyPack(
    new URL("../data-flybody", import.meta.url).href,
  ).catch((error) => {
    console.warn("flyscape: flybody pack missing, procedural flies;", error.message);
    return null;
  });
  const bodyFactory = flybodyPack ? createFlybodyRigFactory(flybodyPack) : null;
  let brain = createBrain({ seed: 20261016 });
  // The connectome engine upgrades the placeholder once its pack loads. A fresh
  // clone without generated data keeps the scripted circuit: nothing here may
  // assume the fetch succeeds.
  loadPack(new URL("../data", import.meta.url).href).then(
    (pack) => {
      brain = createConnectomeBrain(pack, { flies: flies.flies.length });
      const hud = document.querySelector("#brain-hud");
      const toggle = document.querySelector("#brain");
      if (hud) {
        brainView = createBrainView(hud, pack, brain, { flock: flies });
        if (toggle) {
          toggle.disabled = false;
          toggle.addEventListener("click", () => setBrainVisible(!brainView.visible));
        }
        document.addEventListener("keydown", (event) => {
          if (event.repeat || event.target.closest("button,select,input,textarea,a,[contenteditable]")) return;
          if (event.key.toLowerCase() === "b") setBrainVisible(!brainView.visible);
        });
        // The wallpaper host may have asked before the pack landed.
        setBrainVisible(brainWanted);
      }
    },
    (error) => console.warn("flyscape: connectome pack missing, placeholder brain;", error.message),
  );
  const flies = createFlies(scene, {
    obstacles: environment.obstacles,
    landmarks: environment.landmarks,
    bounds: environment.bounds,
    supportHeight: environment.supportHeight,
    surfaceAt: environment.surfaceAt,
    seed: 43107,
    bodyFactory,
  });

  const { target, post, postScene, postCamera } = createComposite(camera, settings);

  // The world reacts to the cursor the way a fly reacts to a hand: a slow approach is
  // something to keep an eye on, a fast one is a loom. The pointer is projected onto a
  // plane just above the desk, so its speed is in world units the circuit can read.
  let pointer = null, lastPointerTime = 0;
  const pointerPosition = new THREE.Vector3();
  const pointerSample = new THREE.Vector3();
  const raycaster = new THREE.Raycaster();
  const worldPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -0.5);
  canvas.addEventListener("pointermove", (event) => {
    const bounds = canvas.getBoundingClientRect();
    const normalized = new THREE.Vector2(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(normalized, camera);
    if (raycaster.ray.intersectPlane(worldPlane, pointerPosition)) {
      const now = performance.now();
      if (pointer) {
        const seconds = Math.max(0.004, (now - lastPointerTime) / 1000);
        pointerSample.subVectors(pointerPosition, pointer.position).divideScalar(seconds);
        // The circuit reads a smoothed speed: one jittery sample must not fire a loom.
        pointer.velocity.lerp(pointerSample, 0.5);
        pointer.position.copy(pointerPosition);
      } else
        pointer = { position: pointerPosition.clone(), velocity: new THREE.Vector3() };
      lastPointerTime = now;
    }
  });
  canvas.addEventListener("pointerleave", () => { pointer = null; });

  // A click on the desk drops one cube of sugar where it landed. The ray is cast again
  // rather than reusing the hovering pointer, because a touch presses before it moves.
  const dropPoint = new THREE.Vector3();
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !event.isPrimary || !loop?.state.running) return;
    const bounds = canvas.getBoundingClientRect();
    raycaster.setFromCamera(
      new THREE.Vector2(
        ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
        (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
      ),
      camera,
    );
    if (raycaster.ray.intersectPlane(worldPlane, dropPoint)) {
      // Keep a click's sugar inside the room: a cube outside the walking bounds would
      // draw flies to a spot they can never actually reach.
      dropPoint.x = clamp(dropPoint.x, environment.bounds.minX + 0.4, environment.bounds.maxX - 0.4);
      dropPoint.z = clamp(dropPoint.z, environment.bounds.minZ + 0.4, environment.bounds.maxZ - 0.4);
      food.drop(dropPoint);
    }
  });
  // The same pinch without a click, for the wallpaper's menu: the cursor is up in the
  // menu bar at that moment, so a scatter goes over the open desk instead.
  const scatter = randomGenerator(9973);
  sprinkle = () => {
    for (let i = 0; i < 4; i++)
      food.drop(dropPoint.set(-7 + scatter() * 14, 0, -3.5 + scatter() * 5.5));
  };

  updateControls = installControls({
    stage, isPaused: () => paused,
    isRunning: () => Boolean(loop?.state.running),
    pause: window.scenePause, feed: window.sceneFeed,
    quality: () => profile === 'reference' ? 'detail' : profile,
    setQuality(value) {
      profile = qualityName(value);
      loop?.setRate(frameRate(profile, requestedRate, onBattery));
      resize();
      updateControls();
    },
  });

  let contextLost = false, zeroSize = false, forceShadows = true;
  const maxDimension = Math.min(
    renderer.capabilities.maxTextureSize,
    renderer.getContext().getParameter(renderer.getContext().MAX_RENDERBUFFER_SIZE),
  );
  function visibility() {
    loop?.setHidden(document.hidden || contextLost || zeroSize);
    updateControls();
  }
  function resize() {
    const bounds = canvas.getBoundingClientRect();
    settings = renderSettings({ profile, wallpaper, pixelRatio: devicePixelRatio, onBattery });
    const dimensions = framebufferSize(
      bounds.width, bounds.height, settings.resolution, maxDimension, settings.maxPixels,
    );
    zeroSize = !dimensions;
    visibility();
    if (!dimensions) return;
    const { width, height, scale } = dimensions;
    if (target.width !== width || target.height !== height) {
      renderer.setSize(width, height, false);
      target.setSize(width, height);
      post.uniforms.size.value.set(width, height);
      // Preserve the depth effect's screen-space radius as resolution changes.
      post.uniforms.aoRadiusScale.value = scale / settings.referenceResolution;
      camera.aspect = bounds.width / bounds.height;
      camera.updateProjectionMatrix();
      forceShadows = true;
      loop?.invalidate();
    }
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(stage);
  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", visibility);
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    contextLost = true;
    visibility();
  });
  canvas.addEventListener("webglcontextrestored", () => location.reload());
  applyPower = () => { forceShadows = true; resize(); };
  resize();

  // Mesh transforms are static; the flies compose their own matrices, the dust moves in
  // its buffer. Everything else can skip the per-frame matrix pass.
  scene.traverse((object) => { object.updateMatrix(); object.matrixAutoUpdate = false; });
  for (const fly of flies.flies)
    fly.group.traverse((object) => { object.matrixAutoUpdate = true; });
  scene.updateMatrixWorld(true);

  let time = 0, lastShadowTime = -Infinity, renderedFrames = 0, shadowFrames = 0;
  let ready = false;
  let lastDrives = [];

  // The bridge between the world and the brain seam. The seam gets one drive record per
  // fly, two feedback events (fed, landed) the way ascending neurons would, and the
  // pieces of sugar in reach. Swap `brain.js` for the connectome engine and this stays.
  const bodies = [];
  for (let i = 0; i < flies.flies.length; i++) bodies.push({ position: flies.flies[i].group.position });
  const onEvent = (fly, event) => brain.notify(fly.id, event);

  function renderFrame(dt, now) {
    // Short substeps keep walking and feeding stable at 20/30 fps without slowing the
    // simulation down. Equal steps, rounded to the nearest 60 Hz count.
    const total = Math.min(0.1, dt);
    const steps = Math.max(1, Math.round(total * 60));
    const step = total / steps;
    for (let i = 0; total > 0 && i < steps; i++) {
      time += step;
      const drives = brain.update(step, {
        time,
        pointer,
        food: food.available(),
        bodies,
      });
      flies.update(step, time, { drives, food, pointer, onEvent });
      lastDrives = drives;
      food.update(step);
      motes.update(step);
    }
    if (pointer && now - lastPointerTime > 60)
      pointer.velocity.multiplyScalar(Math.exp(-dt * 12));
    // The tuning camera rides the fly: close enough to judge chitin, wings and
    // leg motion, always keeping it in frame.
    if (zoomMode) {
      const fly = flies.flies[0].group.position;
      camera.position.set(fly.x + 1.3, fly.y + 0.75, fly.z + 1.9);
      camera.lookAt(fly.x, fly.y + 0.05, fly.z);
    }
    const refreshShadow = forceShadows || time - lastShadowTime + 1e-7 >= 1 / settings.shadowHz;
    renderer.shadowMap.needsUpdate = refreshShadow;
    if (refreshShadow) {
      lastShadowTime = time;
      forceShadows = false;
      shadowFrames++;
    }
    renderer.info.reset();
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
    renderedFrames++;
    if (brainView?.visible) {
      brainView.draw(dt);
      // Rate readouts need only follow behavior, not spikes: ten a second is plenty.
      if (renderedFrames % 6 === 0) brainView.refreshRates(lastDrives);
    }
    if (!ready) {
      ready = true;
      loading.style.opacity = 0;
      setTimeout(() => { loading.hidden = true; }, 850);
    }
  }
  loop = createFrameLoop(renderFrame, {
    fps: frameRate(profile, requestedRate, onBattery),
    paused,
    hidden: document.hidden || zeroSize || contextLost,
  });
  updateControls();
  window.sceneStats = () => ({
    profile, onBattery, resolution: settings.resolution,
    framebuffer: [target.width, target.height],
    shadowSize: settings.shadowSize,
    shadowHz: Number.isFinite(settings.shadowHz) ? settings.shadowHz : "per-frame",
    renderedFrames, shadowFrames, simulationTime: time,
    drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
    flies: { count: flies.flies.length, ...flies.stats, modes: flies.flies.map((fly) => fly.mode) },
    brain: { mode: brain.mode, ...brain.stats },
    food: { ...food.stats, active: food.available().length },
    dust: motes.stats,
    room: environment.stats,
    loop: loop.state,
  });
  // Diagnostics are opt-in: no timing queries, synchronization or arrays in normal use.
  if (query.get("diagnostics") === "1") {
    const { installDiagnostics } = await import("../../shared/diagnostics.js");
    installDiagnostics({ renderer, loop, renderFrame, stats: window.sceneStats });
  }
  window.addEventListener("pagehide", () => loop.setHidden(true));
  window.addEventListener("pageshow", visibility);
}

start().catch(reportSceneError);
