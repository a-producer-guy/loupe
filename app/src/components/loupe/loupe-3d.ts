// Loupe in 3D, built in the browser from the recipe in Guy's Loupe-3D pack (Loupe-model.js): the
// white body, short brown fur, nub hands, dark feet and the aperture eye. He blinks, turns to
// follow the pointer, opens and spins his iris, smiles with a hop, squirms when tickled and holds
// his department's prop. His scissors snip while he works, and on the landing page he plays with
// them (snips, twirls, juggles, a risky double toss, a haircut). Loaded only on big stages (landing,
// sign-in, New scene); the 2D drawing shows until this has drawn its first frame, and comes back if
// WebGL fails.

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { LoupeDept, LoupeMood } from "./loupe";

const C = 1.21;
const U = 1 / 18.5;
const DEPT_COLOR: Record<LoupeDept, string> = { edit: "#E2452B", sound: "#3D7BE0", color: "#2E9E6B", preview: "#8A8A84" };
const reduceMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const mat = (color: string, roughness: number, metalness = 0, other: THREE.MeshPhysicalMaterialParameters = {}) =>
  new THREE.MeshPhysicalMaterial({ color, roughness, metalness, ...other });

/* ---- fur, with the strand count as a dial (smaller Loupes get less) ---- */
const furCache = new Map<number, THREE.Group>();
function makeFur(count: number): THREE.Group {
  const cached = furCache.get(count);
  if (cached) return cached.clone(true);
  const hair = new THREE.Group();
  let seed = 514803;
  const rand = () => {
    seed = (1664525 * seed + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const covered = (p: THREE.Vector3) => !(p.z > 0.04 && (p.x / 0.86) ** 2 + ((p.y + 0.075) / 0.91) ** 2 < 1);
  const capPos: number[] = [];
  const capIdx: number[] = [];
  const rings = 48;
  const sides = 80;
  for (let j = 0; j <= rings; j++) {
    const lat = Math.PI * (1 - j / rings);
    const y = Math.cos(lat);
    const r = Math.sin(lat);
    const th = 0.86 * Math.sqrt(Math.max(0, 1 - ((y + 0.075) / 0.91) ** 2));
    const cut = r > 1e-5 ? Math.asin(Math.min(1, th / r)) : 0;
    for (let k = 0; k <= sides; k++) {
      const a = cut + ((Math.PI * 2 - 2 * cut) * k) / sides;
      capPos.push(r * Math.sin(a), y, r * Math.cos(a));
      if (j < rings && k < sides) {
        const q = j * (sides + 1) + k;
        const b = q + sides + 1;
        capIdx.push(q, q + 1, b, q + 1, b + 1, b);
      }
    }
  }
  const capGeo = new THREE.BufferGeometry();
  capGeo.setAttribute("position", new THREE.Float32BufferAttribute(capPos, 3));
  capGeo.setIndex(capIdx);
  capGeo.computeVertexNormals();
  const cap = new THREE.Mesh(capGeo, mat("#4C3525", 1));
  cap.position.y = C;
  cap.scale.set(1.008, 1.008, 0.786);
  hair.add(cap);

  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const pal = ["#4D3627", "#61432D", "#6C4B32", "#755338", "#805B3D"].map((c) => new THREE.Color(c));
  const tmp = new THREE.Vector3();
  const thick = Math.pow(36000 / count, 0.42);
  const strand = (root: THREE.Vector3, thickness: number, length: number, v: number) => {
    const n = new THREE.Vector3(root.x, root.y, root.z / 0.78).normalize();
    const p = new THREE.Vector3(root.x, C + root.y, root.z * 0.78).addScaledVector(n, 0.008);
    const helper = Math.abs(n.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const ta = new THREE.Vector3().crossVectors(n, helper).normalize();
    const tb = new THREE.Vector3().crossVectors(n, ta).normalize();
    const ang = rand() * Math.PI * 2;
    const comb = ta.clone().multiplyScalar(Math.cos(ang)).addScaledVector(tb, Math.sin(ang));
    const color = pal[Math.floor(rand() * pal.length)];
    const bend = 0.2 + v * 0.45;
    const sec = 3;
    const sd = 3;
    const start = pos.length / 3;
    for (let j = 0; j <= sec; j++) {
      const t = j / sec;
      const c = p.clone().addScaledVector(n, length * t * (1 - 0.12 * t)).addScaledVector(comb, length * bend * t * t);
      const tan = n.clone().multiplyScalar(length * (1 - 0.24 * t)).addScaledVector(comb, 2 * length * bend * t).normalize();
      const across = new THREE.Vector3().crossVectors(tan, comb).normalize();
      const round = new THREE.Vector3().crossVectors(across, tan).normalize();
      const rad = thickness * (0.04 + 0.96 * Math.pow(1 - t, 0.85));
      const tone = 0.58 + 0.42 * t;
      for (let k = 0; k < sd; k++) {
        const a = (k / sd) * Math.PI * 2;
        tmp.copy(across).multiplyScalar(Math.cos(a)).addScaledVector(round, Math.sin(a));
        pos.push(c.x + tmp.x * rad, c.y + tmp.y * rad, c.z + tmp.z * rad);
        nor.push(tmp.x, tmp.y, tmp.z);
        col.push(color.r * tone, color.g * tone, color.b * tone);
      }
      if (j < sec)
        for (let k = 0; k < sd; k++) {
          const a = start + j * sd + k;
          const b = start + j * sd + ((k + 1) % sd);
          idx.push(a, a + sd, b, b, a + sd, b + sd);
        }
    }
  };
  for (let i = 0; i < count; i++) {
    const y = rand() * 2 - 1;
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(1 - y * y);
    const root = new THREE.Vector3(r * Math.cos(a), y, r * Math.sin(a));
    if (!covered(root)) continue;
    const v = rand();
    const guard = rand() < 0.07;
    strand(root, (0.0016 + rand() * 0.002) * thick, guard ? 0.075 + rand() * 0.035 : 0.035 + rand() * 0.035, v);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  hair.add(new THREE.Mesh(g, new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.97, sheen: 0.26, sheenColor: "#805A36", sheenRoughness: 1 })));
  furCache.set(count, hair);
  return hair.clone(true);
}

type Parts = {
  root: THREE.Group;
  body: THREE.Group;
  lid: THREE.Group;
  aperture: THREE.Group;
  buildAperture: (scale: number) => void;
  pupil: THREE.Mesh;
  pupilMat: THREE.MeshPhysicalMaterial;
  smile: THREE.Group;
  hands: Record<-1 | 1, THREE.Mesh>;
  props: Partial<Record<LoupeDept, THREE.Group>>;
  /** The scissors: tossed and spun as a whole, each half opening on the pivot. */
  scissors: { toss: THREE.Group; halves: Record<-1 | 1, THREE.Group> };
};

function buildLoupe(furCount: number): Parts {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const white = mat("#FFFFFF", 0.29, 0, { clearcoat: 0.2, clearcoatRoughness: 0.28 });
  const ink = mat("#161614", 0.53);
  const rim = mat("#161614", 0.32, 0.12, { clearcoat: 0.25 });
  const irisMat = mat("#FFF2EA", 0.32);
  const seamMat = mat("#4A4A45", 0.5, 0.05);
  const bladeMats = [mat("#242422", 0.32, 0.3), mat("#20201E", 0.32, 0.3)];
  const pupilMat = mat("#E2452B", 0.36, 0, { clearcoat: 0.2, emissive: "#E2452B", emissiveIntensity: 0.05 });
  const metal = mat("#C9C9C3", 0.22, 0.85);
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, xyz: [number, number, number] = [0, 0, 0], scale?: [number, number, number]) => {
    const o = new THREE.Mesh(geo, m);
    o.position.set(...xyz);
    if (scale) o.scale.set(...scale);
    parent.add(o);
    return o;
  };
  const sphere = new THREE.SphereGeometry(1, 48, 32);
  add(sphere, white, body, [0, C, 0], [1, 1, 0.78]);
  if (furCount) body.add(makeFur(furCount));
  for (const s of [-1, 1]) add(sphere, ink, root, [s * 6 * U, 0.124, 0.03], [4.2 * U, 2.3 * U, 0.3]);
  const hands = {} as Record<-1 | 1, THREE.Mesh>;
  for (const s of [-1, 1] as const) {
    const h = add(sphere, white, body, [s * 0.87, C - 0.43, 0.53], [0.29, 0.145, 0.18]);
    h.rotation.z = -s * 0.2;
    hands[s] = h;
  }
  const eye = new THREE.Group();
  eye.position.y = C;
  body.add(eye);
  const prof = [[0, 0.53], [0.57, 0.53], [0.611, 0.58], [0.626, 0.68], [0.626, 0.78], [0.622, 0.815], [0.611, 0.835], [0.592, 0.84], [0.58, 0.828], [0.58, 0.795], [0, 0.795]].map(([x, y]) => new THREE.Vector2(x, y));
  add(new THREE.LatheGeometry(prof, 96), rim, eye).rotation.x = Math.PI / 2;
  const lid = new THREE.Group();
  eye.add(lid);
  add(new THREE.CylinderGeometry(0.594, 0.594, 0.026, 96), mat("#161614", 0.24, 0.12, { clearcoat: 0.5 }), lid, [0, 0, 0.811]).rotation.x = Math.PI / 2;
  const aperture = new THREE.Group();
  lid.add(aperture);
  const buildAperture = (scale: number) => {
    for (const o of [...aperture.children]) {
      aperture.remove(o);
      (o as THREE.Mesh).geometry?.dispose();
    }
    const radius = 5.4 * U * scale;
    const outer = 0.582;
    const verts: THREE.Vector2[] = [];
    const ends: THREE.Vector2[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const p = new THREE.Vector2(Math.cos(a) * radius, Math.sin(a) * radius);
      const d = new THREE.Vector2(Math.cos(a + Math.PI / 3), Math.sin(a + Math.PI / 3));
      const pd = p.dot(d);
      const t = -pd + Math.sqrt(pd * pd + outer * outer - p.lengthSq());
      verts.push(p);
      ends.push(p.clone().addScaledVector(d, t));
    }
    const op = new THREE.Shape();
    op.moveTo(verts[0].x, verts[0].y);
    for (const p of verts.slice(1)) op.lineTo(p.x, p.y);
    op.closePath();
    add(new THREE.ShapeGeometry(op), irisMat, aperture, [0, 0, 0.83]);
    for (let i = 0; i < 6; i++) {
      const nx = (i + 1) % 6;
      const sh = new THREE.Shape();
      sh.moveTo(verts[i].x, verts[i].y);
      sh.lineTo(ends[i].x, ends[i].y);
      const a = Math.atan2(ends[i].y, ends[i].x);
      sh.absarc(0, 0, outer, a, a + Math.PI / 3, false);
      sh.lineTo(verts[nx].x, verts[nx].y);
      sh.closePath();
      add(new THREE.ExtrudeGeometry(sh, { depth: 0.011, bevelEnabled: false, curveSegments: 12 }), bladeMats[i % 2], aperture, [0, 0, 0.839]);
      add(
        new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(verts[i].x, verts[i].y, 0.854), new THREE.Vector3(ends[i].x, ends[i].y, 0.854)), 1, 0.009, 6, false),
        seamMat,
        aperture,
      );
    }
  };
  buildAperture(1);
  const pupil = add(sphere, pupilMat, lid, [0, 0, 0.865], [1.8 * U, 1.8 * U, 0.032]);
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 32; i++) {
    const t = i / 32;
    pts.push(new THREE.Vector3((-5 + 10 * t) * U, (-1.4 * (1 - t) * (1 - t) + 10 * t * (1 - t) - 1.4 * t * t) * -U, 0.856));
  }
  const smile = new THREE.Group();
  lid.add(smile);
  add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, 1.15 * U, 10, false), irisMat, smile);
  for (const p of [pts[0], pts[pts.length - 1]]) add(sphere, irisMat, smile, p.toArray() as [number, number, number], [1.15 * U, 1.15 * U, 1.15 * U]);
  smile.visible = false;
  add(sphere, mat("#FFFFFF", 0.16, 0, { transparent: true, opacity: 0.38, depthWrite: false }), lid, [-4.2 * U, 4.4 * U, 0.889], [1.7 * U, 1.7 * U, 0.007]);

  // Props: each sits in its own pivot so it pops and wiggles in place.
  const props: Parts["props"] = {};
  const sound = new THREE.Group();
  props.sound = sound;
  body.add(sound);
  add(new THREE.TorusGeometry(1.1, 0.06, 12, 64, Math.PI), ink, sound, [0, C + 0.02, -0.04]);
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.22, 0.22, 0.18, 32), ink, sound, [s * 1.08, C, -0.02]).rotation.z = Math.PI / 2;
    add(new THREE.CylinderGeometry(0.15, 0.15, 0.03, 32), mat("#3D7BE0", 0.5), sound, [s * 1.18, C, -0.02]).rotation.z = Math.PI / 2;
  }
  const edit = new THREE.Group();
  props.edit = edit;
  body.add(edit);
  edit.position.set(1.16, C - 0.2, 0.72);
  const toss = new THREE.Group();
  edit.add(toss);
  const sc = new THREE.Group();
  toss.add(sc);
  sc.rotation.set(0.15, -0.35, -0.55);
  sc.scale.setScalar(1.75);
  const blade = new THREE.Shape();
  blade.moveTo(-0.024, 0);
  blade.lineTo(0.024, 0);
  blade.lineTo(0.005, 0.42);
  blade.lineTo(-0.005, 0.42);
  blade.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(blade, { depth: 0.016, bevelEnabled: false });
  const ringMat = mat("#E2452B", 0.4);
  const halves = {} as Record<-1 | 1, THREE.Group>;
  for (const s of [-1, 1] as const) {
    // One half of the scissors: a blade above the pivot and the ring for it below, on the other side.
    const half = new THREE.Group();
    half.position.set(0, -0.06, 0);
    sc.add(half);
    halves[s] = half;
    add(bladeGeo, metal, half, [0, 0, s * 0.009]).rotation.z = s * 0.22;
    add(new THREE.TorusGeometry(0.078, 0.026, 10, 28), ringMat, half, [s * 0.085, -0.14, 0]);
  }
  add(sphere, ink, sc, [0, -0.06, 0.022], [0.024, 0.024, 0.024]);
  const color = new THREE.Group();
  props.color = color;
  body.add(color);
  color.position.set(1.1, C - 0.26, 0.66);
  const brush = new THREE.Group();
  color.add(brush);
  brush.rotation.set(0.1, 0, -0.55);
  brush.scale.setScalar(1.45);
  add(new THREE.CylinderGeometry(0.036, 0.046, 0.62, 16), ink, brush);
  add(new THREE.CylinderGeometry(0.052, 0.052, 0.1, 16), metal, brush, [0, 0.36, 0]);
  add(sphere, mat("#2E9E6B", 0.45), brush, [0, 0.47, 0], [0.058, 0.13, 0.058]);
  for (const p of Object.values(props)) {
    p.visible = false;
    p.userData.pop = 0;
  }
  return { root, body, lid, aperture, buildAperture, pupil, pupilMat, smile, hands, props, scissors: { toss, halves } };
}

/* ---- one shared animation loop for every 3D Loupe on the page ---- */
const views = new Set<LoupeView>();
const pointer = { x: 0, y: 0, t: 0 };
let looping = false;
let last = 0;
function loop(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const view of views) view.frame(now, dt);
  if (views.size) requestAnimationFrame(loop);
  else looping = false;
}
function track(event: PointerEvent) {
  pointer.x = event.clientX;
  pointer.y = event.clientY;
  pointer.t = performance.now();
}

/* ---- scissor tricks: what Loupe gets up to with his scissors on the landing page ---- */
export type Trick = "snip" | "twirl" | "juggle" | "double" | "haircut";
const TRICK_MS: Record<Trick, number> = { snip: 900, twirl: 1100, juggle: 1500, double: 2400, haircut: 1700 };
// How often each comes up when he's idle (the double is the risky one: rarer).
const TRICK_ODDS: [Trick, number][] = [
  ["juggle", 0.3],
  ["twirl", 0.25],
  ["snip", 0.2],
  ["haircut", 0.13],
  ["double", 0.12],
];
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const bump = (t: number, at: number, w: number) => Math.exp(-Math.pow((t - at) / w, 2));
/** The blades over one snip (0 to 1): a quick close, a slower open. Rest is 0, shut is -0.21. */
const snipAt = (p: number) => (p < 0.3 ? 0.15 - (0.36 * p) / 0.3 : -0.21 + (0.36 * (p - 0.3)) / 0.7);

class LoupeView {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private L: Parts;
  private ap = 1;
  private apTarget = 1;
  private spin = 0;
  private yaw = 0;
  private pitch = 0;
  private hop = -1;
  private blinkAt = performance.now() + 1500 + Math.random() * 3000;
  private mood: LoupeMood = "idle";
  private dept: LoupeDept | undefined;
  private tickle = 0;
  private tickling = false;
  private drawn = false;
  private trick: { name: Trick; at: number } | null = null;
  private lastTrick: Trick | null = null;
  private nextTrick = performance.now() + 2500 + Math.random() * 3000;
  private grinUntil = 0;
  private squint = 1;
  playful = false;
  dead = false;

  constructor(
    private host: HTMLElement,
    size: number,
    private onDrawn: () => void,
  ) {
    const w = size;
    const h = Math.round(size * 1.1);
    const k = 1.8;
    const cw = Math.round(w * k);
    const ch = Math.round(h * k);
    const canvas = document.createElement("canvas");
    canvas.className = "loupe-canvas";
    Object.assign(canvas.style, { width: `${cw}px`, height: `${ch}px`, left: `${-(cw - w) / 2}px`, top: `${-(ch - h) / 2 - h * 0.06}px` });
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(cw, ch, false);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.scene.environment = new THREE.PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    const key = new THREE.DirectionalLight("#ffffff", 1.4);
    key.position.set(-3, 5, 6);
    this.scene.add(key, new THREE.HemisphereLight("#ffffff", "#d8d4cc", 0.5));
    this.camera = new THREE.PerspectiveCamera(24, cw / ch, 0.1, 50);
    this.camera.position.set(0, 1.75, 10.6);
    this.camera.lookAt(0, 1.12, 0);
    this.L = buildLoupe(size >= 150 ? 16000 : size >= 60 ? 9000 : 4000);
    this.scene.add(this.L.root);
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.05, 40), new THREE.MeshBasicMaterial({ color: "#000", transparent: true, opacity: 0.1, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.005;
    shadow.scale.set(1, 0.55, 1);
    this.scene.add(shadow);
    host.prepend(canvas);
  }

  set(mood: LoupeMood, dept: LoupeDept | undefined) {
    if (mood !== this.mood) {
      if (mood === "happy" && !reduceMotion()) this.hop = performance.now();
      this.mood = mood;
      this.apTarget = mood === "listen" ? 1.3 : mood === "think" ? 0.72 : 1;
    }
    if (dept !== this.dept) {
      this.dept = dept;
      for (const [name, prop] of Object.entries(this.L.props)) {
        const on = name === dept;
        if (on && !prop!.visible) prop!.userData.pop = performance.now();
        prop!.visible = on;
      }
      const c = dept ? DEPT_COLOR[dept] : "#E2452B";
      this.L.pupilMat.color.set(c);
      this.L.pupilMat.emissive.set(c);
    }
  }

  doTrick(name: Trick) {
    if (reduceMotion()) return;
    this.trick = { name, at: performance.now() };
    this.lastTrick = name;
  }

  /** The scissors this frame: a trick if one is on (or due, when he's playful and idle), else snipping while he works. */
  private scissors(now: number, busy: boolean, reduce: boolean) {
    const L = this.L;
    const { toss, halves } = L.scissors;
    let open = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    let spin = 0;
    let look = 0;
    let hand = 0;
    this.squint = 1;
    if (!this.trick && this.playful && this.mood === "idle" && !reduce && this.tickle < 0.05 && now > this.nextTrick) {
      let pick = Math.random();
      let name: Trick = "juggle";
      for (const [t, odds] of TRICK_ODDS) if ((pick -= odds) <= 0) {
        name = t;
        break;
      }
      if (name === this.lastTrick) name = name === "juggle" ? "twirl" : "juggle";
      this.doTrick(name);
    }
    const trick = this.trick;
    if (trick) {
      const t = (now - trick.at) / TRICK_MS[trick.name];
      if (t >= 1) {
        this.trick = null;
        this.nextTrick = now + 3200 + Math.random() * 4300;
      } else if (trick.name === "snip") {
        // Snip snip snip, jabbing forward with each one.
        const p = (t * 3) % 1;
        open = snipAt(p);
        z = 0.1 * Math.sin(p * Math.PI);
        x = -0.04 * Math.sin(p * Math.PI);
      } else if (trick.name === "twirl") {
        // Round the finger twice, like a gunslinger.
        spin = ease(t) * Math.PI * 4;
        y = 0.12 * Math.sin(t * Math.PI);
        hand = 0.25 * Math.sin(t * Math.PI);
      } else if (trick.name === "juggle") {
        // Up over his head, flipping, and caught again; his eye follows them.
        y = 1.3 * 4 * t * (1 - t);
        x = -0.6 * Math.sin(t * Math.PI);
        spin = -t * Math.PI * 6;
        open = -0.21;
        look = -0.38 * Math.sin(t * Math.PI);
        hand = 0.7 * (bump(t, 0.03, 0.08) + bump(t, 0.97, 0.08));
      } else if (trick.name === "double") {
        // A little toss, then a big one he's not sure about: he squints on the way down, the catch wobbles, then a grin.
        if (t < 0.36) {
          const u = t / 0.36;
          y = 0.6 * 4 * u * (1 - u);
          spin = -u * Math.PI * 2;
          look = -0.2 * Math.sin(u * Math.PI);
        } else {
          const u = (t - 0.36) / 0.64;
          const flight = Math.min(1, u / 0.82);
          y = 1.5 * 4 * flight * (1 - flight);
          x = -0.75 * Math.sin(flight * Math.PI);
          spin = -Math.PI * 2 - flight * Math.PI * 8;
          look = -0.45 * Math.sin(flight * Math.PI);
          if (flight > 0.55 && flight < 1) this.squint = 0.3;
          if (u > 0.82) {
            const w = (u - 0.82) / 0.18;
            spin += Math.sin(w * Math.PI * 5) * 0.5 * (1 - w);
            L.body.rotation.z = Math.sin(w * Math.PI * 4) * 0.08 * (1 - w);
            if (w > 0.6 && this.grinUntil < now) this.grinUntil = now + 900;
          }
        }
        open = -0.21;
        hand = 0.7 * (bump(t, 0.02, 0.06) + bump(t, 0.36, 0.06) + bump(t, 0.89, 0.06));
      } else if (trick.name === "haircut") {
        // A trim off the top: up to his fur, three snips, and back.
        const go = t < 0.22 ? ease(t / 0.22) : t > 0.8 ? 1 - ease((t - 0.8) / 0.2) : 1;
        x = -0.85 * go;
        y = 1.15 * go;
        z = -0.25 * go;
        spin = 0.9 * go;
        look = -0.3 * go;
        hand = 0.5 * go;
        if (t > 0.25 && t < 0.78) open = snipAt(((t - 0.25) / 0.53) * 3 % 1);
      }
    } else if (busy) {
      open = snipAt((now / 420) % 1);
    }
    toss.position.set(x, y, z);
    toss.rotation.z = spin;
    halves[1].rotation.z = open;
    halves[-1].rotation.z = -open;
    L.body.rotation.x += look;
    L.hands[1].rotation.z = -0.2 + hand;
  }

  setTickling(on: boolean) {
    this.tickling = on;
    if (on) this.tickle = Math.max(this.tickle, 0.55);
  }
  wiggle() {
    this.tickle = Math.min(1, this.tickle + 0.08);
  }

  frame(now: number, dt: number) {
    const L = this.L;
    const r = this.host.getBoundingClientRect();
    if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return;
    const reduce = reduceMotion();
    // Look toward the pointer, or glance around when it's still.
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const idleLook = now - pointer.t > 4000;
    const tx = idleLook ? Math.sin(now / 2400) * 0.25 : Math.max(-1, Math.min(1, (pointer.x - cx) / 500)) * 0.55;
    const ty = idleLook ? Math.sin(now / 3100) * 0.08 : Math.max(-1, Math.min(1, (pointer.y - cy) / 500)) * 0.3;
    const ease = 1 - Math.pow(0.002, dt);
    this.yaw += (tx - this.yaw) * ease;
    this.pitch += (ty - this.pitch) * ease;
    L.body.rotation.y = this.yaw;
    L.body.rotation.x = this.pitch + (this.mood === "listen" ? 0.1 : 0);
    // The iris.
    if (Math.abs(this.ap - this.apTarget) > 0.004) {
      this.ap += (this.apTarget - this.ap) * Math.min(1, dt * 9);
      L.buildAperture(this.ap);
    }
    this.spin = this.mood === "think" && !reduce ? this.spin - dt * 4.2 : this.spin * 0.9;
    L.aperture.rotation.z = this.spin;
    // Blink.
    let lidY = 1;
    if (this.mood === "idle" || this.mood === "listen") {
      const b = now - this.blinkAt;
      if (b > 0 && b < 160) lidY = Math.max(0.08, Math.abs(b - 80) / 80);
      else if (b >= 160) this.blinkAt = now + 3500 + Math.random() * 3500;
    }
    // Breathe and hop.
    let y = reduce ? 0 : Math.sin(now / 900) * 0.015;
    if (this.hop > 0) {
      const t = (now - this.hop) / 520;
      if (t < 1) y += Math.sin(t * Math.PI) * 0.32;
      else this.hop = -1;
    }
    L.root.position.y = y;
    L.body.scale.set(1, 1 + (reduce ? 0 : Math.sin(now / 900) * 0.008), 1);
    // Props pop in, and move while he works.
    for (const [name, prop] of Object.entries(L.props)) {
      if (!prop!.visible) continue;
      const t = Math.min(1, (now - prop!.userData.pop) / 450);
      prop!.scale.setScalar(Math.max(0.01, t < 1 ? 1 + Math.sin(t * Math.PI) * 0.25 - (1 - t) * 0.9 : 1));
      const busy = this.mood === "think" && !reduce;
      if (name === "sound") prop!.position.y = busy ? Math.sin(now / 160) * 0.025 : 0;
      else if (name === "edit") prop!.rotation.z = !busy && this.hop > 0 && !this.trick ? Math.sin((now - this.hop) / 80) * 0.15 : 0;
      else prop!.rotation.z = busy ? Math.sin(now / 140) * 0.12 : this.hop > 0 ? Math.sin((now - this.hop) / 80) * 0.15 : 0;
    }
    // Ticklish: squirm, giggle, flap.
    this.tickle = this.tickling ? Math.max(this.tickle * Math.pow(0.6, dt), 0.45) : this.tickle * Math.pow(0.04, dt);
    const a = reduce ? Math.min(this.tickle, 0.3) : this.tickle;
    const laughing = a > 0.25;
    L.smile.visible = laughing || this.mood === "happy" || now < this.grinUntil;
    L.aperture.visible = !L.smile.visible;
    L.pupil.visible = !L.smile.visible;
    if (a > 0.01) {
      L.body.rotation.z = Math.sin(now / 42) * 0.13 * a;
      L.root.position.y += Math.abs(Math.sin(now / 85)) * 0.09 * a;
      const sq = Math.abs(Math.sin(now / 70)) * a;
      L.body.scale.set(1 + 0.035 * sq, 1 - 0.05 * sq, 1);
      for (const s of [-1, 1] as const) L.hands[s].rotation.z = -s * 0.2 + Math.sin(now / 55 + s) * 0.55 * a;
      lidY = 1;
    } else {
      L.body.rotation.z = 0;
      for (const s of [-1, 1] as const) L.hands[s].rotation.z = -s * 0.2;
    }
    if (L.props.edit?.visible && a <= 0.01) {
      this.scissors(now, this.mood === "think" && !reduce, reduce);
      lidY = Math.min(lidY, this.squint);
    }
    L.lid.scale.y = lidY;
    this.renderer.render(this.scene, this.camera);
    if (!this.drawn) {
      this.drawn = true;
      this.onDrawn();
    }
  }

  dispose() {
    this.renderer.domElement.remove();
    this.renderer.dispose();
  }
}

export type Loupe3D = {
  set: (mood: LoupeMood, dept: LoupeDept | undefined) => void;
  /** Scissor tricks on his own now and then (the landing page), or not (the app). */
  playful: (on: boolean) => void;
  trick: (name: Trick) => void;
  tickling: (on: boolean) => void;
  wiggle: () => void;
  dispose: () => void;
};

/** Puts a 3D Loupe in `host`. Calls `onDrawn` after the first frame, and `onFailed` if WebGL can't. */
export function mountLoupe3D(host: HTMLElement, size: number, onDrawn: () => void, onFailed: () => void): Loupe3D | null {
  let view: LoupeView;
  try {
    if (!document.createElement("canvas").getContext("webgl2")) throw new Error("no WebGL2");
    view = new LoupeView(host, size, onDrawn);
  } catch (error) {
    console.warn("Loupe 3D unavailable", error);
    onFailed();
    return null;
  }
  const guarded = (fn: (now: number, dt: number) => void) => (now: number, dt: number) => {
    try {
      fn(now, dt);
    } catch (error) {
      // Put the drawing back rather than leave an empty spot.
      console.warn("Loupe 3D stopped", error);
      view.dead = true;
      views.delete(view);
      view.dispose();
      onFailed();
    }
  };
  const frame = view.frame.bind(view);
  view.frame = guarded(frame);
  views.add(view);
  if (views.size === 1) window.addEventListener("pointermove", track, { passive: true });
  if (!looping) {
    looping = true;
    last = performance.now();
    requestAnimationFrame(loop);
  }
  return {
    set: (mood, dept) => view.set(mood, dept),
    playful: (on) => (view.playful = on),
    trick: (name) => view.doTrick(name),
    tickling: (on) => view.setTickling(on),
    wiggle: () => view.wiggle(),
    dispose: () => {
      views.delete(view);
      if (!views.size) window.removeEventListener("pointermove", track);
      view.dispose();
    },
  };
}
