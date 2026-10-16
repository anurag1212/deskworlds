// The brain window: the soma cloud with live spikes.
//
// A 2D canvas overlay (one extra WebGL context would compete with the scene's):
// all ~23k soma positions from brain_points.json projected in a slow rotation,
// dark until a spike fires, then flashing at the spiking circuit neuron's soma.
// The watched fly's identified populations get live rate readouts; buttons switch
// between the four flies. Preview only: the wallpaper has no chrome to hang it on.

import { clamp } from "./math.js";

const ROLE_COLORS = {
  lc4: "#7fd4ff", lplc2: "#7fd4ff", gf: "#ffd94d", lc10a: "#b48cff",
  dna01: "#ff9d5c", dna02: "#ff9d5c", dnp09: "#8ce08c", dng11: "#e08cc8",
  mdn: "#8ce0d4", escw: "#ffd94d", sugar: "#ff7d7d", proboscis_mn: "#ff7d7d",
  other: "#3a4a5a",
};
export function createBrainView(panel, pack, brain, { flies = 4 } = {}) {
  const canvas = panel.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const readout = panel.querySelector(".brain-rates");
  const switcher = panel.querySelector(".brain-flies");
  const heading = panel.querySelector("h2");
  let watched = 0;
  let visible = false;
  let angle = 0;
  // Per-circuit-neuron glow, decayed every frame: index -> brightness.
  const glow = new Float32Array(pack.wiring.n);
  const buttons = [];
  for (let f = 0; f < flies; f++) {
    const button = document.createElement("button");
    button.textContent = `fly ${f + 1}`;
    button.setAttribute("aria-pressed", String(f === 0));
    button.addEventListener("click", () => {
      watched = f;
      heading.textContent = `fly ${f + 1} · live brain`;
      for (const [i, b] of buttons.entries())
        b.setAttribute("aria-pressed", String(i === f));
    });
    switcher.append(button);
    buttons.push(button);
  }

  function resize() {
    const bounds = panel.getBoundingClientRect();
    const size = Math.min(300, Math.floor(bounds.width));
    canvas.width = size;
    canvas.height = size;
  }

  function draw(dt) {
    angle += dt * 0.25;
    const size = canvas.width;
    if (!size) return;
    ctx.fillStyle = "#0a0d12";
    ctx.fillRect(0, 0, size, size);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const cx = size / 2, scale = size / 24;
    // Soma cloud: dim dots, optic lobe tinted cooler than central brain.
    for (let i = 0; i < pack.cloud.length; i += 2) {
      const [x, y, z, cls] = pack.cloud[i];
      const px = cx + (x * cos - z * sin) * scale;
      const py = cx + y * scale * 0.9 - size * 0.04;
      if (px < 0 || px > size || py < 0 || py > size) continue;
      ctx.fillStyle = cls === 0 ? "rgba(120,150,200,0.4)" : "rgba(90,110,140,0.35)";
      ctx.fillRect(px, py, 1.4, 1.4);
    }
    // Circuit spikes: the watched fly's recent spikes glow at their somas.
    for (const s of brain.recent(watched)) glow[s] = 1;
    const neurons = pack.neurons;
    for (let i = 0; i < glow.length; i++) {
      if (glow[i] <= 0.02) continue;
      const neuron = neurons[i];
      const [x, y, z] = neuron.pos;
      const px = cx + (x * cos - z * sin) * scale;
      const py = cx + y * scale * 0.9 - size * 0.04;
      if (px < 0 || px > size || py < 0 || py > size) { glow[i] = 0; continue; }
      ctx.fillStyle = ROLE_COLORS[neuron.role] ?? ROLE_COLORS.other;
      ctx.globalAlpha = clamp(glow[i], 0, 1);
      const r = neuron.role === "other" ? 1.6 : 2.6;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, 6.2832);
      ctx.fill();
      ctx.globalAlpha = 1;
      glow[i] *= 0.86;
    }
  }

  function refreshRates(drives) {
    const drive = drives[watched];
    if (!drive) return;
    const rows = [
      ["giant fiber", drive.gfHz ?? 0],
      ["loom burst", drive.loomHz ?? 0],
      ["steer R−L", drive.steerHz ?? 0],
      ["proboscis", drive.proboscisHz ?? 0],
      ["brain", drive.popHz ?? 0],
    ];
    readout.replaceChildren(
      ...rows.map(([label, hz]) => {
        const row = document.createElement("div");
        const name = document.createElement("span");
        name.textContent = label;
        const value = document.createElement("span");
        value.textContent = `${hz.toFixed(1)} Hz`;
        const bar = document.createElement("div");
        bar.className = "brain-bar";
        const fill = document.createElement("div");
        fill.style.width = `${clamp(Math.abs(hz) / 2, 0, 100)}%`;
        bar.append(fill);
        row.append(name, value, bar);
        return row;
      }),
    );
  }

  function setVisible(value) {
    visible = value;
    panel.hidden = !value;
    if (value) resize();
  }

  return { draw, refreshRates, setVisible, get visible() { return visible; } };
}
