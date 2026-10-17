// The brain window: a live instrument panel for every fly, always on.
//
// A bottom HUD with one card per fly (one, to begin with). Each card is the
// same three instruments, side by side:
//   * the fly's soma cloud — the full CNS at real positions, spikes flashing
//     where they fire, slowly turning;
//   * an 8-row spike raster of its identified populations;
//   * live rate chips: giant fiber, steering, proboscis, cord tone, whole brain.
//
// 2D canvases, not WebGL: a second context would compete with the scene's.
// Preview and wallpaper share it; B (preview) and the menu's Show Brain toggle.

import { clamp } from "./math.js";

const ROLE_COLORS = {
  lc4: "#7fd4ff", lplc2: "#7fd4ff", gf: "#ffd94d", lc10a: "#b48cff",
  dna01: "#ff9d5c", dna02: "#ff9d5c", dnp09: "#8ce08c", dng11: "#e08cc8",
  mdn: "#8ce0d4", escw: "#ffd94d", sugar: "#ff7d7d", proboscis_mn: "#ff7d7d",
  other: "#3a4a5a",
};
const RASTER_ROWS = [
  { label: "loom", roles: { lc4: "#7fd4ff", lplc2: "#7fd4ff" } },
  { label: "GF", roles: { gf: "#ffd94d" } },
  { label: "vision", roles: { lc10a: "#b48cff" } },
  { label: "steer", roles: { dna01: "#ff9d5c", dna02: "#ff9d5c" } },
  { label: "taste", roles: { sugar: "#ff7d7d" } },
  { label: "feed", roles: { proboscis_mn: "#ff7d7d" } },
  { label: "walk", roles: { dnp09: "#8ce08c", dng11: "#e08cc8", mdn: "#8ce0d4", escw: "#ffd94d" } },
  { label: "motor", roles: null }, // any mn_* role from the cord
];
const CHIPS = [
  ["GF", (d) => d.gfHz],
  ["steer", (d) => d.steerHz],
  ["feed", (d) => d.proboscisHz],
  ["tone", (d) => d.legTone],
  ["brain", (d) => d.popHz],
];

const MODE_WORDS = {
  rest: "resting", walk: "walking", groom: "grooming", fly: "flying",
  takeoff: "taking off", land: "landing", eat: "feeding", flee: "bolting",
};

export function createBrainView(hud, pack, brain, { flock } = {}) {
  const flies = flock?.flies ?? [];
  const labels = flies.length > 1;
  const cards = flies.map((fly) => {
    const card = document.createElement("div");
    card.className = "brain-card";
    const cloud = document.createElement("canvas");
    cloud.width = 280;
    cloud.height = 280;
    const body = document.createElement("div");
    body.className = "brain-card-body";
    const title = document.createElement("div");
    title.className = "brain-card-title";
    const raster = document.createElement("canvas");
    raster.className = "brain-raster";
    raster.width = 620;
    raster.height = 132;
    const chips = document.createElement("div");
    chips.className = "brain-chips";
    body.append(title, raster, chips);
    card.append(cloud, body);
    hud.append(card);
    return {
      fly,
      cloud,
      cloudCtx: cloud.getContext("2d"),
      raster,
      rasterCtx: raster.getContext("2d"),
      chips,
      title,
      glow: new Float32Array(pack.wiring.n),
      glowVnc: pack.vnc ? new Float32Array(pack.vnc.wiring.n) : null,
      angle: Math.random() * Math.PI * 2,
      chipsBuilt: false,
    };
  });
  let visible = false;

  function resize() {
    for (const card of cards) {
      const bounds = card.getBoundingClientRect();
      const size = Math.max(120, Math.round(Math.min(bounds.height, 150) * 1.4));
      card.cloud.width = size;
      card.cloud.height = size;
    }
  }

  function drawGlow(ctx, neurons, buffer, cos, sin, cx, scale, size, step) {
    for (let i = 0; i < buffer.length; i += step) {
      if (buffer[i] <= 0.02) continue;
      const neuron = neurons[i];
      const [x, y, z] = neuron.pos;
      const px = cx + (x * cos - z * sin) * scale;
      const py = cx + y * scale * 0.9 - size * 0.04;
      if (px < 0 || px > size || py < 0 || py > size) { buffer[i] = 0; continue; }
      ctx.fillStyle = ROLE_COLORS[neuron.role] ?? ROLE_COLORS.other;
      ctx.globalAlpha = clamp(buffer[i], 0, 1);
      ctx.beginPath();
      ctx.arc(px, py, neuron.role === "other" ? 1.3 : 2.2, 0, 6.2832);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  function drawCloud(card, dt) {
    const ctx = card.cloudCtx;
    const size = card.cloud.width;
    if (!size) return;
    card.angle += dt * 0.2;
    ctx.fillStyle = "#0a0d12";
    ctx.fillRect(0, 0, size, size);
    const cos = Math.cos(card.angle), sin = Math.sin(card.angle);
    const cx = size / 2, scale = size / 24;
    // Static soma cloud, drawn at half density: it is the wallpaper of the card.
    for (let i = 0; i < pack.cloud.length; i += 2) {
      const [x, y, z, cls] = pack.cloud[i];
      const px = cx + (x * cos - z * sin) * scale;
      const py = cx + y * scale * 0.9 - size * 0.04;
      if (px < 0 || px > size || py < 0 || py > size) continue;
      ctx.fillStyle = cls === 0 ? "rgba(120,150,200,0.35)" : "rgba(90,110,140,0.3)";
      ctx.fillRect(px, py, 1.2, 1.2);
    }
    const index = card.fly.id;
    for (const s of brain.recent(index)) card.glow[s] = 1;
    drawGlow(ctx, pack.neurons, card.glow, cos, sin, cx, scale, size, 1);
    if (card.glowVnc && brain.recentVnc && pack.vnc) {
      for (const s of brain.recentVnc(index)) card.glowVnc[s] = 1;
      drawGlow(ctx, pack.vnc.neurons, card.glowVnc, cos, sin, cx, scale, size, 1);
    }
    for (let i = 0; i < card.glow.length; i++) card.glow[i] *= 0.86;
    if (card.glowVnc) for (let i = 0; i < card.glowVnc.length; i++) card.glowVnc[i] *= 0.86;
  }

  function drawRaster(card) {
    const ctx = card.rasterCtx;
    const w = card.raster.width, h = card.raster.height;
    const rows = RASTER_ROWS.length;
    const rowH = h / rows;
    ctx.globalCompositeOperation = "copy";
    ctx.drawImage(card.raster, -2, 0);
    ctx.globalCompositeOperation = "source-over";
    const index = card.fly.id;
    const plot = (role, vnc) => {
      for (let r = 0; r < rows; r++) {
        const spec = RASTER_ROWS[r];
        const colour = spec.roles
          ? spec.roles[role]
          : (vnc && role.startsWith("mn_") ? "#8ce08c" : null);
        if (!colour) continue;
        ctx.fillStyle = colour;
        ctx.fillRect(w - 2, r * rowH + 1, 2, rowH - 2);
        return;
      }
    };
    for (const s of brain.recent(index)) plot(pack.neurons[s].role, false);
    if (brain.recentVnc && pack.vnc) {
      for (const s of brain.recentVnc(index)) plot(pack.vnc.neurons[s].role, true);
    }
    if (labels) {
      ctx.font = `${Math.round(rowH * 0.6)}px system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      for (let r = 0; r < rows; r++) {
        ctx.fillStyle = "rgba(10,13,18,0.88)";
        ctx.fillRect(0, r * rowH, 46, rowH);
        ctx.fillStyle = "rgba(160,180,205,0.55)";
        ctx.fillText(RASTER_ROWS[r].label, 4, (r + 0.5) * rowH);
        ctx.strokeStyle = "rgba(140,170,210,0.1)";
        ctx.beginPath();
        ctx.moveTo(0, (r + 1) * rowH);
        ctx.lineTo(w, (r + 1) * rowH);
        ctx.stroke();
      }
    }
  }

  function refreshRates(drives) {
    cards.forEach((card, i) => {
      const drive = drives[i];
      if (!drive) return;
      card.title.textContent = `fly ${i + 1} · ${MODE_WORDS[card.fly.mode] ?? card.fly.mode}`;
      if (!card.chipsBuilt) {
        card.chipsBuilt = true;
        card.chipNodes = CHIPS.map(([label]) => {
          const chip = document.createElement("span");
          chip.className = "brain-chip";
          const name = document.createElement("em");
          name.textContent = label;
          const value = document.createElement("b");
          chip.append(name, value);
          card.chips.append(chip);
          return value;
        });
      }
      CHIPS.forEach(([, read], k) => {
        const value = read(drive) ?? 0;
        card.chipNodes[k].textContent = `${value.toFixed(1)}`;
      });
    });
  }

  function draw(dt) {
    for (const card of cards) {
      drawCloud(card, dt);
      drawRaster(card);
    }
  }

  function setVisible(value) {
    visible = value;
    hud.hidden = !value;
    if (value) resize();
  }

  return { draw, refreshRates, setVisible, get visible() { return visible; } };
}
