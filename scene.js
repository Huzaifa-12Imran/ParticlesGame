import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { float, vec3, color, smoothstep, normalWorld, mix, positionWorld, time, sin, cos } from 'three/tsl';

// ── Scene ──
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9d1e9); // fallback, replaced by Sky

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 40, 50);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGPURenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const root = document.getElementById('root') ?? document.body;
root.appendChild(renderer.domElement);
await renderer.init();

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 5, 0);
controls.minDistance = 15;
controls.maxDistance = 80;

// ── Lighting ──
const ambient = new THREE.AmbientLight(0x304060, 1.0);
ambient.name = 'ambientLight';
scene.add(ambient);

const dirLight = new THREE.DirectionalLight(0xddeeff, 1.8);
dirLight.name = 'dirLight';
dirLight.position.set(10, 25, 12);
dirLight.castShadow = true;
dirLight.shadow.mapSize.set(1536, 1536);
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 60;
dirLight.shadow.camera.left = -30;
dirLight.shadow.camera.right = 30;
dirLight.shadow.camera.top = 30;
dirLight.shadow.camera.bottom = -30;
dirLight.shadow.bias = -0.001;
dirLight.shadow.normalBias = 0.02;
scene.add(dirLight);

const rimLight = new THREE.DirectionalLight(0x4488ff, 0.4);
rimLight.name = 'rimLight';
rimLight.position.set(-8, 5, -10);
scene.add(rimLight);

// ── Procedural Sky ──
const sky = new Sky();
sky.name = 'sky';
sky.scale.setScalar(450000);
scene.add(sky);

const skyUniforms = sky.material.uniforms;
skyUniforms['turbidity'].value = 2;
skyUniforms['rayleigh'].value = 1.5;
skyUniforms['mieCoefficient'].value = 0.005;
skyUniforms['mieDirectionalG'].value = 0.8;

const sunPosition = new THREE.Vector3();
const phi = THREE.MathUtils.degToRad(90 - 35); // elevation 35°
const theta = THREE.MathUtils.degToRad(160);
sunPosition.setFromSphericalCoords(1, phi, theta);
skyUniforms['sunPosition'].value.copy(sunPosition);

// Align directional light with the sun
dirLight.position.copy(sunPosition).multiplyScalar(25);

// ── Config ──
const BOUNDS = { x: 24, z: 24 };
const MAX_PARTICLES = 20000;
let PARTICLE_COUNT = 12000;
let GRAVITY = -0.0095;
let DAMPING = 0.997;
const FLOOR_Y = 0.15;
const PARTICLE_RADIUS = 0.18;
const HASH_CELL = 0.8;
let PARTICLE_LIFETIME = 9;
let WIND_X = 0;
let WIND_Z = 0;

// ── Game state ──
let score = 0;
let totalCaptured = 0;
let spilledParticles = 0;
let levelIndex = 0;
let isPlaying = false;
let levelTime = 0;
let bestTimes = new Array(10).fill(Infinity);
let failCount = 0; // Track consecutive fails on the same level

// ── Web Audio ──
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function playTone(freq, type, duration, gainVal = 0.18, delay = 0) {
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, audioCtx.currentTime + delay);
    gain.gain.setValueAtTime(gainVal, audioCtx.currentTime + delay);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + delay + duration);
    osc.start(audioCtx.currentTime + delay);
    osc.stop(audioCtx.currentTime + delay + duration);
  } catch(e) {}
}

function playCaptureSound() {
  playTone(880, 'sine', 0.08, 0.07);
  playTone(1320, 'sine', 0.06, 0.04, 0.04);
}

function playWinSound() {
  [523, 659, 784, 1047].forEach((f, i) => playTone(f, 'sine', 0.25, 0.15, i * 0.1));
}

function playFailSound() {
  playTone(220, 'sawtooth', 0.18, 0.12);
  playTone(150, 'sawtooth', 0.25, 0.1, 0.12);
}

// ── Confetti ──
let confettiCanvas = null;
let confettiCtx = null;
let confettiParticles = [];
let confettiRunning = false;

function initConfettiCanvas() {
  if (confettiCanvas) return;
  confettiCanvas = document.createElement('canvas');
  confettiCanvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:999;';
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
  document.body.appendChild(confettiCanvas);
  confettiCtx = confettiCanvas.getContext('2d');
}

function launchConfetti() {
  initConfettiCanvas();
  const colors = ['#c4714a','#ffaa33','#7a9e7e','#e8dcc8','#a85a38','#5a7a5e','#ffcc66','#d4835e'];
  confettiParticles = [];
  for (let i = 0; i < 160; i++) {
    confettiParticles.push({
      x: Math.random() * confettiCanvas.width,
      y: Math.random() * confettiCanvas.height * 0.4 - 20,
      vx: (Math.random() - 0.5) * 5,
      vy: Math.random() * 4 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      size: Math.random() * 8 + 4,
      rotation: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.2,
      life: 1.0,
      decay: 0.008 + Math.random() * 0.006,
    });
  }
  confettiRunning = true;
  animateConfetti();
}

function animateConfetti() {
  if (!confettiRunning || confettiParticles.length === 0) {
    if (confettiCtx) confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    confettiRunning = false;
    return;
  }
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  confettiParticles = confettiParticles.filter(p => p.life > 0);
  for (const p of confettiParticles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12;
    p.vx *= 0.99;
    p.rotation += p.rotSpeed;
    p.life -= p.decay;
    confettiCtx.save();
    confettiCtx.globalAlpha = Math.max(0, p.life);
    confettiCtx.translate(p.x, p.y);
    confettiCtx.rotate(p.rotation);
    confettiCtx.fillStyle = p.color;
    confettiCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    confettiCtx.restore();
  }
  requestAnimationFrame(animateConfetti);
}

// ── Particle data ──
const positions = new Float32Array(MAX_PARTICLES * 3);
const velocities = new Float32Array(MAX_PARTICLES * 3);
const colors = new Float32Array(MAX_PARTICLES * 3);
const lifetimes = new Float32Array(MAX_PARTICLES);

const colorA = new THREE.Color(0x00bfff);
const colorB = new THREE.Color(0x0044cc);
const colorC = new THREE.Color(0x88ddff);

function resetParticles() {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const i3 = i * 3;
    positions[i3] = 9999;
    positions[i3 + 1] = -10;
    positions[i3 + 2] = 9999;
    velocities[i3] = 0;
    velocities[i3 + 1] = 0;
    velocities[i3 + 2] = 0;
    lifetimes[i] = 0;
    const t = Math.random();
    const c = t < 0.5 ? colorA.clone().lerp(colorB, t * 2) : colorB.clone().lerp(colorC, (t - 0.5) * 2);
    colors[i3] = c.r;
    colors[i3 + 1] = c.g;
    colors[i3 + 2] = c.b;
  }
}
resetParticles();

// ── InstancedMesh for particles ──
const sphereGeo = new THREE.SphereGeometry(PARTICLE_RADIUS, 5, 4);
// Shared geometry for falling-into-hole particles
const fallingSphereGeo = new THREE.SphereGeometry(PARTICLE_RADIUS, 5, 4);
const fallingParticleMat = new THREE.MeshStandardNodeMaterial();
fallingParticleMat.colorNode = mix(color(0x0066cc), color(0x66ccff), smoothstep(float(0.3), float(1.0), normalWorld.y));
fallingParticleMat.roughnessNode = float(0.3);
fallingParticleMat.metalnessNode = float(0.6);

// InstancedMesh for falling particles inside the hole
const MAX_FALLING = 200;
const fallingInstanced = new THREE.InstancedMesh(fallingSphereGeo, fallingParticleMat, MAX_FALLING);
fallingInstanced.count = 0;
fallingInstanced.name = 'fallingParticles';
scene.add(fallingInstanced);
const particleMat = new THREE.MeshStandardNodeMaterial();
particleMat.roughnessNode = float(0.3);
particleMat.metalnessNode = float(0.6);
const topHighlight = smoothstep(float(0.3), float(1.0), normalWorld.y);
particleMat.colorNode = mix(color(0x0066cc), color(0x66ccff), topHighlight);

const instancedParticles = new THREE.InstancedMesh(sphereGeo, particleMat, PARTICLE_COUNT);
instancedParticles.count = 0;
instancedParticles.name = 'fluidParticles';
instancedParticles.castShadow = true;
instancedParticles.receiveShadow = true;
const colorSlice = new Float32Array(PARTICLE_COUNT * 3);
colorSlice.set(colors.subarray(0, PARTICLE_COUNT * 3));
instancedParticles.instanceColor = new THREE.InstancedBufferAttribute(colorSlice, 3);
scene.add(instancedParticles);

const dummy = new THREE.Object3D();

// ── Obstacles ──
const obstacles = [];
const playerObstacles = []; // obstacles the player can move/rotate
const movingObstacles = []; // obstacles that oscillate automatically
const obstacleMeshes = new THREE.Group();
obstacleMeshes.name = 'obstacleGroup';
scene.add(obstacleMeshes);

function createObstacleMaterial(clr = 0xcccccc) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const base = color(clr);
  const top = smoothstep(float(0.4), float(1.0), normalWorld.y);
  mat.colorNode = mix(base, color(0xffffff), top);
  mat.roughnessNode = float(0.35);
  mat.metalnessNode = float(0.15);
  return mat;
}

function createPlayerMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const base = color(0x33aaff);
  const top = smoothstep(float(0.3), float(1.0), normalWorld.y);
  mat.colorNode = mix(base, color(0x88ddff), top);
  mat.roughnessNode = float(0.25);
  mat.metalnessNode = float(0.3);
  return mat;
}

function createAcceleratorMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const base = color(0xffaa33);
  const top = smoothstep(float(0.3), float(1.0), normalWorld.y);
  mat.colorNode = mix(base, color(0xffcc66), top);
  mat.roughnessNode = float(0.2);
  mat.metalnessNode = float(0.1);
  return mat;
}

function createRedirectorMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const base = color(0xe05080);
  const top = smoothstep(float(0.3), float(1.0), normalWorld.y);
  mat.colorNode = mix(base, color(0xff88aa), top);
  mat.roughnessNode = float(0.2);
  mat.metalnessNode = float(0.2);
  return mat;
}

function addObstacle(type, x, z, params, isPlayer = false) {
  let geometry, mesh, obstacle;
  let mat;
  if (type === 'accelerator') mat = createAcceleratorMaterial();
  else if (type === 'redirector') mat = createRedirectorMaterial();
  else mat = isPlayer ? createPlayerMaterial() : createObstacleMaterial(params.color || 0xcccccc);

  if (type === 'ramp' || type === 'accelerator' || type === 'redirector') {
    const w = params.width || 6;
    const h = params.height || 0.35;
    const d = params.depth || 3;
    const elev = params.elevation || 6;
    const rotX = params.rotX || 0;
    const rotY = params.rotY || 0;
    const rotZ = params.rotZ || 0;
    geometry = new THREE.BoxGeometry(w, h, d);
    mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, elev, z);
    mesh.rotation.set(rotX, rotY, rotZ);
    mesh.updateMatrixWorld(true);
    obstacle = { type, x, z, width: w, height: h, depth: d, elevation: elev, rotX, rotY, rotZ, mesh, isPlayer };
  } else if (type === 'cylinder') {
    const r = params.radius || 1.5;
    const h = params.height || 3;
    geometry = new THREE.CylinderGeometry(r, r, h, 16);
    mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, h / 2 + FLOOR_Y, z);
    obstacle = { type: 'cylinder', x, z, radius: r, height: h, mesh, isPlayer };
  } else if (type === 'box') {
    const w = params.width || 2;
    const h = params.height || 3;
    const d = params.depth || 2;
    geometry = new THREE.BoxGeometry(w, h, d);
    mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, h / 2 + FLOOR_Y, z);
    obstacle = { type: 'box', x, z, hw: w / 2, hd: d / 2, height: h, mesh, isPlayer };
  } else if (type === 'sphere') {
    const r = params.radius || 1.5;
    geometry = new THREE.SphereGeometry(r, 16, 12);
    mesh = new THREE.Mesh(geometry, mat);
    mesh.position.set(x, r + FLOOR_Y, z);
    obstacle = { type: 'sphere', x, z, radius: r, mesh, isPlayer };
  }

  mesh.name = `obstacle_${obstacles.length}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.obstacleIndex = obstacles.length;

  // Optional movement behavior (oscillating hazards) for higher difficulty levels
  if (params.moving) {
    obstacle.moving = true;
    obstacle.moveAxis = params.moveAxis || 'x';
    obstacle.moveRange = params.moveRange || 3;
    obstacle.moveSpeed = params.moveSpeed || 1;
    obstacle.baseX = x;
    obstacle.baseZ = z;
    obstacle.movePhase = Math.random() * Math.PI * 2;
  }

  obstacleMeshes.add(mesh);
  obstacles.push(obstacle);
  if (isPlayer) playerObstacles.push(obstacle);
  return obstacle;
}

// ── Exit hole (goal) ──
let exitHole = null;
let exitMesh = null;
let exitRingMesh = null;
let exitGlowMesh = null;

// Extra meshes for the 3D hole
let exitTubeMesh = null;
let exitBottomMesh = null;
let exitInnerGlowMesh = null;
const fallingParticles = []; // particles visually falling into the hole
const HOLE_DEPTH = 5;

function createExitHole(x, z, radius) {
  // Remove old
  if (exitMesh) scene.remove(exitMesh);
  if (exitRingMesh) scene.remove(exitRingMesh);
  if (exitGlowMesh) scene.remove(exitGlowMesh);
  if (exitTubeMesh) scene.remove(exitTubeMesh);
  if (exitBottomMesh) scene.remove(exitBottomMesh);
  if (exitInnerGlowMesh) scene.remove(exitInnerGlowMesh);
  const oldHoleLight = scene.getObjectByName('holeLight');
  if (oldHoleLight) scene.remove(oldHoleLight);

  exitHole = { x, z, radius, y: FLOOR_Y };
  fallingParticles.length = 0;

  // Recreate ground with hole cut out
  createGroundWithHole(x, z, radius);

  // Dark hole disc at the bottom of the tube
  const bottomGeo = new THREE.CircleGeometry(radius, 32);
  const bottomMat = new THREE.MeshStandardNodeMaterial();
  bottomMat.colorNode = color(0x000204);
  bottomMat.emissiveNode = color(0x000000);
  bottomMat.roughnessNode = float(1.0);
  exitBottomMesh = new THREE.Mesh(bottomGeo, bottomMat);
  exitBottomMesh.name = 'exitBottom';
  exitBottomMesh.rotation.x = -Math.PI / 2;
  exitBottomMesh.position.set(x, FLOOR_Y - HOLE_DEPTH, z);
  scene.add(exitBottomMesh);

  // Inner tube wall (open-ended cylinder, inside faces visible)
  const tubeGeo = new THREE.CylinderGeometry(radius, radius, HOLE_DEPTH, 32, 16, true);
  const tubeMat = new THREE.MeshStandardNodeMaterial();
  // Vertical gradient: lighter at the top rim, darker at the bottom
  const tubeGradient = smoothstep(float(-0.5), float(0.8), normalWorld.y);
  const baseColor = mix(color(0x080e1a), color(0x3a5a8c), tubeGradient);

  // Animated caustic/ripple pattern using layered sin waves on world position + time
  const wp = positionWorld;
  const t = time.mul(1.8);
  // Layer 1: large ripple
  const caustic1 = sin(wp.x.mul(3.0).add(wp.z.mul(2.5)).add(t)).mul(0.5).add(0.5);
  // Layer 2: smaller ripple, offset phase
  const caustic2 = sin(wp.x.mul(5.2).sub(wp.z.mul(4.1)).add(t.mul(1.3))).mul(0.5).add(0.5);
  // Layer 3: vertical wave for depth variation
  const caustic3 = sin(wp.y.mul(4.0).add(wp.x.mul(2.0)).add(t.mul(0.7))).mul(0.5).add(0.5);
  // Combine layers with multiplication for caustic-like interference
  const causticPattern = caustic1.mul(caustic2).mul(caustic3);
  // Fade caustics toward the bottom (stronger near top where light enters)
  const causticFade = smoothstep(float(-0.8), float(0.6), normalWorld.y);
  const causticColor = color(0x44aadd).mul(causticPattern).mul(causticFade).mul(0.15);

  tubeMat.colorNode = baseColor.add(causticColor);
  const baseEmissive = mix(color(0x020408), color(0x142038), tubeGradient);
  // Add subtle emissive caustic glow
  const emissiveCaustic = color(0x2288bb).mul(causticPattern).mul(causticFade).mul(0.08);
  tubeMat.emissiveNode = baseEmissive.add(emissiveCaustic);
  tubeMat.roughnessNode = float(0.5);
  tubeMat.metalnessNode = float(0.3);
  tubeMat.side = THREE.DoubleSide; // render both sides so visible from above
  exitTubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
  exitTubeMesh.name = 'exitTube';
  exitTubeMesh.position.set(x, FLOOR_Y - HOLE_DEPTH / 2, z);
  scene.add(exitTubeMesh);

  // Inner glow volume (slightly smaller, additive-looking)
  const innerGlowGeo = new THREE.CylinderGeometry(radius * 0.85, radius * 0.6, HOLE_DEPTH * 0.8, 32, 1, true);
  const innerGlowMat = new THREE.MeshStandardNodeMaterial();
  innerGlowMat.colorNode = color(0x101828);
  innerGlowMat.emissiveNode = color(0x081020);
  innerGlowMat.transparent = true;
  innerGlowMat.opacity = 0.2;
  innerGlowMat.side = THREE.DoubleSide;
  exitInnerGlowMesh = new THREE.Mesh(innerGlowGeo, innerGlowMat);
  exitInnerGlowMesh.name = 'exitInnerGlow';
  exitInnerGlowMesh.position.set(x, FLOOR_Y - HOLE_DEPTH * 0.45, z);
  scene.add(exitInnerGlowMesh);

  // Point light inside the hole for illumination
  const holeLight = new THREE.PointLight(0x44aadd, 2.0, HOLE_DEPTH * 3);
  holeLight.name = 'holeLight';
  holeLight.position.set(x, FLOOR_Y - HOLE_DEPTH * 0.3, z);
  scene.add(holeLight);

  // No top disc needed — hole is cut into the ground geometry
  exitMesh = null;

  // Glowing ring around the hole edge
  const ringGeo = new THREE.TorusGeometry(radius, 0.08, 12, 48);
  const ringMat = new THREE.MeshStandardNodeMaterial();
  ringMat.colorNode = color(0x44ff88);
  ringMat.emissiveNode = color(0x22ff66);
  ringMat.roughnessNode = float(0.2);
  exitRingMesh = new THREE.Mesh(ringGeo, ringMat);
  exitRingMesh.name = 'exitRing';
  exitRingMesh.rotation.x = -Math.PI / 2;
  exitRingMesh.position.set(x, FLOOR_Y + 0.05, z);
  scene.add(exitRingMesh);

  // Outer glow disc (subtle dark, no green)
  const glowGeo = new THREE.CircleGeometry(radius + 1.2, 32);
  const glowMat = new THREE.MeshStandardNodeMaterial();
  glowMat.colorNode = color(0x0a1020);
  glowMat.emissiveNode = color(0x040810);
  glowMat.transparent = true;
  glowMat.opacity = 0.15;
  exitGlowMesh = new THREE.Mesh(glowGeo, glowMat);
  exitGlowMesh.name = 'exitGlow';
  exitGlowMesh.rotation.x = -Math.PI / 2;
  exitGlowMesh.position.set(x, FLOOR_Y + 0.01, z);
  scene.add(exitGlowMesh);
}

// ── Emitter source ──
let emitterPos = { x: 0, y: 15, z: 0 };
let emitterMesh = null;

function createEmitter(x, y, z) {
  if (emitterMesh) scene.remove(emitterMesh);
  emitterPos = { x, y, z };

  const geo = new THREE.SphereGeometry(0.6, 12, 8);
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = color(0x4488ff);
  mat.emissiveNode = color(0x2244aa);
  mat.roughnessNode = float(0.2);
  emitterMesh = new THREE.Mesh(geo, mat);
  emitterMesh.name = 'emitter';
  emitterMesh.position.set(x, y, z);
  scene.add(emitterMesh);
}

// ── Walls (thin transparent) ──
const wallMat = new THREE.MeshStandardNodeMaterial();
wallMat.colorNode = color(0x2244aa);
wallMat.roughnessNode = float(0.5);
wallMat.metalnessNode = float(0.2);
wallMat.transparent = true;
wallMat.opacity = 0.12;

const wallThick = 0.3;
const wallH = 8;
const wallMeshes = [];

function createWalls() {
  wallMeshes.forEach(w => scene.remove(w));
  wallMeshes.length = 0;
  const wallData = [
    { w: BOUNDS.x * 2 + wallThick, d: wallThick, x: 0, z: -BOUNDS.z },
    { w: BOUNDS.x * 2 + wallThick, d: wallThick, x: 0, z: BOUNDS.z },
    { w: wallThick, d: BOUNDS.z * 2 + wallThick, x: -BOUNDS.x, z: 0 },
    { w: wallThick, d: BOUNDS.z * 2 + wallThick, x: BOUNDS.x, z: 0 },
  ];
  wallData.forEach((wd, i) => {
    const geo = new THREE.BoxGeometry(wd.w, wallH, wd.d);
    const wall = new THREE.Mesh(geo, wallMat);
    wall.name = `wall_${i}`;
    wall.position.set(wd.x, wallH / 2 + FLOOR_Y, wd.z);
    wall.receiveShadow = true;
    scene.add(wall);
    wallMeshes.push(wall);
  });
}
createWalls();

// ── Ground (with hole support) ──
let ground = null;
const groundMat = new THREE.MeshStandardNodeMaterial();
groundMat.colorNode = color(0x101828);
groundMat.roughnessNode = float(0.85);
groundMat.metalnessNode = float(0.1);

function createGroundWithHole(holeX, holeZ, holeRadius) {
  if (ground) scene.remove(ground);

  const gw = BOUNDS.x * 2 + 2;
  const gh = BOUNDS.z * 2 + 2;
  const segs = 120; // higher resolution for cleaner hole edge

  const baseGeo = new THREE.PlaneGeometry(gw, gh, segs, segs);
  baseGeo.rotateX(-Math.PI / 2);
  const posAttr = baseGeo.attributes.position;

  // Snap vertices near the hole edge to the exact circle for a clean rim
  const snapMargin = (gw / segs) * 1.2; // slightly larger than one cell
  for (let v = 0; v < posAttr.count; v++) {
    const vx = posAttr.getX(v);
    const vz = posAttr.getZ(v);
    const dx = vx - holeX;
    const dz = vz - holeZ;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // Push vertices that are inside the hole but close to the edge outward onto the rim
    if (dist < holeRadius && dist > holeRadius - snapMargin) {
      const scale = holeRadius / dist;
      posAttr.setX(v, holeX + dx * scale);
      posAttr.setZ(v, holeZ + dz * scale);
    }
  }
  posAttr.needsUpdate = true;

  // Remove triangles where ANY vertex is inside the hole (not just centroid)
  const indices = baseGeo.index.array;
  const newIndices = [];
  const r2 = holeRadius * holeRadius * 0.97; // slightly smaller threshold to keep rim triangles
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i], b = indices[i + 1], c = indices[i + 2];
    // Check if any vertex is inside the hole
    const ax = posAttr.getX(a) - holeX, az = posAttr.getZ(a) - holeZ;
    const bx = posAttr.getX(b) - holeX, bz = posAttr.getZ(b) - holeZ;
    const cx = posAttr.getX(c) - holeX, cz = posAttr.getZ(c) - holeZ;
    const aIn = ax * ax + az * az < r2;
    const bIn = bx * bx + bz * bz < r2;
    const cIn = cx * cx + cz * cz < r2;
    // Skip triangle if any vertex is inside the hole
    if (aIn || bIn || cIn) continue;
    newIndices.push(a, b, c);
  }
  baseGeo.setIndex(newIndices);
  baseGeo.computeVertexNormals();

  ground = new THREE.Mesh(baseGeo, groundMat);
  ground.name = 'ground';
  ground.position.y = FLOOR_Y - 0.01;
  ground.receiveShadow = true;
  scene.add(ground);
}

// Create initial ground without hole
createGroundWithHole(9999, 9999, 0);



// ── Rotation helper (ring) for selected obstacle ──
let selectedObstacle = null;
let rotationHelper = null;
let rotationRing = null;
let isRotating = false;
let rotStartAngle = 0;
let obsStartRotY = 0;

function createRotationHelper() {
  const group = new THREE.Group();
  group.name = 'rotationHelper';

  // Y-axis ring (green) — thinner tube for easier picking of the object
  const ringGeoY = new THREE.TorusGeometry(2.5, 0.06, 12, 48);
  const ringMatY = new THREE.MeshStandardNodeMaterial();
  ringMatY.colorNode = color(0x44ff88);
  ringMatY.emissiveNode = color(0x22aa44);
  ringMatY.roughnessNode = float(0.2);
  const ringY = new THREE.Mesh(ringGeoY, ringMatY);
  ringY.name = 'rotRingY';
  ringY.rotation.x = Math.PI / 2;
  group.add(ringY);

  // X-axis ring (red) — thinner
  const ringGeoX = new THREE.TorusGeometry(2.5, 0.06, 12, 48);
  const ringMatX = new THREE.MeshStandardNodeMaterial();
  ringMatX.colorNode = color(0xff4466);
  ringMatX.emissiveNode = color(0xaa2233);
  ringMatX.roughnessNode = float(0.2);
  const ringX = new THREE.Mesh(ringGeoX, ringMatX);
  ringX.name = 'rotRingX';
  ringX.rotation.y = Math.PI / 2;
  group.add(ringX);

  // Z-axis ring (blue) — thinner
  const ringGeoZ = new THREE.TorusGeometry(2.5, 0.06, 12, 48);
  const ringMatZ = new THREE.MeshStandardNodeMaterial();
  ringMatZ.colorNode = color(0x4488ff);
  ringMatZ.emissiveNode = color(0x2244aa);
  ringMatZ.roughnessNode = float(0.2);
  const ringZ = new THREE.Mesh(ringGeoZ, ringMatZ);
  ringZ.name = 'rotRingZ';
  group.add(ringZ);

  // Arrow indicators
  const arrowGeo = new THREE.ConeGeometry(0.25, 0.6, 8);
  const arrowMatG = new THREE.MeshStandardNodeMaterial();
  arrowMatG.colorNode = color(0x44ff88);
  arrowMatG.emissiveNode = color(0x22aa44);
  const arrow1 = new THREE.Mesh(arrowGeo, arrowMatG);
  arrow1.name = 'arrowG1';
  arrow1.position.set(2.5, 0, 0);
  arrow1.rotation.z = -Math.PI / 2;
  group.add(arrow1);
  const arrow2 = new THREE.Mesh(arrowGeo, arrowMatG.clone());
  arrow2.name = 'arrowG2';
  arrow2.position.set(-2.5, 0, 0);
  arrow2.rotation.z = Math.PI / 2;
  group.add(arrow2);

  group.visible = false;
  scene.add(group);
  return group;
}

rotationHelper = createRotationHelper();

function selectObstacle(obs) {
  if (selectedObstacle === obs) {
    // Deselect
    deselectObstacle();
    return;
  }
  selectedObstacle = obs;
  rotationHelper.visible = true;
  updateHelperTransform();
  updateAngleDisplay();
}

function deselectObstacle() {
  selectedObstacle = null;
  rotationHelper.visible = false;
  const anglePanel = document.getElementById('anglePanel');
  if (anglePanel) anglePanel.style.display = 'none';
}

function updateHelperTransform() {
  if (!selectedObstacle) return;
  const m = selectedObstacle.mesh;
  rotationHelper.position.copy(m.position);
  // Match obstacle rotation so rings align with the object's local axes
  rotationHelper.rotation.copy(m.rotation);
  // Scale helper based on obstacle size
  let s = 1;
  if (selectedObstacle.type === 'ramp') s = Math.max(selectedObstacle.width, selectedObstacle.depth) * 0.35;
  else if (selectedObstacle.type === 'cylinder') s = selectedObstacle.radius * 0.8;
  else if (selectedObstacle.type === 'box') s = Math.max(selectedObstacle.hw, selectedObstacle.hd) * 0.8;
  else if (selectedObstacle.type === 'sphere') s = selectedObstacle.radius * 0.8;
  rotationHelper.scale.setScalar(Math.max(s, 0.8));
}

// ── Angle display ──
function updateAngleDisplay() {
  if (!selectedObstacle) return;
  const m = selectedObstacle.mesh;
  const rx = THREE.MathUtils.radToDeg(m.rotation.x).toFixed(1);
  const ry = THREE.MathUtils.radToDeg(m.rotation.y).toFixed(1);
  const rz = THREE.MathUtils.radToDeg(m.rotation.z).toFixed(1);
  const anglePanel = document.getElementById('anglePanel');
  if (anglePanel) {
    anglePanel.style.display = 'flex';
    document.getElementById('angleX').textContent = rx + '°';
    document.getElementById('angleY').textContent = ry + '°';
    document.getElementById('angleZ').textContent = rz + '°';
  }
}

// ── Levels ──
const levels = [
  {
    name: "The Basics",
    description: "Rotate the ramp to guide the stream into the hole!",
    goal: 500, spillLimit: 9999, timeTarget: 60.0,
    emitter: { x: 0, y: 12, z: -4 },
    exit: { x: 0, z: 4, radius: 4.0 },
    fixedObstacles: [],
    playerObstacles: [
      { type: 'ramp', x: 0, z: 0, params: { width: 8, depth: 5, height: 0.35, elevation: 5, rotX: -0.45 } },
    ],
  },
  {
    name: "Short Hop",
    description: "Use two ramps to step the stream down into the hole.",
    goal: 1000, spillLimit: 6000, timeTarget: 60.0,
    emitter: { x: 0, y: 14, z: -6 },
    exit: { x: 0, z: 6, radius: 3.5 },
    fixedObstacles: [],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -3, params: { width: 8, depth: 4, height: 0.35, elevation: 8, rotX: -0.4 } },
      { type: 'ramp', x: 0, z: 3, params: { width: 8, depth: 4, height: 0.35, elevation: 4, rotX: -0.4 } },
    ],
  },
  {
    name: "Zigzag Path",
    description: "Aim the stream left then right to reach the shifted hole.",
    goal: 1500, spillLimit: 4000, timeTarget: 50.0,
    emitter: { x: 0, y: 14, z: -7 },
    exit: { x: 7, z: 7, radius: 3.0 },
    fixedObstacles: [],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -3, params: { width: 8, depth: 4, height: 0.35, elevation: 9, rotX: -0.35, rotY: -0.6 } },
      { type: 'ramp', x: 4, z: 2, params: { width: 8, depth: 4, height: 0.35, elevation: 5, rotX: -0.35, rotY: -0.4 } },
    ],
  },
  {
    name: "The Cascade",
    description: "Three ramps, one path. Build the staircase!",
    goal: 2000, spillLimit: 3000, timeTarget: 50.0,
    emitter: { x: -6, y: 16, z: -6 },
    exit: { x: 6, z: 6, radius: 2.8 },
    fixedObstacles: [],
    playerObstacles: [
      { type: 'ramp', x: -4, z: -3, params: { width: 7, depth: 4, height: 0.35, elevation: 10, rotX: -0.35, rotY: -0.7 } },
      { type: 'ramp', x: 0, z: 0, params: { width: 7, depth: 4, height: 0.35, elevation: 6, rotX: -0.35, rotY: -0.5 } },
      { type: 'ramp', x: 4, z: 4, params: { width: 7, depth: 4, height: 0.35, elevation: 3, rotX: -0.4 } },
    ],
  },
  {
    name: "Pillar Dodge",
    description: "Two pillars block the direct path. Route around them!",
    goal: 2500, spillLimit: 2500, timeTarget: 45.0,
    emitter: { x: 0, y: 16, z: -8 },
    exit: { x: 0, z: 8, radius: 2.5 },
    fixedObstacles: [
      { type: 'cylinder', x: -3, z: 0, params: { radius: 1.2, height: 6 } },
      { type: 'cylinder', x: 3, z: 0, params: { radius: 1.2, height: 6 } },
    ],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -4, params: { width: 8, depth: 4, height: 0.35, elevation: 10, rotX: -0.4, rotY: 0.4 } },
      { type: 'ramp', x: 4, z: 1, params: { width: 7, depth: 3.5, height: 0.35, elevation: 6, rotX: -0.4, rotY: -0.4 } },
      { type: 'ramp', x: 0, z: 5, params: { width: 7, depth: 3.5, height: 0.35, elevation: 3, rotX: -0.35 } },
    ],
  },
  {
    name: "The Gauntlet",
    description: "Walls narrow the corridor. Stay on target!",
    goal: 3000, spillLimit: 2000, timeTarget: 45.0,
    emitter: { x: 0, y: 18, z: -10 },
    exit: { x: 0, z: 10, radius: 2.2 },
    fixedObstacles: [
      { type: 'box', x: -5, z: -4, params: { width: 2, height: 5, depth: 1 } },
      { type: 'box', x: 5, z: -4, params: { width: 2, height: 5, depth: 1 } },
      { type: 'box', x: -5, z: 3, params: { width: 2, height: 5, depth: 1 } },
      { type: 'box', x: 5, z: 3, params: { width: 2, height: 5, depth: 1 } },
    ],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -6, params: { width: 9, depth: 4, height: 0.35, elevation: 12, rotX: -0.4 } },
      { type: 'ramp', x: 0, z: -1, params: { width: 8, depth: 4, height: 0.35, elevation: 7, rotX: -0.4 } },
      { type: 'ramp', x: 0, z: 5, params: { width: 8, depth: 4, height: 0.35, elevation: 3, rotX: -0.4 } },
    ],
  },
  {
    name: "Moving Hazard",
    description: "A swinging pillar blocks the route. Time your angles!",
    goal: 4000, spillLimit: 1500, timeTarget: 40.0,
    emitter: { x: 0, y: 18, z: -10 },
    exit: { x: 0, z: 10, radius: 2.0 },
    fixedObstacles: [
      { type: 'cylinder', x: 0, z: 0, params: { radius: 1.5, height: 8, moving: true, moveAxis: 'x', moveRange: 4, moveSpeed: 1.0 } },
    ],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -6, params: { width: 9, depth: 4, height: 0.35, elevation: 12, rotX: -0.4 } },
      { type: 'ramp', x: -4, z: 1, params: { width: 8, depth: 3.5, height: 0.35, elevation: 7, rotX: -0.38, rotY: 0.35 } },
      { type: 'ramp', x: 0, z: 6, params: { width: 8, depth: 3.5, height: 0.35, elevation: 3, rotX: -0.38 } },
    ],
  },
  {
    name: "Narrow Funnel",
    description: "The hole is half the size. Precision matters now!",
    goal: 5000, spillLimit: 1000, timeTarget: 40.0,
    emitter: { x: 0, y: 18, z: -9 },
    exit: { x: 0, z: 9, radius: 1.6 },
    fixedObstacles: [
      { type: 'sphere', x: -4, z: 0, params: { radius: 1.4 } },
      { type: 'sphere', x: 4, z: 0, params: { radius: 1.4 } },
      { type: 'cylinder', x: 0, z: 4, params: { radius: 1.2, height: 5 } },
    ],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -5, params: { width: 8, depth: 4, height: 0.35, elevation: 12, rotX: -0.4 } },
      { type: 'ramp', x: 3, z: 0, params: { width: 7, depth: 3.5, height: 0.35, elevation: 7, rotX: -0.4, rotY: -0.3 } },
      { type: 'ramp', x: 0, z: 6, params: { width: 6, depth: 3, height: 0.35, elevation: 3, rotX: -0.4 } },
    ],
  },
  {
    name: "Twin Chutes",
    description: "Two movers patrol the lane. Watch for the gap!",
    goal: 6000, spillLimit: 500, timeTarget: 40.0,
    emitter: { x: 0, y: 18, z: -10 },
    exit: { x: 0, z: 10, radius: 1.4 },
    fixedObstacles: [
      { type: 'box', x: -3, z: 0, params: { width: 1.5, height: 6, depth: 1.5, moving: true, moveAxis: 'x', moveRange: 3, moveSpeed: 1.2 } },
      { type: 'box', x: 3, z: 0, params: { width: 1.5, height: 6, depth: 1.5, moving: true, moveAxis: 'x', moveRange: 3, moveSpeed: 1.4 } },
    ],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -6, params: { width: 9, depth: 4, height: 0.35, elevation: 12, rotX: -0.4 } },
      { type: 'ramp', x: 0, z: 0, params: { width: 8, depth: 3.5, height: 0.35, elevation: 7, rotX: -0.4 } },
      { type: 'ramp', x: 0, z: 6, params: { width: 7, depth: 3, height: 0.35, elevation: 3, rotX: -0.4 } },
    ],
  },
  {
    name: "The Crucible",
    description: "Final trial: tiny hole, fast movers, near-zero tolerance!",
    goal: 8000, spillLimit: 100, timeTarget: 50.0,
    emitter: { x: 0, y: 20, z: -10 },
    exit: { x: 0, z: 10, radius: 1.0 },
    fixedObstacles: [
      { type: 'cylinder', x: -4, z: -3, params: { radius: 1.3, height: 7, moving: true, moveAxis: 'x', moveRange: 4, moveSpeed: 1.5 } },
      { type: 'cylinder', x: 4, z: 3, params: { radius: 1.3, height: 7, moving: true, moveAxis: 'x', moveRange: 4, moveSpeed: 1.7 } },
      { type: 'sphere', x: 0, z: 0, params: { radius: 1.8, moving: true, moveAxis: 'x', moveRange: 3, moveSpeed: 1.2 } },
      { type: 'box', x: -6, z: 6, params: { width: 2, height: 5, depth: 1 } },
      { type: 'box', x: 6, z: 6, params: { width: 2, height: 5, depth: 1 } },
    ],
    playerObstacles: [
      { type: 'ramp', x: 0, z: -6, params: { width: 9, depth: 4, height: 0.35, elevation: 14, rotX: -0.4 } },
      { type: 'ramp', x: -4, z: -1, params: { width: 7, depth: 3.5, height: 0.35, elevation: 9, rotX: -0.38, rotY: 0.3 } },
      { type: 'ramp', x: 3, z: 4, params: { width: 7, depth: 3.5, height: 0.35, elevation: 5, rotX: -0.38, rotY: -0.3 } },
      { type: 'ramp', x: 0, z: 8, params: { width: 6, depth: 3, height: 0.35, elevation: 2, rotX: -0.38 } },
    ],
  }
];

function clearLevel() {
  obstacles.length = 0;
  playerObstacles.length = 0;
  movingObstacles.length = 0;
  while (obstacleMeshes.children.length) obstacleMeshes.remove(obstacleMeshes.children[0]);
  deselectObstacle();
  resetParticles();
  totalCaptured = 0;
  spilledParticles = 0;
  levelTime = 0;
  isPlaying = false;
  resetPlayButton();
  updateUI();
}

function loadLevel(idx) {
  clearLevel();
  if (idx !== levelIndex) { failCount = 0; setCheatButtonVisible(false); }
  movingPaused = false;
  const moversBtn = document.getElementById('toggleMoversBtn');
  if (moversBtn) { moversBtn.textContent = '⏸'; moversBtn.classList.remove('paused'); }
  levelIndex = idx;
  const lvl = levels[idx];

  createEmitter(lvl.emitter.x, lvl.emitter.y, lvl.emitter.z);
  createExitHole(lvl.exit.x, lvl.exit.z, lvl.exit.radius);

  lvl.fixedObstacles.forEach(o => addObstacle(o.type, o.x, o.z, o.params, false));
  lvl.playerObstacles.forEach(o => addObstacle(o.type, o.x, o.z, o.params, true));

  for (const obs of obstacles) {
    if (obs.moving) movingObstacles.push(obs);
  }
  obsBoundsInit = false;

  // Difficulty scaling: gravity ramps up and particles decay faster on later levels
  GRAVITY = -0.0085 - idx * 0.0004;
  PARTICLE_LIFETIME = Math.max(6, 9 - idx * 0.3);
  // Gentle sideways wind on the toughest levels
  WIND_X = idx >= 7 ? (Math.random() - 0.5) * 0.006 : 0;
  WIND_Z = idx >= 7 ? (Math.random() - 0.5) * 0.006 : 0;

  updateUI();
  updateLevelSelect();
}

// ── FPS counter ──
let fpsFrames = 0;
let fpsLastTime = performance.now();
let fpsValue = 60;

function updateFPS() {
  fpsFrames++;
  const now = performance.now();
  const delta = now - fpsLastTime;
  if (delta >= 500) {
    fpsValue = Math.round((fpsFrames * 1000) / delta);
    fpsFrames = 0;
    fpsLastTime = now;
    const fpsEl = document.getElementById('fpsDisplay');
    if (fpsEl) fpsEl.textContent = fpsValue;
  }
}

// ── Spatial hashing ──
const hashMap = new Map();

function hashKey(x, z) {
  const hx = Math.floor(x / HASH_CELL);
  const hz = Math.floor(z / HASH_CELL);
  return hx * 10007 + hz;
}

function buildHash() {
  hashMap.clear();
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    if (lifetimes[i] <= 0) continue;
    const key = hashKey(positions[i * 3], positions[i * 3 + 2]);
    if (!hashMap.has(key)) hashMap.set(key, []);
    hashMap.get(key).push(i);
  }
}

function getNeighborKeys(x, z) {
  const hx = Math.floor(x / HASH_CELL);
  const hz = Math.floor(z / HASH_CELL);
  const keys = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      keys.push((hx + dx) * 10007 + (hz + dz));
  return keys;
}

// ── SDF collision ──
const _rampLocalPos = new THREE.Vector3();
const _rampInvMatrix = new THREE.Matrix4();

const _cylLocalPos = new THREE.Vector3();
const _cylInvMatrix = new THREE.Matrix4();

function sdfCylinder(px, py, pz, obs) {
  const mesh = obs.mesh;
  _cylInvMatrix.copy(mesh.matrixWorld).invert();
  _cylLocalPos.set(px, py, pz).applyMatrix4(_cylInvMatrix);

  const lx = _cylLocalPos.x;
  const ly = _cylLocalPos.y;
  const lz = _cylLocalPos.z;

  const distXZ = Math.sqrt(lx * lx + lz * lz);
  const halfH = obs.height / 2;
  const dRadial = distXZ - obs.radius;
  const dVertical = Math.abs(ly) - halfH;
  const outsideRadial = Math.max(dRadial, 0);
  const outsideVertical = Math.max(dVertical, 0);
  const insideDist = Math.min(Math.max(dRadial, dVertical), 0);
  const sdf = Math.sqrt(outsideRadial * outsideRadial + outsideVertical * outsideVertical) + insideDist;

  let nlx = 0, nly = 0, nlz = 0;
  if (dRadial > dVertical) {
    if (distXZ > 0.0001) { nlx = lx / distXZ; nlz = lz / distXZ; }
    else { nlx = 1; }
  } else { nly = ly > 0 ? 1 : -1; }

  // Transform normal from local to world space
  const e = mesh.matrixWorld.elements;
  const wnx = e[0] * nlx + e[4] * nly + e[8] * nlz;
  const wny = e[1] * nlx + e[5] * nly + e[9] * nlz;
  const wnz = e[2] * nlx + e[6] * nly + e[10] * nlz;
  const len = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz) || 1;
  return { sdf, nx: wnx / len, ny: wny / len, nz: wnz / len };
}

const _boxLocalPos = new THREE.Vector3();
const _boxInvMatrix = new THREE.Matrix4();

function sdfBox(px, py, pz, obs) {
  const mesh = obs.mesh;
  _boxInvMatrix.copy(mesh.matrixWorld).invert();
  _boxLocalPos.set(px, py, pz).applyMatrix4(_boxInvMatrix);

  const lx = _boxLocalPos.x;
  const ly = _boxLocalPos.y;
  const lz = _boxLocalPos.z;
  const halfH = obs.height / 2;
  const qx = Math.abs(lx) - obs.hw;
  const qy = Math.abs(ly) - halfH;
  const qz = Math.abs(lz) - obs.hd;
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideZ = Math.max(qz, 0);
  const insideDist = Math.min(Math.max(qx, qy, qz), 0);
  const sdf = Math.sqrt(outsideX * outsideX + outsideY * outsideY + outsideZ * outsideZ) + insideDist;

  let nlx = 0, nly = 0, nlz = 0;
  if (sdf > 0) {
    nlx = outsideX > 0 ? (lx > 0 ? outsideX : -outsideX) : 0;
    nly = outsideY > 0 ? (ly > 0 ? outsideY : -outsideY) : 0;
    nlz = outsideZ > 0 ? (lz > 0 ? outsideZ : -outsideZ) : 0;
  } else {
    if (qx > qy && qx > qz) nlx = lx > 0 ? 1 : -1;
    else if (qy > qx && qy > qz) nly = ly > 0 ? 1 : -1;
    else nlz = lz > 0 ? 1 : -1;
  }

  // Transform normal from local to world space
  const e = mesh.matrixWorld.elements;
  const wnx = e[0] * nlx + e[4] * nly + e[8] * nlz;
  const wny = e[1] * nlx + e[5] * nly + e[9] * nlz;
  const wnz = e[2] * nlx + e[6] * nly + e[10] * nlz;
  const len = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz) || 1;
  return { sdf, nx: wnx / len, ny: wny / len, nz: wnz / len };
}

function sdfRamp(px, py, pz, obs) {
  const mesh = obs.mesh;
  _rampInvMatrix.copy(mesh.matrixWorld).invert();
  _rampLocalPos.set(px, py, pz).applyMatrix4(_rampInvMatrix);
  const hw = obs.width / 2;
  const hh = obs.height / 2;
  const hd = obs.depth / 2;
  const lx = _rampLocalPos.x;
  const ly = _rampLocalPos.y;
  const lz = _rampLocalPos.z;
  const qx = Math.abs(lx) - hw;
  const qy = Math.abs(ly) - hh;
  const qz = Math.abs(lz) - hd;
  const outsideX = Math.max(qx, 0);
  const outsideY = Math.max(qy, 0);
  const outsideZ = Math.max(qz, 0);
  const insideDist = Math.min(Math.max(qx, qy, qz), 0);
  const sdf = Math.sqrt(outsideX * outsideX + outsideY * outsideY + outsideZ * outsideZ) + insideDist;
  let nlx = 0, nly = 0, nlz = 0;
  if (sdf > 0) {
    nlx = outsideX > 0 ? (lx > 0 ? outsideX : -outsideX) : 0;
    nly = outsideY > 0 ? (ly > 0 ? outsideY : -outsideY) : 0;
    nlz = outsideZ > 0 ? (lz > 0 ? outsideZ : -outsideZ) : 0;
  } else {
    if (qy > qx && qy > qz) nly = ly > 0 ? 1 : -1;
    else if (qx > qz) nlx = lx > 0 ? 1 : -1;
    else nlz = lz > 0 ? 1 : -1;
  }
  const e = mesh.matrixWorld.elements;
  const nx = e[0] * nlx + e[4] * nly + e[8] * nlz;
  const ny = e[1] * nlx + e[5] * nly + e[9] * nlz;
  const nz = e[2] * nlx + e[6] * nly + e[10] * nlz;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return { sdf, nx: nx / len, ny: ny / len, nz: nz / len };
}

const _sphLocalPos = new THREE.Vector3();
const _sphInvMatrix = new THREE.Matrix4();

function sdfSphere(px, py, pz, obs) {
  const mesh = obs.mesh;
  _sphInvMatrix.copy(mesh.matrixWorld).invert();
  _sphLocalPos.set(px, py, pz).applyMatrix4(_sphInvMatrix);

  const lx = _sphLocalPos.x;
  const ly = _sphLocalPos.y;
  const lz = _sphLocalPos.z;
  const dist = Math.sqrt(lx * lx + ly * ly + lz * lz);
  const sdf = dist - obs.radius;

  let nlx, nly, nlz;
  if (dist > 0.0001) { nlx = lx / dist; nly = ly / dist; nlz = lz / dist; }
  else { nlx = 0; nly = 1; nlz = 0; }

  // Transform normal from local to world space
  const e = mesh.matrixWorld.elements;
  const wnx = e[0] * nlx + e[4] * nly + e[8] * nlz;
  const wny = e[1] * nlx + e[5] * nly + e[9] * nlz;
  const wnz = e[2] * nlx + e[6] * nly + e[10] * nlz;
  const len = Math.sqrt(wnx * wnx + wny * wny + wnz * wnz) || 1;
  return { sdf, nx: wnx / len, ny: wny / len, nz: wnz / len };
}

function collideObstacle(px, py, pz, vx, vy, vz) {
  for (const obs of obstacles) {
    let result;
    if (obs.type === 'ramp') result = sdfRamp(px, py, pz, obs);
    else if (obs.type === 'cylinder') result = sdfCylinder(px, py, pz, obs);
    else if (obs.type === 'box') result = sdfBox(px, py, pz, obs);
    else if (obs.type === 'sphere') result = sdfSphere(px, py, pz, obs);
    else continue;

    const margin = PARTICLE_RADIUS;
    if (result.sdf < margin) {
      const { nx, ny, nz } = result;
      const penetration = margin - result.sdf;
      px += nx * penetration;
      py += ny * penetration;
      pz += nz * penetration;
      const dot = vx * nx + vy * ny + vz * nz;
      if (dot < 0) {
        vx -= 1.6 * dot * nx;
        vy -= 1.6 * dot * ny;
        vz -= 1.6 * dot * nz;
        const tx = vx - (vx * nx + vy * ny + vz * nz) * nx;
        const ty = vy - (vx * nx + vy * ny + vz * nz) * ny;
        const tz = vz - (vx * nx + vy * ny + vz * nz) * nz;
        vx = (vx - tx) + tx * 0.92;
        vy = (vy - ty) + ty * 0.92;
        vz = (vz - tz) + tz * 0.92;
      }
    }
  }
  return { px, py, pz, vx, vy, vz };
}

// ── Physics ──
// Pre-compute obstacle bounding spheres for fast early-out
// obsBounds entries are reused across frames (mutated in place) to avoid GC churn
const obsBounds = [];
let obsBoundsInit = false;
function updateObstacleBounds() {
  if (!obsBoundsInit || obsBounds.length !== obstacles.length) {
    obsBounds.length = 0;
    for (const obs of obstacles) {
      let r = 4;
      if (obs.type === 'ramp' || obs.type === 'accelerator' || obs.type === 'redirector') r = Math.max(obs.width, obs.depth) * 0.7 + obs.height;
      else if (obs.type === 'cylinder') r = obs.radius + obs.height * 0.5;
      else if (obs.type === 'box') r = Math.sqrt(obs.hw * obs.hw + obs.hd * obs.hd) + obs.height * 0.5;
      else if (obs.type === 'sphere') r = obs.radius * 1.2;
      obsBounds.push({ x: 0, y: 0, z: 0, r2: (r + PARTICLE_RADIUS) * (r + PARTICLE_RADIUS), obs });
    }
    obsBoundsInit = true;
  }
  for (let i = 0; i < obsBounds.length; i++) {
    const obs = obsBounds[i].obs;
    const p = obs.mesh.position;
    obsBounds[i].x = p.x;
    obsBounds[i].y = p.y;
    obsBounds[i].z = p.z;
    if (obs.type === 'accelerator') {
      const e = obs.mesh.matrixWorld.elements;
      // Extract local X axis
      let bx = e[0], by = e[1], bz = e[2];
      const len = Math.sqrt(bx * bx + by * by + bz * bz);
      if (len > 0.001) { bx /= len; by /= len; bz /= len; }
      obs.boostX = bx; obs.boostY = by; obs.boostZ = bz;
    }
    if (obs.type === 'redirector') {
      const e = obs.mesh.matrixWorld.elements;
      // Extract local Y axis (surface normal of the wall face)
      let nx = e[4], ny = e[5], nz = e[6];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0.001) { nx /= len; ny /= len; nz /= len; }
      obs.normalX = nx; obs.normalY = ny; obs.normalZ = nz;
    }
  }
}

// Update oscillating obstacles (moving hazards) — called once per simulate() tick
function updateMovingObstacles(dt) {
  if (movingObstacles.length === 0) return;
  const t = performance.now() * 0.001;
  for (const obs of movingObstacles) {
    const phase = Math.sin(t * obs.moveSpeed + obs.movePhase) * obs.moveRange;
    if (obs.moveAxis === 'x') {
      obs.mesh.position.x = obs.baseX + phase;
      obs.x = obs.mesh.position.x;
    } else {
      obs.mesh.position.z = obs.baseZ + phase;
      obs.z = obs.mesh.position.z;
    }
    obs.mesh.updateMatrixWorld(true);
  }
  obsBoundsInit = false; // force bounds refresh position sync next call (positions still copied each frame anyway)
}

function collideObstacleFast(px, py, pz, vx, vy, vz) {
  const n = obsBounds.length;
  for (let b = 0; b < n; b++) {
    const bd = obsBounds[b];
    const dx = px - bd.x;
    const dy = py - bd.y;
    const dz = pz - bd.z;
    if (dx * dx + dy * dy + dz * dz > bd.r2) continue;

    const obs = bd.obs;
    let result;
    if (obs.type === 'ramp' || obs.type === 'accelerator' || obs.type === 'redirector') result = sdfRamp(px, py, pz, obs);
    else if (obs.type === 'cylinder') result = sdfCylinder(px, py, pz, obs);
    else if (obs.type === 'box') result = sdfBox(px, py, pz, obs);
    else if (obs.type === 'sphere') result = sdfSphere(px, py, pz, obs);
    else continue;

    if (result.sdf < PARTICLE_RADIUS) {
      const { nx, ny, nz } = result;
      const penetration = PARTICLE_RADIUS - result.sdf;
      px += nx * penetration;
      py += ny * penetration;
      pz += nz * penetration;
      const dot = vx * nx + vy * ny + vz * nz;
      if (dot < 0) {
        vx -= 1.6 * dot * nx;
        vy -= 1.6 * dot * ny;
        vz -= 1.6 * dot * nz;
        vx *= 0.92;
        vy *= 0.92;
        vz *= 0.92;
      }
      if (obs.type === 'accelerator') {
        vx += obs.boostX * 0.035;
        vy += obs.boostY * 0.035;
        vz += obs.boostZ * 0.035;
      }
      if (obs.type === 'redirector') {
        // Strong reflect + forward boost along the face normal
        const dot2 = vx * obs.normalX + vy * obs.normalY + vz * obs.normalZ;
        vx = vx - 2.6 * dot2 * obs.normalX;
        vy = vy - 2.6 * dot2 * obs.normalY;
        vz = vz - 2.6 * dot2 * obs.normalZ;
        vx += obs.normalX * 0.05;
        vy += obs.normalY * 0.05;
        vz += obs.normalZ * 0.05;
      }
    }
  }
  return { px, py, pz, vx, vy, vz };
}

let movingPaused = false;

function simulate() {
  if (!isPlaying) return;

  if (!movingPaused) updateMovingObstacles();

  // Emit particles
  const emitCount = 5;
  let emitted = 0;
  for (let i = 0; i < PARTICLE_COUNT && emitted < emitCount; i++) {
    if (lifetimes[i] <= 0) {
      const i3 = i * 3;
      positions[i3] = emitterPos.x + (Math.random() - 0.5) * 0.4;
      positions[i3 + 1] = emitterPos.y + Math.random() * 0.3;
      positions[i3 + 2] = emitterPos.z + (Math.random() - 0.5) * 0.4;
      velocities[i3] = (Math.random() - 0.5) * 0.02;
      velocities[i3 + 1] = -0.08 - Math.random() * 0.04;
      velocities[i3 + 2] = (Math.random() - 0.5) * 0.02;
      lifetimes[i] = PARTICLE_LIFETIME;
      emitted++;
    }
  }

  updateObstacleBounds();

  const lifeDt = 1 / 60;
  const bx = BOUNDS.x - PARTICLE_RADIUS;
  const bz = BOUNDS.z - PARTICLE_RADIUS;
  const floorLimit = FLOOR_Y + PARTICLE_RADIUS;
  const exitX = exitHole ? exitHole.x : 0;
  const exitZ = exitHole ? exitHole.z : 0;
  const exitR2 = exitHole ? exitHole.radius * exitHole.radius : 0;
  const exitCheck = exitHole !== null;
  const exitCapY = FLOOR_Y + PARTICLE_RADIUS + 0.5;
  const goalCount = levels[levelIndex].goal;
  const windX = WIND_X;
  const windZ = WIND_Z;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    if (lifetimes[i] <= 0) continue;

    lifetimes[i] -= lifeDt;
    if (lifetimes[i] <= 0) { lifetimes[i] = 0; continue; }

    const i3 = i * 3;
    let vx = velocities[i3] + windX;
    let vy = velocities[i3 + 1] + GRAVITY;
    let vz = velocities[i3 + 2] + windZ;

    vx *= DAMPING;
    vy *= DAMPING;
    vz *= DAMPING;

    let px = positions[i3] + vx;
    let py = positions[i3 + 1] + vy;
    let pz = positions[i3 + 2] + vz;

    // Obstacle collision (with bounding sphere early-out)
    const col = collideObstacleFast(px, py, pz, vx, vy, vz);
    px = col.px; py = col.py; pz = col.pz;
    vx = col.vx; vy = col.vy; vz = col.vz;

    // Exit hole capture — capture when particle falls below the hole bottom
    if (exitCheck) {
      const edx = px - exitX;
      const edz = pz - exitZ;
      const inHoleXZ = edx * edx + edz * edz < exitR2;
      if (inHoleXZ && py < FLOOR_Y - HOLE_DEPTH + 0.5) {
        // Particle reached the bottom of the hole — capture it
        lifetimes[i] = 0;
        positions[i3] = 9999;
        positions[i3 + 1] = -10;
        positions[i3 + 2] = 9999;
        totalCaptured++;
        if (totalCaptured % 25 === 0) playCaptureSound();
        score++;
        // Spawn falling visual inside hole
        if (exitHole) {
          const edx2 = px - exitHole.x;
          const edz2 = pz - exitHole.z;
          fallingParticles.push({
            x: px, y: FLOOR_Y - 0.1, z: pz,
            vy: -0.02,
            angle: Math.atan2(edz2, edx2),
            dist: Math.sqrt(edx2 * edx2 + edz2 * edz2),
            life: 1.0
          });
        }
        if (totalCaptured >= goalCount) onLevelWin();
        continue;
      }
      // Constrain particles inside the hole tube (prevent clipping through walls)
      if (inHoleXZ && py < FLOOR_Y) {
        const distFromCenter = Math.sqrt(edx * edx + edz * edz);
        const holeR = exitHole.radius - PARTICLE_RADIUS;
        if (distFromCenter > holeR && holeR > 0) {
          const scale = holeR / distFromCenter;
          px = exitX + edx * scale;
          pz = exitZ + edz * scale;
          // Reflect velocity inward
          const nx = edx / distFromCenter;
          const nz = edz / distFromCenter;
          const vDotN = vx * nx + vz * nz;
          if (vDotN > 0) {
            vx -= 1.5 * vDotN * nx;
            vz -= 1.5 * vDotN * nz;
          }
        }
      }
    }

    // Floor — skip floor collision if particle is inside the exit hole (let it fall through)
    if (py < floorLimit) {
      let overHole = false;
      if (exitCheck) {
        const hdx = px - exitX;
        const hdz = pz - exitZ;
        if (hdx * hdx + hdz * hdz < exitR2) {
          overHole = true;
        }
      }
      if (!overHole) {
        spilledParticles++;
        lifetimes[i] = 0;
        positions[i3] = 9999;
        positions[i3 + 1] = -10;
        positions[i3 + 2] = 9999;
        if (spilledParticles > levels[levelIndex].spillLimit) {
          onLevelFail();
        }
        continue;
      }
    }

    // Walls (branchless clamp)
    if (px < -bx) { px = -bx; vx *= -0.4; }
    else if (px > bx) { px = bx; vx *= -0.4; }
    if (pz < -bz) { pz = -bz; vz *= -0.4; }
    else if (pz > bz) { pz = bz; vz *= -0.4; }

    positions[i3] = px;
    positions[i3 + 1] = py;
    positions[i3 + 2] = pz;
    velocities[i3] = vx;
    velocities[i3 + 1] = vy;
    velocities[i3 + 2] = vz;
  }
}

const ROAST_MESSAGES = [
  "Bot mode activated 🤖 — even my grandma does better.",
  "Three losses? Bro, the ramp is literally doing all the work now. 💀",
  "Error 404: Skill not found. Here's a free ramp.",
  "Struggling? Don't worry, the AI is carrying you now. 🚑",
  "You're getting a free ramp because the particles feel bad for you.",
  "At this rate, the particles will file a complaint. Here's help. 🤡",
  "Three fails on the SAME level? Impressive... not in a good way.",
  "The physics engine called — it's embarrassed for you. 😬",
];

function showRoastToast(msg) {
  let toast = document.getElementById('roastToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-50%) translateY(20px)';
  }, 4500);
}

function setCheatButtonVisible(visible) {
  const btn = document.getElementById('cheatBtn');
  if (btn) btn.style.display = visible ? 'flex' : 'none';
}

function onLevelWin() {
  isPlaying = false;
  failCount = 0;
  setCheatButtonVisible(false);
  playWinSound();
  launchConfetti();
  const time = levelTime;
  const lvl = levels[levelIndex];
  if (time < bestTimes[levelIndex]) bestTimes[levelIndex] = time;

  let stars = 1;
  // 3 stars if perfect spill run (<= 5% limit) and fast time
  if (spilledParticles <= lvl.spillLimit * 0.05 && time <= lvl.timeTarget) {
    stars = 3;
  } else if (spilledParticles <= lvl.spillLimit * 0.5 || time <= lvl.timeTarget * 1.5) {
    stars = 2;
  }

  const winEl = document.getElementById('winOverlay');
  if (winEl) {
    winEl.style.display = 'flex';
    document.getElementById('winTime').textContent = time.toFixed(1) + 's';
    document.getElementById('winBest').textContent = bestTimes[levelIndex] === Infinity ? '--' : bestTimes[levelIndex].toFixed(1) + 's';
    document.getElementById('winCaptured').textContent = totalCaptured;
    const starsEl = document.getElementById('winStars');
    if (starsEl) starsEl.innerHTML = '⭐'.repeat(stars) + '<span style="opacity:0.3;filter:grayscale(1)">⭐</span>'.repeat(3 - stars);
  }
}

function onLevelFail() {
  if (!isPlaying) return;
  isPlaying = false;
  failCount++;
  playFailSound();
  const failEl = document.getElementById('failOverlay');
  if (failEl) failEl.style.display = 'flex';
  if (failCount >= 3) {
    setCheatButtonVisible(true);
    const roast = ROAST_MESSAGES[Math.floor(Math.random() * ROAST_MESSAGES.length)];
    setTimeout(() => showRoastToast('🤖 ' + roast), 800);
  }
}

// ── Update instances ──
// Reusable matrix elements to avoid Object3D overhead
const _mat4 = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _quat = new THREE.Quaternion();
let instanceFrame = 0;

function updateInstances() {
  instanceFrame++;
  // Update instances every frame but skip color updates on odd frames
  const updateColor = (instanceFrame & 1) === 0;

  let visibleCount = 0;
  const matArr = instancedParticles.instanceMatrix.array;
  const colArr = instancedParticles.instanceColor.array;

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    if (lifetimes[i] <= 0) continue;
    const i3 = i * 3;
    const px = positions[i3];
    const py = positions[i3 + 1];
    const pz = positions[i3 + 2];

    const lifeFade = lifetimes[i] < 1.5 ? lifetimes[i] / 1.5 : 1;
    const s = Math.max(lifeFade, 0.1);

    // Write matrix directly (identity rotation, uniform scale, translation)
    const off = visibleCount * 16;
    matArr[off] = s;     matArr[off + 1] = 0;  matArr[off + 2] = 0;  matArr[off + 3] = 0;
    matArr[off + 4] = 0; matArr[off + 5] = s;  matArr[off + 6] = 0;  matArr[off + 7] = 0;
    matArr[off + 8] = 0; matArr[off + 9] = 0;  matArr[off + 10] = s; matArr[off + 11] = 0;
    matArr[off + 12] = px; matArr[off + 13] = py; matArr[off + 14] = pz; matArr[off + 15] = 1;

    if (updateColor) {
      const c3 = visibleCount * 3;
      colArr[c3] = 0.1 * lifeFade;
      colArr[c3 + 1] = 0.55 * lifeFade;
      colArr[c3 + 2] = 0.9 * lifeFade;
    }

    visibleCount++;
  }

  instancedParticles.count = visibleCount;
  instancedParticles.instanceMatrix.needsUpdate = true;
  if (updateColor) instancedParticles.instanceColor.needsUpdate = true;
}

// ── Mouse interaction ──
const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -FLOOR_Y);
let draggedObstacle = null;
let dragOffset = new THREE.Vector3();
let activeRotAxis = null; // 'x', 'y', or 'z'
let rotStartMouse = new THREE.Vector2();
let obsStartQuat = new THREE.Quaternion();

function getMouseOnGround(e) {
  const m = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(m, camera);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(groundPlane, hit);
  return hit;
}

function getMouseOnPlane(e, planeNormal, planePoint) {
  const m = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(m, camera);
  const plane = new THREE.Plane();
  plane.setFromNormalAndCoplanarPoint(planeNormal, planePoint);
  const hit = new THREE.Vector3();
  raycaster.ray.intersectPlane(plane, hit);
  return hit;
}

function pickObstacle(e) {
  const m = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(m, camera);
  const meshes = obstacles.map(o => o.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length > 0) {
    const mesh = hits[0].object;
    return obstacles.find(o => o.mesh === mesh) || null;
  }
  return null;
}

function pickRotationRing(e) {
  if (!selectedObstacle || !rotationHelper.visible) return null;
  const m = new THREE.Vector2(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );
  raycaster.setFromCamera(m, camera);
  // Pick all helper children (rings + arrows)
  const hits = raycaster.intersectObjects(rotationHelper.children, false);
  if (hits.length > 0) {
    const name = hits[0].object.name;
    if (name === 'rotRingX') return 'x';
    if (name === 'rotRingY') return 'y';
    if (name === 'rotRingZ') return 'z';
    // Arrows map to Y axis
    if (name.startsWith('arrow')) return 'y';
  }
  return null;
}

// Project obstacle center to screen for angle-based rotation
function getScreenPos(obj) {
  const v = new THREE.Vector3();
  obj.getWorldPosition(v);
  v.project(camera);
  return new THREE.Vector2(
    (v.x * 0.5 + 0.5) * window.innerWidth,
    (-v.y * 0.5 + 0.5) * window.innerHeight
  );
}

// Quaternion for rotation accumulation
const _rotQuat = new THREE.Quaternion();
const _axisVec = new THREE.Vector3();
let lastMouseY = 0;

renderer.domElement.addEventListener('pointermove', (e) => {
  const deltaY = e.clientY - lastMouseY;
  lastMouseY = e.clientY;
  if (isRotating && selectedObstacle && activeRotAxis) {
    const mesh = selectedObstacle.mesh;
    // Get the obstacle center on screen
    const center = getScreenPos(mesh);
    // Compute angle from center to current mouse position
    const currentAngle = Math.atan2(e.clientY - center.y, e.clientX - center.x);
    // Compute angle from center to start mouse position
    const startAngle = Math.atan2(rotStartMouse.y - center.y, rotStartMouse.x - center.x);
    // The rotation delta is the difference in angles
    let angleDelta = currentAngle - startAngle;
    if (e.shiftKey) {
      const snap = Math.PI / 12; // 15 degrees
      angleDelta = Math.round(angleDelta / snap) * snap;
    }

    // Get the LOCAL axis in WORLD space by transforming it through the obstacle's starting rotation
    if (activeRotAxis === 'x') _axisVec.set(1, 0, 0);
    else if (activeRotAxis === 'y') _axisVec.set(0, 1, 0);
    else _axisVec.set(0, 0, 1);

    // Transform local axis to world space using the stored start quaternion
    _axisVec.applyQuaternion(obsStartQuat);

    // Determine sign: project world axis onto camera's view direction
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    const dotAxis = _axisVec.dot(camDir);
    // X axis needs same sign as Y and Z
    const sign = dotAxis > 0 ? 1 : -1;

    // Apply incremental rotation: startQuat * deltaRotation around local axis
    _rotQuat.copy(obsStartQuat);
    const deltaQuat = new THREE.Quaternion();
    // Rotate around the LOCAL axis (before world transform)
    const localAxis = new THREE.Vector3();
    if (activeRotAxis === 'x') localAxis.set(1, 0, 0);
    else if (activeRotAxis === 'y') localAxis.set(0, 1, 0);
    else localAxis.set(0, 0, 1);
    deltaQuat.setFromAxisAngle(localAxis, angleDelta * sign);

    // New rotation = startQuat * deltaQuat (local-space rotation)
    mesh.quaternion.copy(obsStartQuat).multiply(deltaQuat);

    mesh.updateMatrixWorld(true);
    updateHelperTransform();
    updateAngleDisplay();
    return;
  }

  if (draggedObstacle) {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      draggedObstacle.elevation -= deltaY * 0.1;
      draggedObstacle.elevation = Math.max(0.5, Math.min(30, draggedObstacle.elevation));
      draggedObstacle.mesh.position.y = draggedObstacle.elevation;
      draggedObstacle.mesh.updateMatrixWorld(true);
      if (selectedObstacle === draggedObstacle) updateHelperTransform();
      return;
    }
    // Use a horizontal plane at the obstacle's Y for more accurate dragging
    const dragPlaneY = draggedObstacle.mesh.position.y;
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dragPlaneY);
    const m2 = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(m2, camera);
    const hit = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, hit);
    if (hit) {
      const newX = hit.x + dragOffset.x;
      const newZ = hit.z + dragOffset.z;
      let clampX = Math.max(-BOUNDS.x + 2, Math.min(BOUNDS.x - 2, newX));
      let clampZ = Math.max(-BOUNDS.z + 2, Math.min(BOUNDS.z - 2, newZ));
      if (e.shiftKey) {
        clampX = Math.round(clampX * 2) / 2; // snap to 0.5 units
        clampZ = Math.round(clampZ * 2) / 2;
      }
      draggedObstacle.x = clampX;
      draggedObstacle.z = clampZ;
      draggedObstacle.mesh.position.x = clampX;
      draggedObstacle.mesh.position.z = clampZ;
      draggedObstacle.mesh.updateMatrixWorld(true);
      if (selectedObstacle === draggedObstacle) updateHelperTransform();
    }
    return;
  }
});

renderer.domElement.addEventListener('pointerdown', (e) => {
  lastMouseY = e.clientY;
  if (isPlaying) return;
  if (e.button !== 0) return;

  // Check rotation ring first
  if (selectedObstacle) {
    const axis = pickRotationRing(e);
    if (axis) {
      isRotating = true;
      activeRotAxis = axis;
      controls.enabled = false;
      rotStartMouse.set(e.clientX, e.clientY);
      // Store the current quaternion as the starting rotation
      obsStartQuat.copy(selectedObstacle.mesh.quaternion);
      renderer.domElement.style.cursor = 'grabbing';
      return;
    }
  }

  // Drag any obstacle (not just player ones)
  const obs = pickObstacle(e);
  if (obs) {
    draggedObstacle = obs;
    controls.enabled = false;
    // Compute offset on a plane at the obstacle's own Y height
    const dragPlaneY = obs.mesh.position.y;
    const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -dragPlaneY);
    const m2 = new THREE.Vector2(
      (e.clientX / window.innerWidth) * 2 - 1,
      -(e.clientY / window.innerHeight) * 2 + 1
    );
    raycaster.setFromCamera(m2, camera);
    const hit = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, hit);
    if (hit) {
      dragOffset.set(obs.mesh.position.x - hit.x, 0, obs.mesh.position.z - hit.z);
    } else {
      dragOffset.set(0, 0, 0);
    }
    renderer.domElement.style.cursor = 'grabbing';
    return;
  }
});

renderer.domElement.addEventListener('pointerup', () => {
  if (isRotating) {
    isRotating = false;
    activeRotAxis = null;
    renderer.domElement.style.cursor = 'default';
    controls.enabled = true;
    // Commit the final rotation: update matrixWorld so next rotation starts from here
    if (selectedObstacle) {
      selectedObstacle.mesh.updateMatrixWorld(true);
      updateHelperTransform();
      updateAngleDisplay();
    }
    return;
  }
  if (draggedObstacle) {
    // Commit the position change to matrixWorld
    draggedObstacle.mesh.updateMatrixWorld(true);
    draggedObstacle = null;
    renderer.domElement.style.cursor = 'default';
  }
  controls.enabled = true;
});

// Double-click to select/deselect for rotation (works on ALL obstacles)
renderer.domElement.addEventListener('dblclick', (e) => {
  if (isPlaying) return;
  const obs = pickObstacle(e);
  if (obs) {
    selectObstacle(obs);
  } else {
    deselectObstacle();
  }
});

// Hover cursor — highlight all obstacles
renderer.domElement.addEventListener('mousemove', (e) => {
  if (draggedObstacle || isRotating) return;
  if (selectedObstacle) {
    const axis = pickRotationRing(e);
    if (axis) {
      renderer.domElement.style.cursor = 'grab';
      return;
    }
  }
  const obs = pickObstacle(e);
  renderer.domElement.style.cursor = obs ? 'grab' : 'default';
});

// ── Keyboard shortcuts (Delete & Clone) ──
window.addEventListener('keydown', (e) => {
  if (isPlaying || !selectedObstacle) return;

  if (e.key === 'Delete' || e.key === 'Backspace') {
    obstacleMeshes.remove(selectedObstacle.mesh);
    const idx = obstacles.indexOf(selectedObstacle);
    if (idx > -1) obstacles.splice(idx, 1);
    const pIdx = playerObstacles.indexOf(selectedObstacle);
    if (pIdx > -1) playerObstacles.splice(pIdx, 1);
    deselectObstacle();
  } else if (e.key.toLowerCase() === 'c') {
    const newObs = addObstacle(
      selectedObstacle.type,
      selectedObstacle.x + 2, selectedObstacle.z + 2,
      selectedObstacle,
      selectedObstacle.isPlayer
    );
    newObs.mesh.rotation.copy(selectedObstacle.mesh.rotation);
    newObs.mesh.updateMatrixWorld(true);
    selectObstacle(newObs);
  }
});

// ── Hole VFX: splash/burst particles when fluid enters the hole ──
const MAX_HOLE_VFX = 300;
const holeVfxParticles = [];
const holeVfxGeo = new THREE.SphereGeometry(0.08, 4, 3);
const holeVfxMat = new THREE.MeshStandardNodeMaterial();
holeVfxMat.colorNode = color(0x44ff88);
holeVfxMat.emissiveNode = color(0x22ff66);
holeVfxMat.roughnessNode = float(0.1);
holeVfxMat.transparent = true;
holeVfxMat.opacity = 0.9;
const holeVfxInstanced = new THREE.InstancedMesh(holeVfxGeo, holeVfxMat, MAX_HOLE_VFX);
holeVfxInstanced.count = 0;
holeVfxInstanced.name = 'holeVfxParticles';
scene.add(holeVfxInstanced);

// Ring wave effect meshes (expanding rings on capture)
const MAX_RINGS = 8;
const holeRings = [];
const holeRingGeo = new THREE.TorusGeometry(1, 0.06, 8, 48);
const holeRingMat = new THREE.MeshStandardNodeMaterial();
holeRingMat.colorNode = color(0x44ff88);
holeRingMat.emissiveNode = color(0x33ff77);
holeRingMat.roughnessNode = float(0.1);
holeRingMat.transparent = true;
holeRingMat.opacity = 0.8;

const holeRingMeshes = [];
for (let i = 0; i < MAX_RINGS; i++) {
  const ring = new THREE.Mesh(holeRingGeo, holeRingMat.clone());
  ring.name = `holeRing_${i}`;
  ring.rotation.x = -Math.PI / 2;
  ring.visible = false;
  scene.add(ring);
  holeRingMeshes.push(ring);
}

let ringSpawnTimer = 0;
let capturedLastFrame = 0;

function spawnHoleVfx(count) {
  if (!exitHole) return;
  const r = exitHole.radius;
  for (let i = 0; i < count && holeVfxParticles.length < MAX_HOLE_VFX; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = r * (0.5 + Math.random() * 0.5);
    const speed = 0.06 + Math.random() * 0.1;
    holeVfxParticles.push({
      x: exitHole.x + Math.cos(angle) * dist,
      y: FLOOR_Y + 0.2 + Math.random() * 0.5,
      z: exitHole.z + Math.sin(angle) * dist,
      vx: Math.cos(angle) * speed * 0.3,
      vy: 0.04 + Math.random() * 0.08,
      vz: Math.sin(angle) * speed * 0.3,
      life: 0.6 + Math.random() * 0.6,
      maxLife: 0.6 + Math.random() * 0.6,
      size: 0.06 + Math.random() * 0.1,
    });
  }
}

function spawnHoleRing() {
  if (!exitHole) return;
  for (let i = 0; i < MAX_RINGS; i++) {
    if (!holeRingMeshes[i].visible) {
      holeRings[i] = { life: 1.0, scale: 0.3 };
      holeRingMeshes[i].visible = true;
      holeRingMeshes[i].position.set(exitHole.x, FLOOR_Y + 0.1, exitHole.z);
      holeRingMeshes[i].scale.setScalar(0.3);
      break;
    }
  }
}

// ── Screen shake / camera pulse ──
let shakeIntensity = 0;
let shakeDecay = 0.9;
let lastMilestone = 0;
const cameraBasePos = new THREE.Vector3();
let pulseScale = 0;

function triggerScreenShake(intensity) {
  shakeIntensity = intensity;
}

function triggerCameraPulse() {
  pulseScale = 1.0;
}

// ── Animate ──
let frameCount = 0;
let lastFrameTime = performance.now();

function animate() {
  frameCount++;
  updateFPS();

  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  if (isPlaying) {
    levelTime += dt;
    simulate();
  }

  updateInstances();

  // ── Hole VFX update ──
  {
    // Detect new captures this frame
    const newCaptures = totalCaptured - capturedLastFrame;
    if (newCaptures > 0 && isPlaying) {
      spawnHoleVfx(Math.min(newCaptures * 3, 15));
      ringSpawnTimer += newCaptures;
      if (ringSpawnTimer >= 3) {
        spawnHoleRing();
        ringSpawnTimer = 0;
      }
    }
    // Milestone check — every 100th capture
    const currentMilestone = Math.floor(totalCaptured / 100);
    if (currentMilestone > lastMilestone && totalCaptured > 0) {
      lastMilestone = currentMilestone;
      // Burst extra VFX
      spawnHoleVfx(30);
      spawnHoleRing();
      spawnHoleRing();
    }
    capturedLastFrame = totalCaptured;

    // Update VFX splash particles
    let vfxAlive = 0;
    const vfxMatArr = holeVfxInstanced.instanceMatrix.array;
    for (let vi = holeVfxParticles.length - 1; vi >= 0; vi--) {
      const vp = holeVfxParticles[vi];
      vp.life -= 0.016;
      if (vp.life <= 0) {
        holeVfxParticles.splice(vi, 1);
        continue;
      }
      vp.vy -= 0.002; // gravity
      vp.x += vp.vx;
      vp.y += vp.vy;
      vp.z += vp.vz;
      // Fade spiral toward hole center
      if (exitHole) {
        const dx = exitHole.x - vp.x;
        const dz = exitHole.z - vp.z;
        vp.vx += dx * 0.003;
        vp.vz += dz * 0.003;
      }

      const t = vp.life / vp.maxLife;
      const s = vp.size * t;
      const off = vfxAlive * 16;
      vfxMatArr[off] = s;     vfxMatArr[off+1] = 0;  vfxMatArr[off+2] = 0;  vfxMatArr[off+3] = 0;
      vfxMatArr[off+4] = 0;   vfxMatArr[off+5] = s;  vfxMatArr[off+6] = 0;  vfxMatArr[off+7] = 0;
      vfxMatArr[off+8] = 0;   vfxMatArr[off+9] = 0;  vfxMatArr[off+10] = s; vfxMatArr[off+11] = 0;
      vfxMatArr[off+12] = vp.x; vfxMatArr[off+13] = vp.y; vfxMatArr[off+14] = vp.z; vfxMatArr[off+15] = 1;
      vfxAlive++;
    }
    holeVfxInstanced.count = vfxAlive;
    holeVfxInstanced.instanceMatrix.needsUpdate = true;

    // Update expanding ring waves
    for (let ri = 0; ri < MAX_RINGS; ri++) {
      if (!holeRingMeshes[ri].visible) continue;
      const rd = holeRings[ri];
      if (!rd) { holeRingMeshes[ri].visible = false; continue; }
      rd.life -= 0.015;
      rd.scale += 0.04;
      if (rd.life <= 0) {
        holeRingMeshes[ri].visible = false;
        continue;
      }
      holeRingMeshes[ri].scale.setScalar(rd.scale);
      holeRingMeshes[ri].material.opacity = rd.life * 0.7;
      holeRingMeshes[ri].position.y = FLOOR_Y + 0.1 + (1 - rd.life) * 0.5;
    }
  }

  // Animate exit ring glow
  if (exitRingMesh) {
    const t = performance.now() * 0.003;
    const pulse = 1 + Math.sin(t) * 0.06;
    exitRingMesh.scale.setScalar(pulse);
    if (exitGlowMesh) {
      exitGlowMesh.scale.setScalar(1 + Math.sin(t * 0.7) * 0.15);
    }
  }

  // Animate inner glow
  if (exitInnerGlowMesh) {
    const t = performance.now() * 0.004;
    exitInnerGlowMesh.rotation.y += 0.01;
    const glowPulse = 0.2 + Math.sin(t) * 0.08;
    exitInnerGlowMesh.material.opacity = glowPulse;
  }

  // Update falling particles inside the hole
  {
    let aliveCount = 0;
    const fallMatArr = fallingInstanced.instanceMatrix.array;
    for (let fi = fallingParticles.length - 1; fi >= 0; fi--) {
      const fp = fallingParticles[fi];
      fp.life -= 0.012;
      if (fp.life <= 0) {
        fallingParticles.splice(fi, 1);
        continue;
      }
      // Spiral inward and fall
      fp.vy -= 0.003; // gravity
      fp.y += fp.vy;
      fp.angle += 0.08;
      fp.dist *= 0.96; // spiral inward
      if (exitHole) {
        fp.x = exitHole.x + Math.cos(fp.angle) * fp.dist;
        fp.z = exitHole.z + Math.sin(fp.angle) * fp.dist;
      }

      // Clamp to hole depth
      const minY = FLOOR_Y - HOLE_DEPTH + 0.3;
      if (fp.y < minY) {
        fp.y = minY;
        fp.vy *= -0.2;
      }

      const s = Math.max(fp.life * 0.8, 0.1);
      const off = aliveCount * 16;
      fallMatArr[off] = s;     fallMatArr[off + 1] = 0;  fallMatArr[off + 2] = 0;  fallMatArr[off + 3] = 0;
      fallMatArr[off + 4] = 0; fallMatArr[off + 5] = s;  fallMatArr[off + 6] = 0;  fallMatArr[off + 7] = 0;
      fallMatArr[off + 8] = 0; fallMatArr[off + 9] = 0;  fallMatArr[off + 10] = s; fallMatArr[off + 11] = 0;
      fallMatArr[off + 12] = fp.x; fallMatArr[off + 13] = fp.y; fallMatArr[off + 14] = fp.z; fallMatArr[off + 15] = 1;
      aliveCount++;
    }
    fallingInstanced.count = aliveCount;
    fallingInstanced.instanceMatrix.needsUpdate = true;
  }

  // Animate emitter
  if (emitterMesh) {
    const t = performance.now() * 0.002;
    emitterMesh.position.y = emitterPos.y + Math.sin(t) * 0.3;
    emitterMesh.scale.setScalar(1 + Math.sin(t * 2) * 0.1);
  }

  // Animate rotation helper
  if (rotationHelper.visible && selectedObstacle) {
    updateHelperTransform();
  }

  // Pulse player obstacles gently
  for (const obs of playerObstacles) {
    if (obs === selectedObstacle) {
      const t = performance.now() * 0.005;
      // Subtle glow effect (scale bounce)
      const s = 1 + Math.sin(t) * 0.02;
      // Don't override obstacle scale
    }
  }

  // Screen shake
  if (shakeIntensity > 0.01) {
    const sx = (Math.random() - 0.5) * shakeIntensity;
    const sy = (Math.random() - 0.5) * shakeIntensity * 0.6;
    const sz = (Math.random() - 0.5) * shakeIntensity * 0.3;
    camera.position.x += sx;
    camera.position.y += sy;
    camera.position.z += sz;
    shakeIntensity *= shakeDecay;
  }

  // Camera FOV pulse
  if (pulseScale > 0.01) {
    camera.fov = 50 + pulseScale * 3;
    camera.updateProjectionMatrix();
    pulseScale *= 0.92;
  } else if (camera.fov !== 50) {
    camera.fov = 50;
    camera.updateProjectionMatrix();
  }

  controls.update();
  renderer.render(scene, camera);

  // UI updates
  if (frameCount % 15 === 0) {
    const capturedEl = document.getElementById('capturedCount');
    if (capturedEl) capturedEl.textContent = totalCaptured;
    const spilledEl = document.getElementById('spilledCount');
    if (spilledEl) spilledEl.textContent = spilledParticles;
    const timeEl = document.getElementById('levelTimer');
    if (timeEl) timeEl.textContent = levelTime.toFixed(1) + 's';
    const goalEl = document.getElementById('goalCount');
    if (goalEl && levels[levelIndex]) goalEl.textContent = levels[levelIndex].goal;
    // Update progress bar
    const bar = document.getElementById('progressBar');
    if (bar && levels[levelIndex]) {
      const pct = Math.min(100, (totalCaptured / levels[levelIndex].goal) * 100);
      bar.style.width = pct + '%';
    }
  }
}

renderer.setAnimationLoop(animate);

// ── Resize ──
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── UI ──
function updateUI() {
  const lvl = levels[levelIndex];
  const nameEl = document.getElementById('levelName');
  if (nameEl) nameEl.textContent = lvl.name;
  const descEl = document.getElementById('levelDesc');
  if (descEl) descEl.textContent = lvl.description;
  const goalEl = document.getElementById('goalCount');
  if (goalEl) goalEl.textContent = lvl.goal;
  const spillLimitEl = document.getElementById('spillLimitCount');
  if (spillLimitEl) spillLimitEl.textContent = lvl.spillLimit;
  const capturedEl = document.getElementById('capturedCount');
  if (capturedEl) capturedEl.textContent = '0';
  const spilledEl = document.getElementById('spilledCount');
  if (spilledEl) spilledEl.textContent = '0';
  const timeEl = document.getElementById('levelTimer');
  if (timeEl) timeEl.textContent = '0.0s';
  const statusEl = document.getElementById('statusText');
  if (statusEl) {
    statusEl.textContent = isPlaying ? '▶ Flow running...' : '⏸ Set your ramps, then start';
    statusEl.classList.toggle('running', isPlaying);
  }
  // Reset progress bar
  const bar = document.getElementById('progressBar');
  if (bar) bar.style.width = '0%';
}

function updateLevelSelect() {
  document.querySelectorAll('.lvl-btn').forEach((btn, i) => {
    btn.classList.toggle('active', i === levelIndex);
  });
}

// Build UI
const uiContainer = document.createElement('div');
uiContainer.innerHTML = `
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@700&family=DM+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap');

    :root {
      --cream: #f5f0e8;
      --sand: #e8dcc8;
      --sand-dark: #d4c4a8;
      --terra: #c4714a;
      --terra-light: #d4835e;
      --terra-deep: #a85a38;
      --sage: #7a9e7e;
      --sage-light: #98bb9c;
      --sage-dark: #5a7a5e;
      --warm-brown: #6b4c35;
      --warm-brown-light: #8a6248;
      --ink: #3a2e24;
      --ink-light: #5a4838;
      --mist: rgba(245,240,232,0.94);
    }

    .game-ui {
      position: fixed; top: 20px; left: 20px;
      font-family: 'DM Sans', system-ui, sans-serif;
      width: 276px;
      background: var(--mist);
      backdrop-filter: blur(24px) saturate(1.5);
      border-radius: 22px;
      border: 1px solid rgba(212,196,168,0.8);
      box-shadow: 0 12px 40px rgba(58,46,36,0.2), 0 2px 8px rgba(58,46,36,0.08), inset 0 1px 0 rgba(255,255,255,0.9);
      overflow: hidden;
      user-select: none;
      z-index: 100;
    }

    /* Banner */
    .ui-banner {
      background: linear-gradient(135deg, var(--terra) 0%, var(--terra-deep) 100%);
      padding: 16px 18px 14px;
      position: relative; overflow: hidden;
    }
    .ui-banner::before {
      content: ''; position: absolute; inset: 0;
      background: radial-gradient(circle at 80% 20%, rgba(255,255,255,0.12) 0%, transparent 60%);
    }
    .ui-game-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 20px; font-weight: 700;
      color: rgba(255,255,255,0.97);
      letter-spacing: 0.2px; line-height: 1.1;
      position: relative;
    }
    .ui-level-tag {
      display: inline-flex; align-items: center; gap: 5px;
      margin-top: 6px;
      background: rgba(255,255,255,0.18);
      border: 1px solid rgba(255,255,255,0.25);
      border-radius: 20px;
      padding: 3px 10px;
      font-size: 10.5px; font-weight: 600;
      color: rgba(255,255,255,0.92);
      letter-spacing: 0.3px;
      position: relative;
    }
    .ui-level-dot {
      width: 5px; height: 5px; border-radius: 50%;
      background: rgba(255,255,255,0.7); flex-shrink: 0;
    }
    .ui-desc {
      margin-top: 8px; font-size: 11px;
      color: rgba(255,255,255,0.7);
      line-height: 1.4; font-style: italic;
      position: relative;
    }

    /* Body */
    .ui-body { padding: 14px 16px 16px; }

    /* Section label */
    .ui-section-title {
      font-size: 9px; font-weight: 700;
      letter-spacing: 1.4px; text-transform: uppercase;
      color: var(--sand-dark); margin-bottom: 8px;
    }

    /* Level pills */
    .level-strip {
      display: flex; gap: 5px; flex-wrap: wrap;
      padding-bottom: 4px; margin-bottom: 14px;
    }
    .lvl-btn {
      flex-shrink: 0;
      min-width: 28px; height: 28px; border-radius: 50%;
      border: 1.5px solid var(--sand-dark);
      background: rgba(255,255,255,0.6);
      color: var(--warm-brown);
      font-family: 'DM Sans', sans-serif;
      font-size: 11px; font-weight: 700;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: all 0.18s ease;
      box-shadow: 0 1px 3px rgba(58,46,36,0.1);
    }
    .lvl-btn:hover { border-color: var(--terra); background: rgba(196,113,74,0.14); color: var(--terra-deep); transform: scale(1.12); }
    .lvl-btn.active { background: var(--terra); color: #fff; border-color: var(--terra-deep); box-shadow: 0 3px 10px rgba(196,113,74,0.4); transform: scale(1.08); }

    /* Stats */
    .stats-row {
      display: grid; grid-template-columns: 1fr 1fr 1fr;
      gap: 8px; margin-bottom: 8px;
    }
    .stat-block {
      background: rgba(255,255,255,0.65);
      border: 1px solid var(--sand);
      border-radius: 12px; padding: 10px 12px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 1px 3px rgba(58,46,36,0.06);
    }
    .stat-label {
      font-size: 8.5px; font-weight: 700;
      letter-spacing: 1.1px; text-transform: uppercase;
      color: var(--warm-brown-light); margin-bottom: 3px;
    }
    .stat-num {
      font-size: 22px; font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1; color: var(--ink);
    }
    .stat-num.goal { color: var(--sage-dark); }
    .stat-num.time { color: var(--terra); }
    .stat-num.error { color: var(--terra-deep); }
    .stat-denom { font-size: 10px; color: var(--warm-brown-light); font-weight: 400; margin-left: 1px; }

    /* Progress */
    .prog-wrap {
      height: 5px; background: var(--sand);
      border-radius: 5px; margin: 2px 0 12px; overflow: hidden;
    }
    .prog-fill {
      height: 100%;
      background: linear-gradient(90deg, var(--sage-light), var(--sage-dark));
      border-radius: 5px; width: 0%;
      transition: width 0.5s cubic-bezier(0.4,0,0.2,1);
    }

    /* Buttons */
    .btn-row { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; margin-bottom: 10px; }
    .redirect-btn {
      width: 46px; height: 46px;
      border: 1.5px solid #e05080; border-radius: 14px;
      background: rgba(224,80,128,0.18);
      color: #e05080; font-size: 15px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.5);
      flex-shrink: 0; transition: all 0.2s ease;
    }
    .redirect-btn:hover { background: rgba(224,80,128,0.32); transform: scale(1.08); }
    .movers-btn {
      width: 46px; height: 46px;
      border: 1.5px solid var(--sand-dark); border-radius: 14px;
      background: rgba(255,255,255,0.55);
      color: var(--warm-brown); font-size: 15px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; transition: all 0.2s ease;
    }
    .movers-btn:hover { border-color: var(--terra); background: rgba(196,113,74,0.1); color: var(--terra-deep); }
    .movers-btn.paused { background: rgba(196,113,74,0.18); border-color: var(--terra); color: var(--terra-deep); }
    .play-btn {
      width: 100%;
      padding: 13px 0; border: none; border-radius: 14px;
      background: linear-gradient(160deg, var(--sage-light) 0%, var(--sage-dark) 100%);
      color: #fff;
      font-family: 'DM Sans', sans-serif;
      font-size: 14px; font-weight: 700;
      cursor: pointer; transition: all 0.22s ease;
      letter-spacing: 0.3px;
      box-shadow: 0 4px 14px rgba(90,122,94,0.38), inset 0 1px 0 rgba(255,255,255,0.3);
      display: flex; align-items: center; justify-content: center; gap: 6px;
    }
    .play-btn:hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(90,122,94,0.45), inset 0 1px 0 rgba(255,255,255,0.3); }
    .play-btn:active { transform: translateY(0); }
    .play-btn.stop { background: linear-gradient(160deg, #d98060 0%, var(--terra-deep) 100%); box-shadow: 0 4px 14px rgba(196,113,74,0.38), inset 0 1px 0 rgba(255,255,255,0.25); }
    .play-btn.stop:hover { box-shadow: 0 8px 20px rgba(196,113,74,0.45), inset 0 1px 0 rgba(255,255,255,0.25); }

    .reset-btn {
      width: 46px; height: 46px;
      border: 1.5px solid var(--sand-dark); border-radius: 14px;
      background: rgba(255,255,255,0.55);
      color: var(--warm-brown); font-size: 18px;
      cursor: pointer; transition: all 0.2s ease;
      display: flex; align-items: center; justify-content: center;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.8);
      flex-shrink: 0;
    }
    .reset-btn:hover { border-color: var(--terra-light); background: rgba(196,113,74,0.1); color: var(--terra-deep); transform: rotate(-30deg) scale(1.1); }

    /* Status */
    .status-bar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; border-radius: 10px;
      background: rgba(122,158,126,0.12);
      border: 1px solid rgba(122,158,126,0.22);
      margin-bottom: 12px; transition: all 0.3s ease;
    }
    .status-bar.running { background: rgba(196,113,74,0.1); border-color: rgba(196,113,74,0.25); }
    .status-dot {
      width: 6px; height: 6px; border-radius: 50%;
      background: var(--sage); flex-shrink: 0; transition: background 0.3s;
    }
    .status-bar.running .status-dot { background: var(--terra); animation: pulse-dot 1.2s ease-in-out infinite; }
    @keyframes pulse-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.6); opacity: 0.5; }
    }
    .status-text-inner { font-size: 11px; font-weight: 600; color: var(--sage-dark); transition: color 0.3s; }
    .status-bar.running .status-text-inner { color: var(--terra-deep); }

    /* Cheat button */
    #cheatBtn {
      display: none;
      width: 46px; height: 46px;
      border: 1.5px solid #ff6b35;
      border-radius: 14px;
      background: rgba(255, 107, 53, 0.18);
      color: #ff6b35;
      font-size: 16px;
      cursor: pointer;
      align-items: center; justify-content: center;
      box-shadow: 0 0 0 0 rgba(255,107,53,0.5);
      animation: cheat-pulse 1.4s ease-in-out infinite;
      flex-shrink: 0;
      transition: all 0.2s ease;
    }
    #cheatBtn:hover { background: rgba(255,107,53,0.32); transform: scale(1.1); }
    @keyframes cheat-pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(255,107,53,0.5); }
      50% { box-shadow: 0 0 0 8px rgba(255,107,53,0); }
    }

    /* Roast toast */
    #roastToast {
      position: fixed;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      font-family: 'DM Sans', sans-serif;
      font-size: 13px; font-weight: 600;
      color: #fff;
      background: linear-gradient(135deg, #1a1208, #3a2010);
      border: 1.5px solid #ff6b35;
      border-radius: 20px;
      padding: 10px 22px;
      z-index: 9999;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.4s ease, transform 0.4s cubic-bezier(0.34,1.56,0.64,1);
      box-shadow: 0 6px 24px rgba(255,107,53,0.3);
      max-width: 380px;
      text-align: center;
    }

    /* Help */
    .help-section { border-top: 1px solid var(--sand); padding-top: 10px; }
    .help-title { font-size: 9px; font-weight: 700; letter-spacing: 1.4px; text-transform: uppercase; color: var(--sand-dark); margin-bottom: 7px; }
    .help-row { display: flex; align-items: center; gap: 7px; font-size: 10.5px; color: var(--warm-brown-light); line-height: 1.6; margin-bottom: 2px; }
    .help-key {
      flex-shrink: 0;
      background: rgba(255,255,255,0.85);
      border: 1px solid var(--sand-dark); border-bottom-width: 2px;
      border-radius: 5px; padding: 1px 6px;
      font-size: 9px; font-weight: 700;
      color: var(--ink-light); font-family: monospace;
    }

    /* Angle panel */
    #anglePanel {
      display: none;
      position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%);
      font-family: 'DM Sans', sans-serif;
      background: var(--mist);
      backdrop-filter: blur(20px) saturate(1.4);
      padding: 14px 22px; border-radius: 16px;
      border: 1px solid var(--sand-dark);
      box-shadow: 0 8px 28px rgba(58,46,36,0.18), inset 0 1px 0 rgba(255,255,255,0.7);
      color: var(--ink-light); font-size: 12px;
      z-index: 100; user-select: none;
      gap: 22px; align-items: center;
    }
    .angle-axis { display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .angle-label { font-size: 9px; font-weight: 700; letter-spacing: 0.8px; text-transform: uppercase; }
    .angle-label.rx { color: var(--terra); }
    .angle-label.ry { color: var(--sage-dark); }
    .angle-label.rz { color: var(--warm-brown); }
    .angle-val { font-size: 15px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }

    /* Win overlay */
    .win-overlay {
      display: none; position: fixed; inset: 0;
      background: rgba(58,46,36,0.6);
      backdrop-filter: blur(12px) saturate(1.2);
      z-index: 1000; flex-direction: column;
      align-items: center; justify-content: center;
      font-family: 'DM Sans', sans-serif;
    }
    .win-box {
      background: var(--mist); border: 1px solid var(--sand-dark);
      border-radius: 24px; padding: 36px 44px; text-align: center;
      box-shadow: 0 24px 60px rgba(58,46,36,0.25), inset 0 1px 0 rgba(255,255,255,0.8);
      max-width: 340px;
    }
    .win-badge { font-size: 48px; margin-bottom: 12px; animation: winBounce 0.6s cubic-bezier(0.36,0.07,0.19,0.97) both; }
    @keyframes winBounce { 0%,100%{transform:scale(1)} 30%{transform:scale(1.25) rotate(-5deg)} 60%{transform:scale(0.9) rotate(3deg)} }
    .win-title { font-family: 'Playfair Display', Georgia, serif; font-size: 26px; font-weight: 700; color: var(--ink); margin-bottom: 4px; }
    .win-subtitle { font-size: 13px; color: var(--warm-brown-light); margin-bottom: 20px; }
    .win-stats { display: flex; gap: 16px; justify-content: center; margin-bottom: 22px; }
    .win-stat-card { background: rgba(255,255,255,0.6); border: 1px solid var(--sand); border-radius: 12px; padding: 10px 16px; min-width: 72px; }
    .win-stat-label { font-size: 9px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; color: var(--warm-brown-light); margin-bottom: 4px; }
    .win-stat-value { font-size: 22px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
    .win-btn { padding: 11px 24px; border: none; border-radius: 12px; font-family: 'DM Sans', sans-serif; font-size: 13px; font-weight: 600; cursor: pointer; margin: 0 5px; transition: all 0.2s ease; }
    .win-btn.secondary { background: rgba(255,255,255,0.6); color: var(--warm-brown); border: 1.5px solid var(--sand-dark); }
    .win-btn.secondary:hover { background: rgba(255,255,255,0.9); transform: translateY(-1px); }
    .win-btn.primary { background: linear-gradient(135deg, var(--terra-light), var(--terra-deep)); color: #fff; box-shadow: 0 3px 12px rgba(196,113,74,0.35); }
    .win-btn.primary:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(196,113,74,0.4); }

    /* FPS */
    .fps-display {
      position: fixed; top: 20px; right: 20px;
      font-family: 'DM Sans', monospace;
      color: var(--warm-brown); font-size: 12px; font-weight: 600;
      background: rgba(245,240,232,0.88); backdrop-filter: blur(12px);
      padding: 6px 12px; border-radius: 10px;
      border: 1px solid var(--sand-dark);
      box-shadow: 0 2px 8px rgba(58,46,36,0.1), inset 0 1px 0 rgba(255,255,255,0.7);
      pointer-events: none; user-select: none; z-index: 100;
    }

    /* Hide UI button */
    .hide-btn {
      position: absolute; top: 16px; right: 16px;
      width: 24px; height: 24px;
      border: none; border-radius: 6px;
      background: rgba(255,255,255,0.18);
      color: #fff; font-size: 16px; font-weight: bold;
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; transition: all 0.2s;
    }
    .hide-btn:hover { background: rgba(255,255,255,0.3); }
    .game-ui.collapsed .ui-body { display: none; }
    .game-ui.collapsed .ui-desc { display: none; }
  </style>

  <!-- FPS -->
  <div class="fps-display">
    <span style="color:var(--warm-brown-light);font-size:10px;font-weight:500;letter-spacing:0.5px;">FPS</span>
    <span id="fpsDisplay" style="margin-left:5px;font-variant-numeric:tabular-nums;color:var(--ink);">60</span>
  </div>

  <!-- Main panel -->
  <div class="game-ui">

    <!-- Top banner -->
    <div class="ui-banner">
      <div class="ui-game-title">🌊 Fluid Puzzle</div>
      <div class="ui-level-tag">
        <span class="ui-level-dot"></span>
        <span id="levelName">The Funnel</span>
      </div>
      <div class="ui-desc" id="levelDesc">Guide particles down into the exit hole!</div>
      <button class="hide-btn" id="hideUiBtn" title="Toggle UI">−</button>
    </div>

    <!-- Body -->
    <div class="ui-body">

      <!-- Level picker -->
      <div class="ui-section-title">Level</div>
      <div class="level-strip">
        ${levels.map((l, i) => `<div class="lvl-btn ${i === 0 ? 'active' : ''}" data-level="${i}" title="${l.name}">${i + 1}</div>`).join('')}
      </div>

      <!-- Stats -->
      <div class="stats-row">
        <div class="stat-block">
          <div class="stat-label">Captured</div>
          <div class="stat-num goal">
            <span id="capturedCount">0</span><span class="stat-denom"> / <span id="goalCount">5000</span></span>
          </div>
        </div>
        <div class="stat-block">
          <div class="stat-label">Spilled</div>
          <div class="stat-num error">
            <span id="spilledCount">0</span><span class="stat-denom"> / <span id="spillLimitCount">1000</span></span>
          </div>
        </div>
        <div class="stat-block">
          <div class="stat-label">Time</div>
          <div class="stat-num time" id="levelTimer">0.0s</div>
        </div>
      </div>

      <!-- Progress bar -->
      <div class="prog-wrap"><div class="prog-fill" id="progressBar"></div></div>

      <!-- Action buttons -->
      <div class="btn-row">
        <button class="play-btn" id="playBtn"><span>▶</span> Start Flow</button>
        <button class="reset-btn" id="resetBtn" title="Reset level">↺</button>
        <button class="redirect-btn" id="spawnRedirectBtn" title="Spawn a redirector (bounce wall)">↗</button>
        <button class="reset-btn" id="spawnAccelBtn" title="Spawn a speed pad" style="font-size: 14px; background: rgba(255,170,51,0.55); border-color: #ffaa33;">🚀</button>
        <button class="movers-btn" id="toggleMoversBtn" title="Pause/resume moving obstacles">⏸</button>
        <button id="cheatBtn" title="Bot mode: spawn a free ramp">🤖</button>
      </div>

      <!-- Status -->
      <div class="status-bar" id="statusBar">
        <span class="status-dot"></span>
        <span class="status-text-inner" id="statusText">Position your ramps, then start</span>
      </div>

      <!-- Help -->
      <div class="help-section">
        <div class="help-title">Controls</div>
        <div class="help-row"><span class="help-key">drag</span> Move a blue ramp</div>
        <div class="help-row"><span class="help-key">Alt+drag</span> Move up / down</div>
        <div class="help-row"><span class="help-key">dbl‑click</span> Show rotation rings</div>
        <div class="help-row"><span class="help-key">Shift</span> Snap to grid</div>
        <div class="help-row"><span class="help-key">Del</span> / <span class="help-key">C</span> Delete / Clone selected</div>
      </div>

    </div>
  </div>

  <!-- Angle panel -->
  <div id="anglePanel">
    <div style="font-size:10px; color:var(--warm-brown-light); font-weight:700; letter-spacing:1px; text-transform:uppercase; margin-right:12px;">Rotation</div>
    <div class="angle-axis">
      <span class="angle-label rx">X</span>
      <span class="angle-val" id="angleX">0°</span>
    </div>
    <div class="angle-axis">
      <span class="angle-label ry">Y</span>
      <span class="angle-val" id="angleY">0°</span>
    </div>
    <div class="angle-axis">
      <span class="angle-label rz">Z</span>
      <span class="angle-val" id="angleZ">0°</span>
    </div>
  </div>

  <!-- Win overlay -->
  <div class="win-overlay" id="winOverlay">
    <div class="win-box">
      <div class="win-badge">🏆</div>
      <div class="win-title">Level Complete!</div>
      <div class="win-subtitle">All particles captured — well done!</div>
      <div id="winStars" style="font-size: 24px; margin-bottom: 15px; letter-spacing: 5px; text-shadow: 0 2px 8px rgba(0,0,0,0.1);">⭐⭐⭐</div>
      <div class="win-stats">
        <div class="win-stat-card">
          <div class="win-stat-label">Captured</div>
          <div class="win-stat-value" id="winCaptured">5000</div>
        </div>
        <div class="win-stat-card">
          <div class="win-stat-label">Time</div>
          <div class="win-stat-value" id="winTime">12s</div>
        </div>
        <div class="win-stat-card">
          <div class="win-stat-label">Best</div>
          <div class="win-stat-value" id="winBest">--</div>
        </div>
      </div>
      <button class="win-btn secondary" id="winRetry">↺ Retry</button>
      <button class="win-btn primary" id="winNext">Next Level →</button>
    </div>
  </div>

  <!-- Fail Overlay -->
  <div class="win-overlay" id="failOverlay">
    <div class="win-box">
      <div class="win-badge" style="filter: hue-rotate(180deg) brightness(0.9);">💥</div>
      <div class="win-title" style="color: var(--terra-deep);">Spill Limit Exceeded</div>
      <div class="win-subtitle">Too many particles were lost! Adjust your ramps and try again.</div>
      <br>
      <button class="win-btn primary" id="failRetry" style="width: 100%;">↺ Try Again</button>
    </div>
  </div>

  <!-- Roast Toast -->
  <div id="roastToast"></div>
`;
document.body.appendChild(uiContainer);

// Badge
const badge = document.createElement('div');
badge.style.cssText = `
  position: fixed; bottom: 18px; left: 50%;
  transform: translateX(-50%);
  font-family: 'DM Sans', system-ui, sans-serif;
  font-size: 10.5px; color: #8a6248;
  background: rgba(245,240,232,0.82);
  backdrop-filter: blur(12px);
  padding: 5px 16px;
  border-radius: 20px;
  border: 1px solid #d4c4a8;
  box-shadow: 0 2px 8px rgba(58,46,36,0.1);
  pointer-events: none;
  user-select: none;
  z-index: 10;
  letter-spacing: 0.3px;
`;
badge.textContent = 'WebGPU · Three.js r183 · Fluid Puzzle';
document.body.appendChild(badge);

// ── Light/Dark Mode Toggle ──
const LIGHT_BG = '#b9d1e9';
const DARK_BG = '#0a0e17';
let isDarkMode = false; // start in light mode (matching default #b9d1e9)

const togglePanel = document.createElement('div');
togglePanel.innerHTML = `
  <style>
    .theme-toggle {
      position: fixed; top: 20px; right: 20px; margin-top: 40px;
      font-family: 'DM Sans', system-ui, sans-serif;
      display: flex; align-items: center; gap: 8px;
      background: rgba(245,240,232,0.88);
      backdrop-filter: blur(16px);
      padding: 7px 14px;
      border-radius: 20px;
      border: 1px solid #d4c4a8;
      box-shadow: 0 2px 8px rgba(58,46,36,0.1), inset 0 1px 0 rgba(255,255,255,0.7);
      user-select: none;
      z-index: 100;
      cursor: pointer;
      transition: all 0.3s ease;
    }
    .theme-toggle:hover { transform: scale(1.03); box-shadow: 0 4px 12px rgba(58,46,36,0.15); }
    .theme-toggle-label {
      font-size: 11px; font-weight: 600; letter-spacing: 0.3px;
      color: #6b4c35;
      transition: color 0.3s ease;
    }
    .theme-toggle-track {
      width: 38px; height: 20px;
      border-radius: 10px;
      background: linear-gradient(135deg, #e8dcc8, #d4c4a8);
      position: relative;
      transition: background 0.3s ease;
      flex-shrink: 0;
      border: 1px solid #d4c4a8;
    }
    .theme-toggle-track.dark {
      background: linear-gradient(135deg, #2a1f16, #1a1208);
      border-color: #4a3828;
    }
    .theme-toggle-thumb {
      width: 16px; height: 16px;
      border-radius: 50%;
      background: #fff;
      position: absolute;
      top: 1px; left: 1px;
      transition: all 0.3s ease;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px;
      box-shadow: 0 1px 4px rgba(58,46,36,0.2);
    }
    .theme-toggle-thumb.dark {
      left: 19px;
      background: #3a2e24;
    }
  </style>
  <div class="theme-toggle" id="themeToggle">
    <span class="theme-toggle-label" id="themeLabel">☀️ Light</span>
    <div class="theme-toggle-track" id="themeTrack">
      <div class="theme-toggle-thumb" id="themeThumb">☀️</div>
    </div>
  </div>
`;
document.body.appendChild(togglePanel);

function getBrightness(hex) {
  const c = new THREE.Color(hex);
  return c.r * 0.299 + c.g * 0.587 + c.b * 0.114;
}

function updateUITheme(hex) {
  // The warm cream design doesn't need heavy theming — just handle dark mode overlay
  const bright = getBrightness(hex);
  const isLight = bright > 0.5;

  const gameUI = document.querySelector('.game-ui');
  if (gameUI) {
    gameUI.style.background = isLight
      ? 'rgba(245,240,232,0.92)'
      : 'rgba(30,22,16,0.92)';
    gameUI.style.borderColor = isLight ? '#d4c4a8' : '#4a3828';
    gameUI.style.color = isLight ? '#5a4838' : '#c4a882';
  }

  // FPS
  const fps = document.querySelector('.fps-display');
  if (fps) {
    fps.style.background = isLight ? 'rgba(245,240,232,0.88)' : 'rgba(30,22,16,0.88)';
    fps.style.borderColor = isLight ? '#d4c4a8' : '#4a3828';
    fps.style.color = isLight ? '#6b4c35' : '#c4a882';
  }

  // Badge
  const badgeEl = document.querySelector('[style*="bottom: 18px"]');
  if (badgeEl) {
    badgeEl.style.background = isLight ? 'rgba(245,240,232,0.82)' : 'rgba(30,22,16,0.82)';
    badgeEl.style.color = isLight ? '#8a6248' : '#8a7060';
    badgeEl.style.borderColor = isLight ? '#d4c4a8' : '#4a3828';
  }

  // Angle panel
  const anglePanel = document.getElementById('anglePanel');
  if (anglePanel) {
    anglePanel.style.background = isLight ? 'rgba(245,240,232,0.92)' : 'rgba(30,22,16,0.92)';
    anglePanel.style.borderColor = isLight ? '#d4c4a8' : '#4a3828';
  }

  // Store theme state
  document.body.dataset.theme = isLight ? 'light' : 'dark';
}

function setBgColor(hex) {
  // When switching themes, toggle sky visibility and background color
  const bright = getBrightness(hex);
  if (bright > 0.4) {
    // Light mode: show procedural sky
    sky.visible = true;
    scene.background = null; // let sky render as background
  } else {
    // Dark mode: hide sky, use solid color
    sky.visible = false;
    scene.background = new THREE.Color(hex);
  }
  if (scene.fog) scene.fog.color.set(hex);
  updateUITheme(hex);
}

document.getElementById('themeToggle').addEventListener('click', () => {
  isDarkMode = !isDarkMode;
  const hex = isDarkMode ? DARK_BG : LIGHT_BG;
  setBgColor(hex);

  const track = document.getElementById('themeTrack');
  const thumb = document.getElementById('themeThumb');
  const label = document.getElementById('themeLabel');
  const toggleEl = document.querySelector('.theme-toggle');

  if (isDarkMode) {
    track.classList.add('dark');
    thumb.classList.add('dark');
    thumb.textContent = '🌙';
    label.textContent = '🌙 Dark';
    toggleEl.style.background = 'rgba(30,22,16,0.92)';
    toggleEl.style.borderColor = '#4a3828';
    label.style.color = '#c4a882';
  } else {
    track.classList.remove('dark');
    thumb.classList.remove('dark');
    thumb.textContent = '☀️';
    label.textContent = '☀️ Light';
    toggleEl.style.background = 'rgba(245,240,232,0.88)';
    toggleEl.style.borderColor = '#d4c4a8';
    label.style.color = '#6b4c35';
  }
});

// ── Button handlers ──
document.getElementById('playBtn').addEventListener('click', () => {
  if (isPlaying) {
    isPlaying = false;
    const btn = document.getElementById('playBtn');
    btn.innerHTML = '<span>▶</span> Start Flow';
    btn.classList.remove('stop');
    const status = document.getElementById('statusText');
    status.textContent = '⏸ Set your ramps, then start';
    status.classList.remove('running');
  } else {
    isPlaying = true;
    deselectObstacle();
    const btn = document.getElementById('playBtn');
    btn.innerHTML = '<span>⏹</span> Stop Flow';
    btn.classList.add('stop');
    const status = document.getElementById('statusText');
    status.textContent = '▶ Flow running...';
    status.classList.add('running');
  }
});

document.getElementById('hideUiBtn').addEventListener('click', () => {
  const ui = document.querySelector('.game-ui');
  ui.classList.toggle('collapsed');
  const btn = document.getElementById('hideUiBtn');
  btn.textContent = ui.classList.contains('collapsed') ? '+' : '−';
});

document.getElementById('resetBtn').addEventListener('click', () => {
  loadLevel(levelIndex);
});


document.getElementById('spawnAccelBtn').addEventListener('click', () => {
  if (isPlaying) return;
  const newObs = addObstacle('accelerator', 0, 0, { width: 5, height: 0.35, depth: 3, elevation: 8 }, true);
  selectObstacle(newObs);
});

document.getElementById('spawnRedirectBtn').addEventListener('click', () => {
  if (isPlaying) return;
  // Spawn a tall thin wall — good for deflecting
  const newObs = addObstacle('redirector', 0, 0, { width: 4, height: 3, depth: 0.4, elevation: 6 }, true);
  selectObstacle(newObs);
});

document.getElementById('toggleMoversBtn').addEventListener('click', () => {
  movingPaused = !movingPaused;
  const btn = document.getElementById('toggleMoversBtn');
  btn.textContent = movingPaused ? '▶' : '⏸';
  btn.title = movingPaused ? 'Resume moving obstacles' : 'Pause moving obstacles';
  btn.classList.toggle('paused', movingPaused);
});

document.getElementById('cheatBtn').addEventListener('click', () => {
  if (isPlaying) return;
  // Spawn a ramp at a useful central location
  const lvl = levels[levelIndex];
  const ex = lvl.exit.x;
  const ez = lvl.exit.z;
  const emx = lvl.emitter.x;
  const emz = lvl.emitter.z;
  const midX = (ex + emx) / 2;
  const midZ = (ez + emz) / 2 - 2;
  const newObs = addObstacle('ramp', midX, midZ, { width: 8, height: 0.35, depth: 4, elevation: 7, rotX: -0.18 }, true);
  selectObstacle(newObs);
  setCheatButtonVisible(false);
  const followUpRoasts = [
    "🤖 Free ramp deployed. Don't thank me, it's embarrassing.",
    "🤖 I placed it for you. You're welcome, I guess.",
    "🤖 Ramp spawned. The particles are judging you right now.",
    "🤖 Bot work complete. Try not to fail again... please.",
  ];
  showRoastToast(followUpRoasts[Math.floor(Math.random() * followUpRoasts.length)]);
});

function resetPlayButton() {
  isPlaying = false;
  const btn = document.getElementById('playBtn');
  btn.innerHTML = '<span>▶</span> Start Flow';
  btn.classList.remove('stop');
  const status = document.getElementById('statusText');
  status.textContent = '⏸ Set your ramps, then start';
  status.classList.remove('running');
}

// Level select buttons
document.querySelectorAll('.lvl-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const idx = parseInt(btn.dataset.level);
    loadLevel(idx);
  });
});

// Win overlay buttons
document.getElementById('winRetry').addEventListener('click', () => {
  document.getElementById('winOverlay').style.display = 'none';
  loadLevel(levelIndex);
});

document.getElementById('winNext').addEventListener('click', () => {
  document.getElementById('winOverlay').style.display = 'none';
  const next = (levelIndex + 1) % levels.length;
  loadLevel(next);
});

document.getElementById('failRetry').addEventListener('click', () => {
  document.getElementById('failOverlay').style.display = 'none';
  loadLevel(levelIndex);
});

// ── Load first level ──
loadLevel(0);

// Apply initial theme — light mode with sky visible
sky.visible = true;
scene.background = null; // let Sky render the background
updateUITheme('#b9d1e9');