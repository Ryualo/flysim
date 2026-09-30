import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const $ = (id) => document.getElementById(id);
const setStatus = (id, cls, txt) => { const e = $(id); if (e) e.innerHTML = `<span class="${cls}">${txt}</span>`; };

if (!window.WebGLRenderingContext) {
  $("webgl-fallback").style.display = "block";
  throw new Error("No WebGL");
}

/* ── Steering / behaviour config ── */
const CFG = {
  // Fly size & placement in AR view (tune here)
  FLY_SCALE: 3.0,     // ↑ bigger = larger fly on screen (target max dimension in world units)
  FLY_Z: 1.2,         // distance in front of camera (0=near plane, 2.5=camera pos)
  pushForce: 0.08,
  recoverySpring: 0.03,
  handDisturbRecoverTime: 2.0,
  // ── Natural steering (acceleration → velocity → position) ──
  detectRange: 3.5,        // start reacting to cheese (covers full visible area so fly never ignores it)
  arrivalRadius: 0.5,      // begin smooth slowdown (short — commit, don't brake early)
  feedingDistance: 0.12,   // preferred hover distance — physically reach the cheese
  maxSpeed: 2.6,           // world units / sec — insect-like, much faster
  maxForce: 9.0,           // max steering acceleration / sec — quick bursts, fast turns
  burstForce: 15.0,        // extra force on first few frames of chase (darts out)
  burstTime: 0.22,         // seconds of burst acceleration at chase start
  drag: 0.94,              // friction (frame-rate corrected)
  // ── Animation (independent from movement physics) ──
  animationSpeed: 3.0,     // wing flap multiplier (1.0 = original rig speed, 3.0 = faster insect-like)
  movementSpeed: 1.0,      // movement physics multiplier (1.0 = default)
  hoverAmp: 0.022,         // vertical bob amplitude
  hoverFreq: 0.75,         // bob frequency
  driftAmp: 0.014,         // random drift strength
  jitterFreq: 7.5,         // small direction-corrections while chasing
  jitterAmp: 0.18,         // how strong those corrections are
  // ── Food lifecycle ──
  orbitRadius: 0.45,       // distance when circling cheese
  orbitSpeed: 1.6,         // angular speed (rad/sec) around cheese
  orbitMinTime: 0.8,       // minimum seconds to orbit before striking
  orbitMaxTime: 1.8,       // maximum seconds to orbit before striking
  strikeSpeed: 4.0,        // fast darts toward cheese at strike
  strikeTime: 0.35,        // duration of strike approach
  eatDuration: 2.0,        // seconds of eating before cheese consumed
  cheeseRadius: 0.12,      // sphere radius for eating attachment
  // ── Pinch (cheese + fly) ──
  pinchThreshold: 0.07,   // thumb-index normalized
  grabRange: 0.85,        // world distance to grab cheese / hold fly
  // ── Fly brain state ── house-fly personality ──
  brainTickRate: 0.3,     // faster decisions — house fly is twitchy
  hungerRate: 0.8,        // fast hunger — hunts cheese every 2 minutes or so
  energyDrainRate: 0.18,  // slow energy drain — can pester you for a long time
  energyRecoverRate: 1.6, // recovers quickly while landed
  fearDecayRate: 1.4,     // fear fades fairly fast (flies are bold)
  curiosityDecayRate: 0.08,// curiosity barely decays — always nosy/annoying
};

/* ── Global state ── */
const S = {
  scene: null, camera: null, renderer: null, clock: new THREE.Clock(),
  flyGroup: null, flyMixer: null, flyActions: {},
  cheese: null, cheesePlaced: false,
  cheeseList: [],              // all active cheese objects (food lifecycle)
  // ── Food lifecycle state machine ──
  foodState: "search",         // search | orbit | strike | eat
  foodTarget: null,            // active cheese being pursued
  orbitAngle: 0,               // current angle while orbiting
  orbitStart: 0,               // clock time when orbit began
  orbitDuration: 0,            // random duration before strike
  strikeStart: 0,              // clock time when strike began
  eatStart: 0,                 // clock time when eating began
  eatTimeAccum: 0,             // accumulated contact time during EAT (pauses when not touching)
  _lastStrikeLog: -999,        // debug throttling for strike logs
  flyVel: new THREE.Vector3(), flyHome: new THREE.Vector3(),
  flyDisturbed: false, disturbTime: 0,
  flyState: "idle",   // idle | approaching | hovering | disturbed
  // Hand tracking — raw landmarks only, no effects
  handPos2D: null, _lastLm: null,
  videoEl: null, handCanvas: null, handCtx: null,
  neuData: null,
  handsReady: false, handDetected: false, handFrames: 0,
  hands: [],                 // up to 2
  // Gesture (single: PINCH only)
  gesture: "NONE",           // NONE | PINCH
  isPinching: false,
  pinchWorldPos: null,       // 3D pinch midpoint
  // Cheese pipeline — isolated
  pinchGrab: false,          // actively holding cheese
  cheeseGrabPrev: null,
  // Fly hold — isolated
  flyHeld: false,
  flyPreHoldState: null,
  // Camera frustum bounds — computed from actual FOV/aspect at fly depth
  frustumBounds: { minX: -2.0, maxX: 2.0, minY: -1.5, maxY: 1.5, minZ: 0.3, maxZ: 2.3 },
  debugBorder: null,           // wireframe box showing camera frustum
  // Steering — reusable scratch vectors (avoid GC)
  _steer: new THREE.Vector3(),
  _desired: new THREE.Vector3(),
  _tmp: new THREE.Vector3(),
  // Drift / noise
  _driftPhase: Math.random() * Math.PI * 2,
  _driftPhase2: Math.random() * Math.PI * 2,
  _chaseStart: 0,         // clock time when chase began (for burst)
  _lastCheeseDist: 999,   // previous frame distance (detect new chase)
  // Cheese offset (grab)
  cheeseOffset: new THREE.Vector3(),
  spawnedCheeseCount: 0,  // total spawns (debug)
  // ── FLY BRAIN: Internal creature state (0-100 range) ──
  // House fly personality: mostly annoying (buzz face/shoulders), only hunts food when starving.
  // NeuPrint will hook into driveBrain() → behavior selection.
  brain: {
    hunger: 0,         // 0 = full, 100 = starving (drives SEARCH_FOOD only when very high)
    energy: 100,       // 0 = exhausted, 100 = fully rested (drives REST)
    curiosity: 80,     // 0 = bored, 100 = very curious → drives EXPLORE (buzz face/shoulder)
    fear: 0,           // 0 = calm, 100 = terrified (drives ESCAPE away from hand)
    comfort: 70,       // 0 = stressed, 100 = comfortable (affects REST target choice)
    lastTick: 0,       // last brain update clock time
    behavior: "EXPLORE", // start exploring immediately — be annoying
    behaviorStart: 0,  // clock time when current behavior began
    landingTarget: null, // (unused now — kept for compatibility) 
    isLanded: false,     // true while actually perched (skip physics)
    landStart: 0,        // landing timestamp for REST dwell time
    annoyanceTimer: 0,   // cycles between fly-bys — keeps it annoying
  },
  // Debug
  dbg: {
    handX: 0, handY: 0, pinch: "NO", cheeseGrab: "NO",
    cheeseX: 0, cheeseY: 0, flyX: 0, flyY: 0, flyZ: 0,
    dist: 0, state: "search",
    targetDistance: 0, currentSpeed: 0, flyVelocity: "0,0,0",
    foodState: "search", cheeseCount: 0,
    dt: "0", fps: "0", animDt: "0", animSpeed: "1.00", timeScale: 1,
    // Brain debug (updated each brain tick, rendered in #brain-panel)
    brainBehavior: "EXPLORE", brainHunger: 0, brainEnergy: 100, brainCuriosity: 80, brainFear: 0, brainComfort: 70,
  },
};

export async function setupCamera() {
  const video = $("webcam"); S.videoEl = video;
  console.log("[Camera] Requesting webcam...");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = stream;
    await new Promise((r) => (video.onloadedmetadata = r));
    video.play();
    console.log("[Camera] Active OK");
    setStatus("status-cam", "ok", "Camera: ACTIVE ✓");
    return true;
  } catch (e) {
    console.error("[Camera] Failed:", e);
    setStatus("status-cam", "err", "Camera: DENIED - " + e.message);
    return false;
  }
}

export function setupScene() {
  console.log("[Scene] Initializing WebGL...");
  const canvas = $("three-canvas");
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 100);
    camera.position.set(0, 0, 2.5);  // camera z — FLY_Z controls model z, not this
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const d1 = new THREE.DirectionalLight(0xffffff, 1.8); d1.position.set(2, 3, 4); scene.add(d1);
    const d2 = new THREE.DirectionalLight(0x8888ff, 0.6); d2.position.set(-2, -1, 2); scene.add(d2);
    Object.assign(S, { scene, camera, renderer });
    
    // Compute frustum bounds + create debug border
    updateFrustumBounds();
    createDebugBorder();
    
    // Toggle border with 'b' key
    window.addEventListener("keydown", (e) => {
      if (e.key === "b" || e.key === "B") {
        if (S.debugBorder) {
          S.debugBorder.visible = !S.debugBorder.visible;
          console.log("[Frustum] Border " + (S.debugBorder.visible ? "SHOWN" : "HIDDEN"));
        }
      }
    });
    
    window.addEventListener("resize", () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      updateFrustumBounds(); // Recompute bounds on resize
    });
    console.log("[Scene] WebGL OK, rendering", window.innerWidth, "x", window.innerHeight);
    return true;
  } catch (e) {
    console.error("[Scene] WebGL init failed:", e);
    setStatus("status-fly", "err", "WebGL FAILED: " + e.message);
    return false;
  }
}

/* ── Camera frustum bounds — compute exact visible volume at fly depth ── */
function updateFrustumBounds() {
  const cam = S.camera;
  if (!cam) return;
  
  // Frustum depth (relative to camera position)
  const flyDepth = CFG.FLY_Z;         // 1.2 — where the fly operates
  const camZ = cam.position.z;        // 2.5
  const distToFly = camZ - flyDepth;  // 1.3 from camera to fly plane
  
  // Compute frustum dimensions at fly depth using FOV
  const fovRad = THREE.MathUtils.degToRad(cam.fov);
  const halfHeight = Math.tan(fovRad / 2) * distToFly;
  const halfWidth = halfHeight * cam.aspect;
  
  // Store bounds (small inset to keep fly fully on-screen)
  const inset = 0.15;
  S.frustumBounds = {
    minX: -halfWidth + inset,
    maxX:  halfWidth - inset,
    minY: -halfHeight + inset,
    maxY:  halfHeight - inset,
    minZ: flyDepth - 0.4,
    maxZ: flyDepth + 0.6,
  };
  
  console.log("[Frustum] Bounds @ z=" + flyDepth.toFixed(2), 
    "x[" + S.frustumBounds.minX.toFixed(2) + "," + S.frustumBounds.maxX.toFixed(2) + "]",
    "y[" + S.frustumBounds.minY.toFixed(2) + "," + S.frustumBounds.maxY.toFixed(2) + "]",
    "aspect=" + cam.aspect.toFixed(2));
  
  // Update debug wireframe
  updateDebugBorder();
}

function createDebugBorder() {
  if (!S.scene) return;
  
  const b = S.frustumBounds;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const d = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  
  const geo = new THREE.BoxGeometry(w, h, d);
  const edges = new THREE.EdgesGeometry(geo);
  const mat = new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true, opacity: 0.4 });
  const wireframe = new THREE.LineSegments(edges, mat);
  wireframe.position.set(cx, cy, cz);
  wireframe.visible = false; // hidden by default, toggle with keypress
  
  S.scene.add(wireframe);
  S.debugBorder = wireframe;
  console.log("[Frustum] Debug border created (toggle with 'b' key)");
}

function updateDebugBorder() {
  if (!S.debugBorder) return;
  const b = S.frustumBounds;
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  const d = b.maxZ - b.minZ;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  
  S.debugBorder.geometry.dispose();
  const geo = new THREE.BoxGeometry(w, h, d);
  S.debugBorder.geometry = new THREE.EdgesGeometry(geo);
  S.debugBorder.position.set(cx, cy, cz);
}

/* ── Fly model (ghost_fly.glb with rig + animation) ── */
export async function loadFly() {
  console.log("[Fly] Loading ghost_fly.glb at /ghost_fly.glb ...");
  setStatus("status-fly", "warn", "Fly: LOADING...");
  const loader = new GLTFLoader();
  try {
    console.log("[Fly] fetch check:", (await fetch("ghost_fly.glb")).status);
  } catch (e) { console.warn("[Fly] fetch check failed:", e); }

  try {
    const gltf = await new Promise((res, rej) => {
      loader.load(
        "ghost_fly.glb",
        (data) => {
          console.log("[Fly] GLTFLoader: SUCCESS");
          console.log("[Fly] scene children:", data.scene.children.length);
          console.log("[Fly] animations:", data.animations.length, data.animations.map(a => a.name));
          res(data);
        },
        (progress) => {
          if (progress.lengthComputable) {
            const pct = Math.round((progress.loaded / progress.total) * 100);
            if (pct % 25 === 0) console.log(`[Fly] Loading ${pct}%`);
          }
        },
        (err) => {
          console.error("[Fly] GLTFLoader: FAILED", err);
          console.error("[Fly] loader error detail:", JSON.stringify(err, null, 2));
          rej(err);
        }
      );
    });

    // Traverse and log everything — do NOT overwrite material properties blindly
    const meshes = [], bones = [];
    const animations = gltf.animations || [];
    gltf.scene.traverse((c) => {
      if (c.isMesh) {
        meshes.push({ name: c.name || "unnamed", verts: c.geometry.attributes.position?.count || 0, hasMaterial: !!c.material });
        console.log("[Fly] Mesh:", meshes[meshes.length - 1].name, "verts:", meshes[meshes.length - 1].verts, "mat:", c.material?.name || c.material?.type);

        // Hide the shadow catcher plane — it's a large white quad that obscures the view
        if (c.name === "Plane__0" || (c.parent && c.parent.name === "Plane")) {
          c.visible = false;
          console.log("[Fly] Hidden shadow catcher plane:", c.name);
        }

        // Keep original material — do not force transparent/opacity
        // Only ensure double-sided if the mesh is a wing/ghost cloth (thin)
        if (c.material && (c.name.toLowerCase().includes("wing") || c.name.toLowerCase().includes("ghost cloth"))) {
          c.material.side = THREE.DoubleSide;
        }
        c.castShadow = false;
        c.receiveShadow = false;
      }
      if (c.isBone) bones.push(c.name);
    });
    console.log("[Fly] Meshes:", meshes.length, "| Bones:", bones.length, "| Clips:", animations.length);
    animations.forEach((a, i) => console.log("[Fly] Clip", i, a.name, "dur:", a.duration.toFixed(2), "channels:", a.tracks.length));

    if (meshes.length === 0) {
      console.error("[Fly] NO MESHES in GLB — file may be corrupt or empty");
      setStatus("status-fly", "err", "Fly: FAILED - no meshes in GLB");
      return null;
    }

    const g = new THREE.Group();
    g.add(gltf.scene);

    // ── Compute raw bounding box (before any extra scale) ──
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z);
    console.log("[Fly] raw bbox size:", size, "maxDim:", maxDim.toFixed(6));

    // ── Apply FLY_SCALE: scale so longest dimension = FLY_SCALE world-units ──
    if (maxDim > 0) {
      const s = CFG.FLY_SCALE / maxDim;   // map maxDim → FLY_SCALE
      g.scale.setScalar(s);
      console.log("[Fly] FLY_SCALE:", CFG.FLY_SCALE, "→ group scale:", s.toFixed(4));
    }

    // ── Place at z = FLY_Z ──
    g.position.set(0, 0, CFG.FLY_Z);
    console.log("[Fly] position:", g.position, "z:", CFG.FLY_Z);

    S.scene.add(g);
    S.flyGroup = g;
    S.flyHome.copy(g.position);
    console.log("[Fly] Group added to scene, world pos:", g.position, "scale:", g.scale.x.toFixed(4));
    console.log("[Fly] Group visible:", g.visible, "children:", g.children.length);

    // AnimationMixer — drives rig if clips available
    if (animations.length > 0) {
      S.flyMixer = new THREE.AnimationMixer(gltf.scene);
      animations.forEach((clip) => {
        S.flyActions[clip.name] = S.flyMixer.clipAction(clip);
      });
      const idleName = animations[0].name;
      S.flyActions[idleName].play();
      S.flyState = "idle";
      console.log("[Fly] Mixer ready, playing:", idleName);
    } else {
      console.warn("[Fly] No animation clips");
    }

    setStatus("status-fly", "ok", "Fly: OK - rigged (" + meshes.length + " meshes, " + bones.length + " bones)");
    return g;
  } catch (e) {
    console.error("[Fly] Load failed:", e.message, e.stack);
    setStatus("status-fly", "err", "Fly: FAILED - " + e.message);
    return null;
  }
}

/* ── Cheese ── */
export function createCheese(randomPos = false) {
  // Remove existing cheese — only 1 at a time
  if (S.cheese) {
    removeCheese(S.cheese);
  }

  const c = document.createElement("canvas"); c.width = 128; c.height = 128;
  const cx = c.getContext("2d");
  cx.fillStyle = "#f5c842"; cx.beginPath(); cx.arc(64, 64, 50, 0, Math.PI * 2); cx.fill();
  cx.fillStyle = "#e8a830"; cx.beginPath(); cx.arc(40, 45, 8, 0, Math.PI * 2); cx.arc(75, 55, 6, 0, Math.PI * 2); cx.arc(55, 80, 7, 0, Math.PI * 2); cx.fill();
  cx.strokeStyle = "#c88820"; cx.lineWidth = 3; cx.beginPath(); cx.arc(64, 64, 50, 0, Math.PI * 2); cx.stroke();
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(0.15, 0.15, 1);
  if (randomPos) {
    // Random position in front of camera (world space, not camera-locked)
    // x ∈ [-2.0, 2.0], y ∈ [-1.5, 1.5], z ∈ [0.8, 2.0] — always visible in view
    sp.position.set(
      (Math.random() - 0.5) * 4.0,
      (Math.random() - 0.5) * 3.0,
      0.8 + Math.random() * 1.2
    );
  } else {
    // Spawn at center of view, at fly depth
    sp.position.set(0.0, 0.0, CFG.FLY_Z);
  }
  sp.visible = true;
  S.scene.add(sp);
  S.cheeseList.push(sp);
  S.cheese = sp;                 // active target (first / last spawned)
  S.cheesePlaced = true;
  S.spawnedCheeseCount++;
  console.log("[Cheese] spawned #", S.spawnedCheeseCount, "at", sp.position.x.toFixed(2), sp.position.y.toFixed(2), sp.position.z.toFixed(2), "| total:", S.cheeseList.length);
  return sp;
}

export function removeCheese(sp) {
  const i = S.cheeseList.indexOf(sp);
  if (i >= 0) S.cheeseList.splice(i, 1);
  S.scene.remove(sp);
  if (sp.material.map) sp.material.map.dispose();
  sp.material.dispose();
  if (S.cheese === sp) S.cheese = S.cheeseList[0] || null;
  if (S.foodTarget === sp) { S.foodTarget = null; S.foodState = "search"; }
  console.log("[Cheese] removed | remaining:", S.cheeseList.length);
}

/* ══════════════════════════════════════════════════════════════
   HAND INTERACTION PIPELINE
   Tracking: raw landmarks only (no object effects)
   Gesture: only confirmed PINCH triggers actions
   Cheese + Fly: independent systems, respond only to pinch near them
   ══════════════════════════════════════════════════════════════ */

/* ── MediaPipe Hands setup ── */
export function setupHands() {
  console.log("[Hands] Initializing MediaPipe...");
  setStatus("status-hand", "warn", "Hands: INITIALIZING...");
  const hc = $("hand-canvas");
  hc.width = window.innerWidth; hc.height = window.innerHeight;
  S.handCanvas = hc; S.handCtx = hc.getContext("2d");
  if (typeof Hands === "undefined") {
    setStatus("status-hand", "err", "Hands: FAILED - MediaPipe not loaded"); return;
  }
  if (typeof Camera === "undefined") {
    setStatus("status-hand", "err", "Hands: FAILED - Camera util missing"); return;
  }
  try {
    const hands = new Hands({
      locateFile: (f) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${f}`,
    });
    hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.6, minTrackingConfidence: 0.5 });
    hands.onResults(onHandResults);
    if (S.videoEl) {
      const cam = new Camera(S.videoEl, {
        onFrame: async () => { S.handFrames++; try { await hands.send({ image: S.videoEl }); } catch(e) {} },
        width: 1280, height: 720,
      });
      cam.start(); S.handsReady = true;
      setStatus("status-hand", "ok", "Hands: READY ✓");
    }
  } catch(e) { setStatus("status-hand", "err", "Hands: FAILED - " + e.message); }
}

/* ── HAND RESULTS: draw landmarks, detect pinch ── */
function onHandResults(results) {
  const ctx = S.handCtx; if (!ctx) return;
  ctx.clearRect(0, 0, S.handCanvas.width, S.handCanvas.height);
  S.handPos2D = null; S.isPinching = false; S.pinchWorldPos = null;
  S.hands = []; S.handDetected = false;

  if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
    setStatus("status-hand-detected", "warn", "Hand detected: NO");
    S.gesture = "NONE"; S._lastLm = null;
    if (S.pinchGrab) releaseCheese();
    if (S.flyHeld) releaseFlyHold();
    return;
  }

  S.handDetected = true;
  const n = results.multiHandLandmarks.length;
  setStatus("status-hand-detected", "ok", "Hand detected: YES ✓ (" + n + ")");
  S.hands = results.multiHandLandmarks;
  const lm = results.multiHandLandmarks[0];
  S._lastLm = lm;
  for (const h of results.multiHandLandmarks) {
    ctx.fillStyle = "#0f0";
    for (const pt of h) { ctx.beginPath(); ctx.arc(pt.x*S.handCanvas.width, pt.y*S.handCanvas.height, 2, 0, Math.PI*2); ctx.fill(); }
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(h[0].x*S.handCanvas.width, h[0].y*S.handCanvas.height, 6, 0, Math.PI*2); ctx.fill();
  }
  S.handPos2D = { x: lm[0].x, y: lm[0].y };
  detectPinchGesture(lm, ctx);
}

/* ── PINCH DETECTION: only confirmed pinch triggers actions ── */
function detectPinchGesture(lm, ctx) {
  const thumb = lm[4], index = lm[8];
  const dist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
  const wasPinching = S.isPinching;
  S.isPinching = dist < CFG.pinchThreshold;

  if (S.isPinching) {
    const mx = (thumb.x+index.x)/2, my = (thumb.y+index.y)/2;
    S.pinchWorldPos = new THREE.Vector3((0.5-mx)*4, (0.5-my)*3, CFG.FLY_Z);
    ctx.strokeStyle = "#ff0"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(mx*S.handCanvas.width, my*S.handCanvas.height, 12, 0, Math.PI*2); ctx.stroke();
  } else { S.pinchWorldPos = null; }

  // Rising edge → try cheese grab, then fly hold
  if (S.isPinching && !wasPinching) {
    S.gesture = "PINCH";
    if (!tryGrabCheese()) tryHoldFly();
  }
  // Falling edge → release both
  else if (!S.isPinching && wasPinching) {
    S.gesture = "NONE"; releaseCheese(); releaseFlyHold();
  }
}

/* ═══ CHEESE INTERACTION (isolated — only pinch near cheese) ═══ */
function tryGrabCheese() {
  if (S.pinchGrab || !S.pinchWorldPos) return false;
  let nearest = null, minDist = CFG.grabRange;
  for (const ch of S.cheeseList) {
    if (!ch.visible) continue;
    const d = ch.position.distanceTo(S.pinchWorldPos);
    if (d < minDist) { minDist = d; nearest = ch; }
  }
  if (!nearest) return false;
  console.log("[Cheese] PINCH grab");
  S.pinchGrab = true;
  S.cheeseGrabPrev = { cheese: nearest, origPos: nearest.position.clone(), origScale: nearest.scale.clone() };
  nearest.scale.multiplyScalar(0.9);
  return true;
}
function updateCheeseFollow() {
  if (!S.pinchGrab || !S.cheeseGrabPrev || !S.pinchWorldPos) return;
  const ch = S.cheeseGrabPrev.cheese;
  if (!ch || !ch.visible) { releaseCheese(); return; }
  ch.position.lerp(S.pinchWorldPos, 0.4);
}
function releaseCheese() {
  if (!S.pinchGrab || !S.cheeseGrabPrev) return;
  S.cheeseGrabPrev.cheese.scale.copy(S.cheeseGrabPrev.origScale);
  console.log("[Cheese] Released");
  S.pinchGrab = false; S.cheeseGrabPrev = null;
}

/* ═══ FLY HOLD INTERACTION (isolated — only pinch near fly) ═══ */
function tryHoldFly() {
  if (S.flyHeld || !S.pinchWorldPos || !S.flyGroup) return false;
  const dToF = S.flyGroup.position.distanceTo(S.pinchWorldPos);
  if (dToF > CFG.grabRange) return false;
  console.log("[Fly] PINCH hold - freeze (dist:", dToF.toFixed(3) + ")");
  S.flyHeld = true;
  S.flyPreHoldState = { vel: S.flyVel.clone(), behavior: S.brain.behavior };
  S.flyVel.set(0, 0, 0);
  return true;
}
function releaseFlyHold() {
  if (!S.flyHeld) return;
  console.log("[Fly] Released - resume");
  S.flyHeld = false; S.flyPreHoldState = null;
}

export async function setupNeuPrint() {
  console.log("[neuPrint] Checking connection...");
  setStatus("status-neu", "warn", "neuPrint: CHECKING...");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch("/api/neuroprint/health", { signal: controller.signal });
    clearTimeout(timeout);
    const d = await r.json();
    console.log("[neuPrint] Health response:", d);
    if (d.ok) {
      setStatus("status-neu", "ok", `neuPrint: OK ✓ (${d.count} datasets)`);
      $("neu-content").innerHTML =
        `<b>${d.count} datasets:</b><br>${(d.datasets || []).slice(0, 8).map((n) => "• " + n).join("<br>")}${d.count > 8 ? "<br>..." : ""}`;
      S.neuData = d;
    } else {
      const msg = d.message || "Not configured";
      console.warn("[neuPrint] Not connected:", msg);
      setStatus("status-neu", "warn", `neuPrint: ${msg}`);
      $("neu-content").textContent = msg;
    }
  } catch (e) {
    clearTimeout(timeout);
    const msg = e.name === "AbortError" ? "Timeout after 15s" : (e.message || "Backend offline");
    console.error("[neuPrint] Failed:", e);
    setStatus("status-neu", "err", `neuPrint: FAILED - ${msg}`);
    $("neu-content").textContent = `Error: ${msg}`;
  }
}

/* ══════════════════════════════════════════════════════════════
   FLY BRAIN — House-fly personality controller
   ──────────────────────────────────────────────────────────────
   Primary personality: persistent, annoying, buzzing around
   your face/shoulders — only hunts food when truly starving.

   Behavior loop (most common):
     EXPLORE (buzz face/shoulder) → LAND on face → rest briefly
     → EXPLORE (fly to other cheek/shoulder) → repeat
   ────────────────────────────────────────────────────────────── */

function clamp01(v) { return v < 0 ? 0 : v > 100 ? 100 : v; }

function updateDrives(dt, t) {
  const b = S.brain;

  // ── Hunger: builds fast — hunts cheese frequently ──
  b.hunger = clamp01(b.hunger + CFG.hungerRate * dt);

  // ── Energy: drain depends on what the fly is doing ──
  if (b.isLanded || b.behavior === "REST") {
    // Landed/resting: recover fast
    b.energy = clamp01(b.energy + CFG.energyRecoverRate * dt);
  } else if (b.behavior === "EXPLORE") {
    // Exploring (flying near face): mild drain
    b.energy = clamp01(b.energy - CFG.energyDrainRate * 0.25 * dt);
  } else if (b.behavior === "ESCAPE") {
    // Panic darting: heavy drain
    b.energy = clamp01(b.energy - CFG.energyDrainRate * 2.0 * dt);
  } else if (b.behavior === "IDLE") {
    // Hovering: very light drain
    b.energy = clamp01(b.energy - CFG.energyDrainRate * 0.15 * dt);
  } else {
    // SEARCH_FOOD, EAT: moderate drain
    b.energy = clamp01(b.energy - CFG.energyDrainRate * dt);
  }

  // ── Curiosity: stays high (house fly is always nosy) ──
  if (b.isLanded) {
    // After landing for a while, curiosity recharges (wants to explore next spot)
    b.curiosity = clamp01(b.curiosity + 0.6 * dt);
  } else if (b.behavior === "EXPLORE") {
    // Slightly decays while exploring, but very slowly
    b.curiosity = clamp01(b.curiosity - CFG.curiosityDecayRate * 1.5 * dt);
  } else {
    // Barely decays otherwise
    b.curiosity = clamp01(b.curiosity - CFG.curiosityDecayRate * dt);
  }

  // ── Fear: spikes when hand moves fast nearby, decays quickly (flies are bold) ──
  if (S.handDetected && S.handPos2D && !S.pinchGrab) {
    const fly = S.flyGroup;
    if (fly) {
      const handWorld = new THREE.Vector3(
        (0.5 - S.handPos2D.x) * 4,
        (0.5 - S.handPos2D.y) * 3,
        1.5
      );
      const dist = fly.position.distanceTo(handWorld);
      if (dist < 1.0) {
        b.fear = clamp01(b.fear + (1.0 - dist) * 14 * dt);
      } else {
        b.fear = clamp01(b.fear - CFG.fearDecayRate * dt);
      }
    }
  } else {
    b.fear = clamp01(b.fear - CFG.fearDecayRate * dt);
  }

  // ── Comfort: high when landed on face/body, drops when flying or scared ──
  if (b.isLanded) {
    b.comfort = clamp01(85 + 10 - b.fear * 0.3);
  } else {
    b.comfort = clamp01(70 - b.fear * 0.5);
  }
}

/* ── Food lifecycle state machine (SEARCH → ORBIT → STRIKE → EAT) ── */
// All states use physics (acceleration → velocity → position)
/* ── Landing target selection removed — body zones no longer used ── */
// The fly now flies freely (EXPLORE) or hunts cheese; hand gestures control reactions.

/* ── neuPrint signal hook: scale brain drives (kept for future signals) ── */
export function applyNeuPrintBias(modifiers = {}) {
  const b = S.brain;
  if (modifiers.hunger !== undefined) b.hunger = clamp01(b.hunger * modifiers.hunger);
  if (modifiers.energy !== undefined) b.energy = clamp01(b.energy * modifiers.energy);
  if (modifiers.curiosity !== undefined) b.curiosity = clamp01(b.curiosity * modifiers.curiosity);
  if (modifiers.fear !== undefined) b.fear = clamp01(b.fear * modifiers.fear);
  if (modifiers.comfort !== undefined) b.comfort = clamp01(b.comfort * modifiers.comfort);
  console.log("[neuPrint] Applied modifiers:", modifiers);
}

function decideBehavior(t) {
  const b = S.brain;

  // ── Wake from landing ──
  if (b.isLanded) {
    const dwell = t - b.landStart;
    // Stay landed briefly (1-4s), longer if tired (low energy)
    const maxDwell = 1.0 + (100 - b.energy) * 0.04; // energy=25 → 4s, energy=100 → 1s
    if (dwell < maxDwell && b.energy < 98) return;
    b.isLanded = false;
    b.curiosity = clamp01(b.curiosity + 15); // wake up → wants to explore again
    console.log("[Brain] Woke up after", dwell.toFixed(1), "s — exploring next spot");
  }

  // ── ESCAPE: fear overrides everything ──
  if (b.fear > 55) {
    if (b.behavior !== "ESCAPE") {
      b.behavior = "ESCAPE"; b.behaviorStart = t;
      console.log("[Brain] → ESCAPE (fear:", b.fear.toFixed(1), ")");
    }
    return;
  }

  // ── EAT: if already in food state machine, let it finish ──
  if (S.foodState === "orbit" || S.foodState === "strike" || S.foodState === "eat") {
    if (b.behavior !== "EAT") {
      b.behavior = "EAT"; b.behaviorStart = t;
      console.log("[Brain] → EAT (foodState:", S.foodState, ")");
    }
    return;
  }

  // ── SEARCH_FOOD: only when REALLY hungry (hunger bar nearly full) ──
  // This is the key change — threshold is 85+, not 50, so most of the time
  // the fly ignores cheese and just annoys you instead.
  if (b.hunger >= 85 && b.energy > 25) {
    if (b.behavior !== "SEARCH_FOOD") {
      b.behavior = "SEARCH_FOOD"; b.behaviorStart = t;
      console.log("[Brain] → SEARCH_FOOD (hunger:", b.hunger.toFixed(1), "— starving!)");
    }
    return;
  }

  // ── REST: low energy (tired from buzzing your face) ──
  if (b.energy < 30) {
    if (b.behavior !== "REST") {
      b.behavior = "REST"; b.behaviorStart = t;
      console.log("[Brain] → REST (energy:", b.energy.toFixed(1), ")");
    }
    return;
  }

  // ── EXPLORE: high curiosity — buzz around face area (no body target needed)
  if (b.curiosity > 40 && b.energy > 35) {
    if (b.behavior !== "EXPLORE") {
      b.behavior = "EXPLORE"; b.behaviorStart = t;
      console.log("[Brain] → EXPLORE (curiosity:", b.curiosity.toFixed(1), ")");
    }
    return;
  }

  // ── IDLE: fallback (very rare — fly has low energy or low curiosity) ──
  if (b.behavior !== "IDLE") {
    b.behavior = "IDLE"; b.behaviorStart = t;
    console.log("[Brain] → IDLE (energy:", b.energy.toFixed(1), "curiosity:", b.curiosity.toFixed(1), ")");
  }
}

function getBrainTarget(t) {
  const b = S.brain;
  const fly = S.flyGroup;
  if (!fly) return null;
  switch (b.behavior) {
    case "IDLE":
      return null;

    case "SEARCH_FOOD":
      if (S.foodTarget && S.foodTarget.visible) return S.foodTarget.position;
      return null;

    case "EAT":
      return S.foodTarget?.position || null;

    case "REST":
      return S.flyHome.clone();

    case "EXPLORE": {
      // Fly around face area — house fly buzzing
      const wanderPhase = t * 0.7;
      return new THREE.Vector3(
        Math.sin(wanderPhase) * 0.5,
        1.2 + Math.cos(wanderPhase * 1.3) * 0.3,
        1.1 + Math.sin(wanderPhase * 0.6) * 0.2
      );
    }

    case "ESCAPE": {
      if (S.handDetected && S.handPos2D) {
        const handWorld = new THREE.Vector3(
          (0.5 - S.handPos2D.x) * 4,
          (0.5 - S.handPos2D.y) * 3,
          1.5
        );
        const away = new THREE.Vector3()
          .subVectors(fly.position, handWorld)
          .normalize()
          .multiplyScalar(3)
          .add(fly.position);
        return away;
      }
      return new THREE.Vector3(fly.position.x > 0 ? -2.0 : 2.0, 1.5, 2.0);
    }

    default: return null;
  }
}

function onBrainEatComplete() {
  const b = S.brain;
  b.hunger = clamp01(b.hunger - 60);  // big relief — won't hunt again for a while
  b.energy = clamp01(b.energy + 10);
  b.curiosity = 100;  // after eating, very curious/annoying again
  b.behavior = "EXPLORE"; b.behaviorStart = 0;
  b.annoyanceTimer = 0;
  console.log("[Brain] EAT complete → full & annoying again");
}

function driveBrain(dt, t) {
  const b = S.brain;
  updateDrives(dt, t);
  if (t - b.lastTick < CFG.brainTickRate) return;
  b.lastTick = t;
  decideBehavior(t);
}

// No direct position copy or snap — only steering forces.
function foodStateMachine(dt, t, fly) {
  if (S.flyDisturbed) return;
  const d = S.dbg;
  const steer = S._steer;

  switch (S.foodState) {
    case "search": {
      // Only hunt cheese if brain is SEARCH_FOOD or EAT (starving state)
      if (S.brain.behavior !== "SEARCH_FOOD" && S.brain.behavior !== "EAT") {
        S.foodTarget = null;
        break;
      }
      
      // Look for closest cheese in detectRange
      S.foodTarget = null;
      let closest = null, minDist = CFG.detectRange;
      for (const ch of S.cheeseList) {
        if (!ch.visible) continue;
        const dist = fly.position.distanceTo(ch.position);
        if (dist < minDist) { minDist = dist; closest = ch; }
      }
      if (closest) {
        S.foodTarget = closest;
        S.cheese = closest;  // keep S.cheese pointing to active target for compat
        // Transition to approaching via natural steering (handled in main movement block)
        // When close enough, transition to ORBIT
        if (minDist <= CFG.orbitRadius + 0.1) {
          S.foodState = "orbit";
          S.orbitStart = t;
          S.orbitDuration = CFG.orbitMinTime + Math.random() * (CFG.orbitMaxTime - CFG.orbitMinTime);
          S.orbitAngle = Math.atan2(
            fly.position.x - closest.position.x,
            fly.position.z - closest.position.z
          );
          console.log("[Food] SEARCH → ORBIT | duration:", S.orbitDuration.toFixed(2));
        }
      }
      break;
    }

    case "orbit": {
      // Circle around cheese at orbitRadius, face inward
      if (!S.foodTarget || !S.foodTarget.visible) {
        S.foodState = "search";
        S.foodTarget = null;
        break;
      }
      const elapsed = t - S.orbitStart;
      if (elapsed >= S.orbitDuration) {
        // Transition to STRIKE
        S.foodState = "strike";
        S.strikeStart = t;
        console.log("[Food] ORBIT → STRIKE");
        break;
      }
      // Orbit movement: steer toward tangent point on circle
      S.orbitAngle += CFG.orbitSpeed * dt;
      const target = S.foodTarget.position;
      const desiredPos = new THREE.Vector3(
        target.x + Math.sin(S.orbitAngle) * CFG.orbitRadius,
        target.y,
        target.z + Math.cos(S.orbitAngle) * CFG.orbitRadius
      );
      // Steering force toward desired orbit position
      const toDesired = new THREE.Vector3().subVectors(desiredPos, fly.position);
      const distToOrbit = toDesired.length();
      toDesired.normalize().multiplyScalar(Math.min(distToOrbit * 8, CFG.maxForce * 1.5));
      S.flyVel.addScaledVector(toDesired, dt);
      // Clamp orbit speed
      const orbitSpd = CFG.orbitSpeed * CFG.orbitRadius * 1.2;
      const spd = S.flyVel.length();
      if (spd > orbitSpd) S.flyVel.multiplyScalar(orbitSpd / spd);

      // Face inward (toward cheese)
      const dx = target.x - fly.position.x;
      const dz = target.z - fly.position.z;
      const targetYaw = Math.atan2(dx, dz);
      fly.rotation.y += (targetYaw - fly.rotation.y) * dt * 5;
      break;
    }

    case "strike": {
      // Fast direct approach toward cheese with high acceleration
      if (!S.foodTarget || !S.foodTarget.visible) {
        S.foodState = "search";
        S.foodTarget = null;
        break;
      }
      const elapsed = t - S.strikeStart;
      const dist = fly.position.distanceTo(S.foodTarget.position);

      // DEBUG: Log strike progress every 0.2s
      if (elapsed < S._lastStrikeLog || elapsed - S._lastStrikeLog > 0.2) {
        console.log(`[Strike] t=${elapsed.toFixed(2)}s dist=${dist.toFixed(3)} (need < ${(CFG.cheeseRadius * 1.2).toFixed(3)}) fly=(${fly.position.x.toFixed(2)},${fly.position.y.toFixed(2)},${fly.position.z.toFixed(2)}) cheese=(${S.foodTarget.position.x.toFixed(2)},${S.foodTarget.position.y.toFixed(2)},${S.foodTarget.position.z.toFixed(2)})`);
        S._lastStrikeLog = elapsed;
      }

      // Only transition to EAT when actually touching (no timeout fallback)
      if (dist < CFG.cheeseRadius * 1.2) {
        S.foodState = "eat";
        S.eatStart = t;
        S.eatTimeAccum = 0;  // reset accumulator when entering EAT
        console.log("[Food] STRIKE → EAT (contact at dist:", dist.toFixed(3), ")");
        break;
      }

      // Safety: if strike takes too long, return to search (don't force EAT)
      if (elapsed >= CFG.strikeTime * 3) {
        console.log("[Food] STRIKE timeout → SEARCH (dist:", dist.toFixed(3), ")");
        S.foodState = "search";
        S.foodTarget = null;
        break;
      }

      // Strong steering force toward cheese
      const dir = new THREE.Vector3().subVectors(S.foodTarget.position, fly.position).normalize();
      dir.multiplyScalar(CFG.strikeSpeed * 2.5);  // high acceleration
      S.flyVel.addScaledVector(dir, dt);
      // Clamp speed
      const vlen = S.flyVel.length();
      if (vlen > CFG.strikeSpeed) S.flyVel.multiplyScalar(CFG.strikeSpeed / vlen);

      // Face cheese
      const targetYaw = Math.atan2(S.flyVel.x, S.flyVel.z);
      fly.rotation.y += (targetYaw - fly.rotation.y) * dt * 8;
      break;
    }

    case "eat": {
      // Hover near cheese with spring+damping, decay only while touching
      if (!S.foodTarget || !S.foodTarget.visible) {
        S.foodState = "search";
        S.foodTarget = null;
        break;
      }
      const dt_ = dt;  // alias for clarity
      const dist = fly.position.distanceTo(S.foodTarget.position);
      const isTouching = dist < CFG.cheeseRadius * 1.5;  // slightly larger radius for EAT hover

      // Soft spring toward cheese position (hover above it)
      const eatPos = S.foodTarget.position.clone();
      eatPos.y += 0.08;
      const toEat = new THREE.Vector3().subVectors(eatPos, fly.position);
      const springForce = toEat.multiplyScalar(8);  // spring constant
      const damping = S.flyVel.clone().multiplyScalar(-6);
      const eatSteer = springForce.add(damping);
      S.flyVel.addScaledVector(eatSteer, dt_);
      // Clamp to very low hovering speed
      const vlen = S.flyVel.length();
      if (vlen > 0.3) S.flyVel.multiplyScalar(0.3 / vlen);

      // Face cheese
      const targetYaw = Math.atan2(
        S.foodTarget.position.x - fly.position.x,
        S.foodTarget.position.z - fly.position.z
      );
      fly.rotation.y += (targetYaw - fly.rotation.y) * dt_ * 3;

      // Decay only while touching (accumulates eatTime, stops when fly backs off)
      if (isTouching) {
        S.eatTimeAccum += dt_;  // accumulate actual contact time
      }

      // Visual decay based on accumulated contact time
      const eatProgress = Math.min(1.0, S.eatTimeAccum / CFG.eatDuration);
      const newScale = Math.max(0.0, 0.15 * (1.0 - eatProgress));  // starts at 0.15, shrinks to 0
      S.foodTarget.scale.set(newScale, newScale, 1);
      S.foodTarget.material.opacity = 1.0 - eatProgress * 0.5;  // fade to 50% opacity

      // Debug: show contact state + accumulated time
      console.log(`[Eat] touch=${isTouching ? '✓' : '✗'} accum=${S.eatTimeAccum.toFixed(2)}/${CFG.eatDuration} progress=${(eatProgress * 100).toFixed(1)}%`);

      if (S.eatTimeAccum >= CFG.eatDuration) {
        console.log("[Food] EAT complete → cheese fully consumed, respawning at center");
        removeCheese(S.foodTarget);
        S.foodTarget = null;
        S.foodState = "search";
        S.eatTimeAccum = 0;  // reset accumulator
        onBrainEatComplete();  // ← trigger brain hunger/energy reduction
        // Respawn new cheese at center after eating
        setTimeout(() => {
          createCheese(false);
          console.log("[Cheese] Respawned at center after eating");
        }, 500);
      }
      break;
    }
  }

  // Update debug
  d.foodState = S.foodState.toUpperCase();
  d.cheeseCount = S.cheeseList.length;
}

/* ── Fly hold enforcement (called every frame) ── */
function updateFlyHold(dt, t) {
  if (!S.flyHeld) return;
  const fly = S.flyGroup;
  if (!fly) return;
  // Enforce freeze: zero velocity, tiny alive-wobble
  S.flyVel.set(0, 0, 0);
  fly.rotation.z = Math.sin(t * 8) * 0.1;
}

/* ── Animation loop ── */
let lastFrameLog = 0;
export function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(S.clock.getDelta(), 0.05);
  const t = S.clock.getElapsedTime();
  const d = S.dbg;
  d.dt = dt.toFixed(4);
  d.fps = (1 / dt).toFixed(1);

  if (!S.flyGroup) {
    S.renderer.render(S.scene, S.camera);
    return;
  }
  const fly = S.flyGroup;

  // ── Fly hold enforcement (freeze when pinch-held) ──
  updateFlyHold(dt, t);

  if (lastFrameLog < 3) {
    console.log("[Render] Frame", lastFrameLog++, "fly pos:", fly.position, "visible:", fly.visible, "scale:", fly.scale.x.toFixed(4));
  }

  // ── AnimationMixer: advance rig clip ──
  // Paused when fly held (pinched)
  const animDt = dt * (CFG.animationSpeed || 1.0);
  if (S.flyMixer && !S.flyHeld) {
    S.flyMixer.update(animDt);
    // Single clip ("Fly floating") — play continuously
    // State machine can be added when multi-clip is available
  }

  // ── Debug: hand tracking (raw landmarks only, no effects) ──
  let handSceneX = null, handSceneY = null;
  if (S.handPos2D) {
    d.handX = S.handPos2D.x.toFixed(3);
    d.handY = S.handPos2D.y.toFixed(3);
    handSceneX = (0.5 - S.handPos2D.x) * 4;
    handSceneY = (0.5 - S.handPos2D.y) * 3;
  }
  d.pinch = S.isPinching ? "YES" : "NO";

  // ── Cheese: follow pinch if held (handled by gesture pipeline) ──
  updateCheeseFollow();
  if (S.cheeseList.length > 0) {
    const ch = S.cheeseList.find((c) => c.visible) || S.cheeseList[0];
    if (ch) {
      d.cheeseGrab = S.pinchGrab ? "HOLDING" : "FREE";
      d.cheeseX = ch.position.x.toFixed(3);
      d.cheeseY = ch.position.y.toFixed(3);
    }
  } else { d.cheeseGrab = "NO CHEESE"; }

  // ── Hand tracking: raw landmarks only (no effects on fly or cheese) ──

  // ── FLY BRAIN: update drives + decide behavior ──
  driveBrain(dt, t);

  // ── Food lifecycle state machine (SEARCH / ORBIT / STRIKE / EAT) ──
  foodStateMachine(dt, t, fly);

  // ── Natural steering controller ──
  // Skip steering when fly is in reaction state that freezes it
  const isFrozen = S.flyHeld;
  if (!isFrozen) {
  // Behavior from the brain (IDLE, SEARCH_FOOD, EAT, REST, EXPLORE, ESCAPE)
  // is layered in: each behavior defines its own movement target.
  const steer = S._steer, desired = S._desired, tmp = S._tmp;
  steer.set(0, 0, 0);

  // Determine effective steering target by brain behavior
  const brainTarget = getBrainTarget(t);
  const brainBehavior = S.brain.behavior;

  // Only apply steering in SEARCH state (ORBIT/STRIKE/EAT handle their own movement)
  // brain overrides are applied when NOT in active food pursuit, or when rest/escape/explore
  const seekCheese = brainBehavior === "SEARCH_FOOD" || brainBehavior === "EAT";
  const seekRest   = brainBehavior === "REST";
  const seekExplore= brainBehavior === "EXPLORE";
  const seekEscape = brainBehavior === "ESCAPE";

  if (seekCheese && S.foodState === "search" && S.cheese && S.cheese.visible && !S.flyDisturbed) {
    // ── SEEK CHEESE (SEARCH_FOOD only — hunger gate already applied in decideBehavior) ──
      const cheesePos = S.cheese.position;
    tmp.subVectors(cheesePos, fly.position);   // direction toward cheese
    const dist = tmp.length();
    d.dist = dist.toFixed(3);

    if (dist < CFG.detectRange && dist > 0.0001) {
      // 1) desired velocity = direction * speed
      const dir = tmp.clone().normalize();
      let speed;
      if (dist > CFG.arrivalRadius) {
        // FAR/MEDIUM: full commit speed — don't brake early
        speed = CFG.maxSpeed;
        S.flyState = "approaching";
      } else {
        // NEAR: decelerate only in the final stretch (arrivalRadius → feedingDistance)
        const span = Math.max(CFG.arrivalRadius - CFG.feedingDistance, 0.001);
        const scale = Math.max(0.15, (dist - CFG.feedingDistance) / span);   // keep a minimum creep speed
        speed = CFG.maxSpeed * scale;
        S.flyState = dist <= CFG.feedingDistance + 0.04 ? "hovering" : "approaching";
      }
      desired.copy(dir).multiplyScalar(speed);

      // 2) steering force = desired − current velocity  (Reynolds arrival)
      steer.copy(desired).sub(S.flyVel);

      // 3) burst: when a chase just started (newly detected cheese), dart out fast
      const justStarted = S._lastCheeseDist > CFG.detectRange || dist > S._lastCheeseDist + 0.05;
      if (justStarted) S._chaseStart = t;
      const inBurst = (t - S._chaseStart) < CFG.burstTime;

      // 4) small direction corrections — jitter while chasing (insect-like, not dead-straight)
      if (S.flyState === "approaching" && dist > CFG.arrivalRadius) {
        const j = Math.sin(t * CFG.jitterFreq) * CFG.jitterAmp;
        const k = Math.cos(t * CFG.jitterFreq * 0.7) * CFG.jitterAmp;
        steer.x += j; steer.y += k; steer.z += j * 0.5;
      }

      // 5) clamp steering to maxForce (or burstForce right at chase start)
      const cap = inBurst ? CFG.burstForce : CFG.maxForce;
      const sl = steer.length();
      if (sl > cap) steer.multiplyScalar(cap / sl);
    } else {
      S.flyState = "idle";
    }
  } else if ((seekRest || seekExplore || seekEscape) && brainTarget && !S.flyDisturbed) {
    // ── BRAIN-DRIVEN STEERING (REST / EXPLORE / ESCAPE) ──
    tmp.subVectors(brainTarget, fly.position);
    const dist = tmp.length();
    d.dist = dist.toFixed(3);

    if (dist > 0.01) {
      const dir = tmp.clone().normalize();
      // REST: slower, gentle landing approach; ESCAPE: fast burst; EXPLORE: zippy
      let speed = CFG.maxSpeed;
      if (seekRest) speed = CFG.maxSpeed * 0.5;       // slow, deliberate
      if (seekEscape) speed = CFG.maxSpeed * 1.5;     // panic dart
      if (seekExplore) speed = CFG.maxSpeed * 1.1;    // zippy house-fly buzzing

      // Smooth landing: gradual slowdown within arrival radius
      const arrivalRadius = 0.35; // larger radius = earlier deceleration
      if (dist < arrivalRadius) {
        const span = Math.max(arrivalRadius - 0.05, 0.001);
        const scale = Math.max(0.08, (dist - 0.05) / span);
        speed *= scale;  // gradual arrival slowdown
      }

      desired.copy(dir).multiplyScalar(speed);
      steer.copy(desired).sub(S.flyVel);
      steer.clampLength(0, seekEscape ? CFG.burstForce : CFG.maxForce * 0.9);
      S.flyState = seekEscape ? "escaping" : seekRest ? "resting" : "exploring";

      // Check landing: REST or EXPLORE + very close to target → land
      if ((seekRest || seekExplore) && dist < 0.12) {
        S.brain.isLanded = true;
        S.brain.landStart = t;
        S.flyVel.multiplyScalar(0.15);  // gentle stop

        console.log("[Brain] LANDED at home (", S.brain.behavior, ")");
      }
    }
  } else {
    // No cheese / idle without target: drift back home gently with a soft spring
    if (S.flyDisturbed) {
      S.flyState = "disturbed";
    } else {
      S.flyState = "idle";
      tmp.subVectors(S.flyHome, fly.position);
      steer.copy(tmp).multiplyScalar(CFG.recoverySpring * CFG.maxForce * 0.15);
      const sl = steer.length();
      if (sl > CFG.maxForce * 0.4) steer.multiplyScalar(CFG.maxForce * 0.4 / sl);
    }
  }

  // 4) integrate: velocity += steering (acceleration); clamp to maxSpeed
  // SEARCH_FOOD, REST, EXPLORE, ESCAPE apply steering; ORBIT/STRIKE/EAT already applied steering forces
  // If LANDED, skip physics entirely
  const isLanded = S.brain.isLanded;
  if (!isLanded && (S.foodState === "search" || S.flyDisturbed || seekRest || seekExplore || seekEscape)) {
    S.flyVel.addScaledVector(steer, dt);
    const vlen = S.flyVel.length();
    if (vlen > CFG.maxSpeed) S.flyVel.multiplyScalar(CFG.maxSpeed / vlen);
  }

  // 5) drag/friction — frame-rate corrected (drag^(dt*60))
  const dragFactor = Math.pow(CFG.drag, dt * 60);
  S.flyVel.multiplyScalar(dragFactor);

  // 6) integrate position + HARD boundary clamp — skip if LANDED
  if (!isLanded) {
    fly.position.addScaledVector(S.flyVel, dt);

    // Hard boundary clamp — fly cannot escape camera view (uses computed frustum bounds)
    const b = S.frustumBounds;
    fly.position.x = THREE.MathUtils.clamp(fly.position.x, b.minX, b.maxX);
    fly.position.y = THREE.MathUtils.clamp(fly.position.y, b.minY, b.maxY);
    fly.position.z = THREE.MathUtils.clamp(fly.position.z, b.minZ, b.maxZ);

    // If clamped, bounce velocity slightly off the wall
    const tolerance = 0.01;
    if (Math.abs(fly.position.x - b.minX) < tolerance || Math.abs(fly.position.x - b.maxX) < tolerance) {
      S.flyVel.x *= -0.3;
    }
    if (Math.abs(fly.position.y - b.minY) < tolerance || Math.abs(fly.position.y - b.maxY) < tolerance) {
      S.flyVel.y *= -0.3;
    }
    if (Math.abs(fly.position.z - b.minZ) < tolerance || Math.abs(fly.position.z - b.maxZ) < tolerance) {
      S.flyVel.z *= -0.3;
    }
  }

  // 7) natural idle motion: gentle hover bob + tiny random drift
  // (only in search/idle, not during orbit/strike/eat or landed)
  if (S.foodState === "search" && !isLanded) {
    S._driftPhase += dt * CFG.hoverFreq * Math.PI * 2;
    S._driftPhase2 += dt * 0.41 * Math.PI * 2;
    // hover bob (y) — subtle sine
    const bobY = Math.sin(S._driftPhase) * CFG.hoverAmp * dt;
    fly.position.y += bobY;
    // random drift (x/z) — two out-of-phase sines = pseudo-random wander
    const driftX = Math.sin(S._driftPhase2) * CFG.driftAmp * dt;
    const driftZ = Math.cos(S._driftPhase * 0.63) * CFG.driftAmp * dt;
    if (!S.flyDisturbed && S.flyState !== "approaching") {
      fly.position.x += driftX;
      fly.position.z += driftZ;
    }
  }

  // 8) release disturbance flag after a delay
  if (S.flyDisturbed && t - S.disturbTime > CFG.handDisturbRecoverTime) S.flyDisturbed = false;

  // ── Smooth rotation: face velocity dir (approaching) or cheese (feeding) ──
  // ORBIT/STRIKE/EAT handle rotation themselves
  if (S.foodState === "search" || S.flyDisturbed) {
    const spd = S.flyVel.length();
    let targetYaw = fly.rotation.y;
    if (S.flyState === "hovering" && S.cheese && S.cheese.visible) {
      // FACING: when hovering, face the cheese
      tmp.subVectors(S.cheese.position, fly.position);
      targetYaw = Math.atan2(tmp.x, tmp.z);
    } else if (spd > 0.02) {
      targetYaw = Math.atan2(S.flyVel.x, S.flyVel.z);
    }
    // smooth yaw (delayed turn — not instant)
    const yawDelta = targetYaw - fly.rotation.y;
    fly.rotation.y += yawDelta * Math.min(1, dt * 6);
    // bank/pitch from lateral velocity (flying feel)
    fly.rotation.z = THREE.MathUtils.lerp(fly.rotation.z, -S.flyVel.x * 0.4, Math.min(1, dt * 4));
    fly.rotation.x = THREE.MathUtils.lerp(fly.rotation.x, -S.flyVel.y * 0.3, Math.min(1, dt * 4));
  }

  } // end !isFrozen (steering block)

  // ── Debug overlay update ──
  d.flyX = fly.position.x.toFixed(3);
  d.flyY = fly.position.y.toFixed(3);
  d.flyZ = fly.position.z.toFixed(3);
  d.state = S.flyState;
  d.targetDistance = d.dist;
  d.currentSpeed = S.flyVel.length().toFixed(3);
  d.flyVelocity = `${S.flyVel.x.toFixed(2)}, ${S.flyVel.y.toFixed(2)}, ${S.flyVel.z.toFixed(2)}`;
  // track last distance for burst detection
  { const v = parseFloat(d.dist); if (Number.isFinite(v) && v > 0.001) S._lastCheeseDist = v; }
  // Animation debug: FPS, mixer delta, timeScale
  d.animDt = (dt * (CFG.animationSpeed || 1.0)).toFixed(4);
  d.animSpeed = CFG.animationSpeed.toFixed(2);
  d.timeScale = S.flyActions[Object.keys(S.flyActions)[0]]?.timeScale ?? 1.0;
  // Brain debug
  {
    const b = S.brain;
    d.brainBehavior = b.behavior;
    d.brainHunger = b.hunger.toFixed(1);
    d.brainEnergy = b.energy.toFixed(1);
    d.brainCuriosity = b.curiosity.toFixed(1);
    d.brainFear = b.fear.toFixed(1);
    d.brainComfort = b.comfort.toFixed(1);
    updateBrainPanel();
  }
  if (lastFrameLog <= 3) console.log("[Debug]", d);

  S.renderer.render(S.scene, S.camera);
}

/* ── Debug overlay (console) ── */
/* ── Brain debug panel (HTML overlay) ── */
function updateBrainPanel() {
  const el = $("brain-panel");
  if (!el) return;
  const b = S.brain;
  const bar = (v) => `<div class="brain-bar"><div class="brain-fill" style="width:${v.toFixed(1)}%"></div><span>${v.toFixed(1)}%</span></div>`;
  const handLabel    = S.handDetected ? "Detected" : "Not detected";
  const handClass    = S.handDetected ? "ok" : "warn";
  const gestureLabel = S.gesture;
  const cheeseLabel  = S.pinchGrab ? "Grabbed" : "Idle";
  const flyLabel     = S.flyHeld ? "Held" : "Normal";

  el.innerHTML = `
    <div><b>🧠 Brain State</b></div>
    <div class="brain-label">Hunger: ${bar(b.hunger)}</div>
    <div class="brain-label">Energy: ${bar(b.energy)}</div>
    <div class="brain-label">Curiosity: ${bar(b.curiosity)}</div>
    <div class="brain-label">Fear: ${bar(b.fear)}</div>
    <div class="brain-label">Comfort: ${bar(b.comfort)}</div>
    <div class="brain-behavior"><b>Behavior:</b> ${b.behavior}${b.isLanded ? " (LANDED)" : ""}</div>

    <div style="margin-top:12px; padding-top:8px; border-top:1px solid rgba(255,255,255,0.1)">
      <div><b>Debug</b></div>
      <div class="${handClass}"><b>Hand:</b> ${handLabel}</div>
      <div><b>Gesture:</b> ${gestureLabel}</div>
      <div><b>Cheese:</b> ${cheeseLabel}</div>
      <div><b>Fly:</b> ${flyLabel}</div>
    </div>
  `;
}

function startDebugLoop() {
  setInterval(() => {
    console.log("[DBG] hand:", S.dbg.handX, S.dbg.handY,
      "| pinch:", S.dbg.pinch,
      "| cheeseGrab:", S.dbg.cheeseGrab,
      "| cheese:", S.dbg.cheeseX, S.dbg.cheeseY,
      "| fly:", S.dbg.flyX, S.dbg.flyY, S.dbg.flyZ,
      "| dist:", S.dbg.dist,
      "| targetDist:", S.dbg.targetDistance,
      "| speed:", S.dbg.currentSpeed,
      "| vel:", S.dbg.flyVelocity,
      "| state:", S.dbg.state,
      "| foodState:", S.dbg.foodState,
      "| cheeseCount:", S.dbg.cheeseCount,
      "| animDt:", S.dbg.animDt,
      "| animSpeed:", S.dbg.animSpeed,
      "| timeScale:", S.dbg.timeScale);
  }, 2000);
}

/* ── FPS counter ── */
let frameCount = 0, lastFpsTime = performance.now();
function fpsLoop() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime > 1000) {
    $("status-fps").textContent = `${frameCount} fps`;
    frameCount = 0; lastFpsTime = now;
  }
  requestAnimationFrame(fpsLoop);
}

/* ── Init ── */
async function init() {
  console.log("[Init] Starting...");
  console.log("[Init] Three.js:", THREE.REVISION);
  console.log("[Init] WebGL:", !!window.WebGLRenderingContext);
  console.log("[Init] Hands:", typeof Hands, typeof Camera);

  const hasCamera = await setupCamera();
  const hasScene = setupScene();
  const hasFly = await loadFly();
  createCheese();
  setupHands();
  await setupNeuPrint();

  console.log("[Init] Results:", { hasCamera, hasScene, hasFly: !!hasFly });
  animate();
  fpsLoop();
  startDebugLoop();
  console.log("[Init] Done, animation running");
}
init();

/* ── neuPrint test helper (accessible from browser console) ── */
if (typeof window !== "undefined") {
  window.testNeuPrintBias = (bodyPart) => {
    console.log("[Test] Forcing neuPrint bias to:", bodyPart);
    applyNeuPrintBias({ preferBodyPart: bodyPart });
  };
  window.clearNeuPrintBias = () => {
    S._neuPrintBias = null;
    console.log("[Test] Cleared neuPrint bias");
  };
  console.log("[Test] Available: testNeuPrintBias('hand'), clearNeuPrintBias()");
}



