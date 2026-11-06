// ---------------------------------------------------------------------------
// FARQ – 3D character with realistic gaze tracking
//
// The supplied FBX contains a single skinned mesh with a neck rig
// (root → spine → chest → neck → neck.001 → head). The eyes are painted into
// the texture, so this module:
//   1. cuts the painted eye openings out of the face (alpha mask),
//   2. adds two procedural 3D eyeballs + eyelids on new "eye_L"/"eye_R" bones
//      parented to the rig's head bone,
//   3. drives eyes (fast saccades + micro-saccades + vergence), eyelids
//      (blinks, lid-follows-gaze) and the neck/head chain (slower, damped)
//      towards the mouse cursor anywhere on the page.
// ---------------------------------------------------------------------------
import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? parseFloat(params.get(k)) : d);
const DEG = Math.PI / 180;

const CFG = {
  model: '/models/character.fbx',
  textures: {
    map: '/models/textures/basecolor.jpg',
    normal: '/models/textures/normal.jpg',
    roughness: '/models/textures/roughness.jpg',
    eyeMask: '/models/textures/eye_mask.png',
  },
  // Iris centres located on the mesh (FBX geometry space) by mapping the
  // painted iris pixels in the UV layout back onto the triangles.
  eyeSurface: [
    { name: 'eye_R', p: [-0.0937, -0.2979, 0.427] },
    { name: 'eye_L', p: [0.0983, -0.2991, 0.4308] },
  ],
  eyeRadius: num('er', 0.034),       // ≈12 mm at this model's scale
  eyeInset: num('ei', 0.9),          // eyeball centre depth behind surface (× radius)
  eyeYawLimit: 34 * DEG,
  eyePitchUp: 24 * DEG,
  eyePitchDown: 28 * DEG,
  headYawLimit: 42 * DEG,
  headPitchLimit: 24 * DEG,
  irisColor: [118, 128, 112],        // grey-green, sampled from the texture
  skinColor: [184, 136, 116],
};

export async function createCharacter(container, { onProgress } = {}) {
  // ---------- renderer / scene -------------------------------------------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(24, 1, 0.01, 50); // near/far set after load

  // Lighting: warm key (casts soft shadows into the eye sockets), cool fill, rim.
  const key = new THREE.DirectionalLight(0xfff1e0, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.006;
  key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight(0xbcd2ff, 0.65);
  const rim = new THREE.DirectionalLight(0xffffff, 2.2);
  const bounce = new THREE.HemisphereLight(0xdfe8ff, 0x2a2018, 0.35);
  scene.add(key, key.target, fill, rim, bounce);

  // ---------- assets -------------------------------------------------------
  const manager = new THREE.LoadingManager();
  // The FBX references absolute texture paths from the author's machine;
  // swallow them – we build our own material below.
  const blankPixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  manager.setURLModifier((url) => (/\.(png|jpe?g|tga|tif)$/i.test(url) && !url.includes('/models/textures/') ? blankPixel : url));

  const texLoader = new THREE.TextureLoader(manager);
  const loadTex = (url, srgb) =>
    new Promise((res, rej) =>
      texLoader.load(url, (t) => {
        t.flipY = true;
        t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        res(t);
      }, undefined, rej));

  const fbxPromise = new Promise((res, rej) =>
    new FBXLoader(manager).load(CFG.model, res, (e) => e.total && onProgress?.(e.loaded / e.total), rej));

  const [fbx, map, normalMap, roughnessMap, eyeMask] = await Promise.all([
    fbxPromise,
    loadTex(CFG.textures.map, true),
    loadTex(CFG.textures.normal, false),
    loadTex(CFG.textures.roughness, false),
    loadTex(CFG.textures.eyeMask, false),
  ]);

  // Drop lights/cameras exported from the DCC.
  fbx.traverse((o) => { if (o.isLight || o.isCamera) o.visible = false; });

  let body = null;
  fbx.traverse((o) => { if (o.isSkinnedMesh && !body) body = o; });
  if (!body) fbx.traverse((o) => { if (o.isMesh && !body) body = o; });

  const skinMat = new THREE.MeshPhysicalMaterial({
    map, normalMap, roughnessMap,
    roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.8, 0.8),
    alphaMap: eyeMask, alphaTest: 0.5,
    sheen: 0.25, sheenRoughness: 0.6, sheenColor: new THREE.Color(0xffd9c4),
    specularIntensity: 0.55,
    side: THREE.FrontSide,
  });
  body.material = skinMat;
  body.castShadow = true;
  body.receiveShadow = true;
  body.frustumCulled = false;
  scene.add(fbx);
  fbx.updateMatrixWorld(true);

  // ---------- skeleton -----------------------------------------------------
  const bones = {};
  fbx.traverse((o) => { if (o.isBone) bones[o.name] = o; });
  const findBone = (...names) => names.map((n) => bones[n]).find(Boolean);
  const headBone = findBone('head', 'Head', 'mixamorigHead');
  const neckChain = [findBone('neck', 'Neck', 'mixamorigNeck'), findBone('neck.001', 'neck001'), headBone].filter(Boolean);
  const chest = findBone('chest', 'Spine2', 'mixamorigSpine2');
  const spine = findBone('spine', 'Spine', 'mixamorigSpine');

  // The face looks along FBX -Y (Blender Z-up export) → transform to world.
  const meshQuat = new THREE.Quaternion();
  body.getWorldQuaternion(meshQuat);
  const faceForward = new THREE.Vector3(0, -1, 0).applyQuaternion(meshQuat).normalize();
  const worldUp = new THREE.Vector3(0, 0, 1).applyQuaternion(meshQuat).normalize();
  const worldRight = new THREE.Vector3().crossVectors(worldUp, faceForward).normalize();

  // Point in geometry space → posed world space (accounts for skinning).
  const posAttr = body.geometry.attributes.position;
  const geomToWorld = (p) => {
    const v = new THREE.Vector3(...p);
    let best = 0, bd = Infinity;
    const tmp = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      tmp.fromBufferAttribute(posAttr, i);
      const d = tmp.distanceToSquared(v);
      if (d < bd) { bd = d; best = i; }
    }
    const rest = new THREE.Vector3().fromBufferAttribute(posAttr, best);
    const posed = new THREE.Vector3();
    body.getVertexPosition(best, posed);
    return v.add(posed.sub(rest)).applyMatrix4(body.matrixWorld);
  };

  // Rest data for the neck chain (used to apply world-space deltas).
  const restOf = (b) => ({
    bone: b,
    q0: b.quaternion.clone(),
    parentWorld: b.parent.getWorldQuaternion(new THREE.Quaternion()),
  });
  const neckRest = neckChain.map(restOf);
  const chestRest = chest ? restOf(chest) : null;
  const spineRest = spine ? restOf(spine) : null;

  // ---------- eyes -----------------------------------------------------------
  const unit = body.getWorldScale(new THREE.Vector3()).x; // FBX geometry → world units
  const R = CFG.eyeRadius * unit;
  const eyeTex = makeEyeTexture(CFG.irisColor);
  eyeTex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const eyeMat = new THREE.MeshPhysicalMaterial({
    map: eyeTex,
    roughness: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    ior: 1.376,
    specularIntensity: 0.6,
    envMapIntensity: 1.25,
  });
  const lidMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setRGB(...CFG.skinColor.map((c) => c / 255), THREE.SRGBColorSpace),
    roughness: 0.62,
    side: THREE.DoubleSide,
  });
  const liningMat = new THREE.MeshStandardMaterial({ color: 0x93564c, roughness: 0.45, side: THREE.BackSide });
  const liningGeo = new THREE.SphereGeometry(1, 32, 16); // scaled to R below
  const lashMat = new THREE.MeshStandardMaterial({ color: 0x2a1c14, roughness: 0.8, side: THREE.DoubleSide });

  // Sphere with the iris at +Z.
  const eyeGeo = new THREE.SphereGeometry(R, 64, 48);
  eyeGeo.rotateX(Math.PI / 2);
  // Upper lid: top hemisphere; lower lid: bottom hemisphere (slightly larger radius).
  const upperLidGeo = new THREE.SphereGeometry(R * 1.07, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2);
  const lowerLidGeo = new THREE.SphereGeometry(R * 1.06, 48, 24, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
  const lashGeo = new THREE.TorusGeometry(R * 1.075, R * 0.035, 6, 64);
  lashGeo.rotateX(Math.PI / 2);

  const eyeRestQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(worldRight, worldUp, faceForward));

  const eyes = CFG.eyeSurface.map(({ name, p }) => {
    const surface = geomToWorld(p);
    const center = surface.clone().addScaledVector(faceForward, -R * CFG.eyeInset);

    const socket = new THREE.Bone(); // eye "socket" bone: fixed, carries lids
    socket.name = name + '_socket';
    socket.position.copy(center);
    socket.quaternion.copy(eyeRestQuat);
    scene.add(socket);
    socket.updateMatrixWorld(true);
    headBone.attach(socket);

    const bone = new THREE.Bone(); // the actual eye bone that rotates
    bone.name = name;
    socket.add(bone);

    const ball = new THREE.Mesh(eyeGeo, eyeMat);
    ball.receiveShadow = true;
    bone.add(ball);

    // Fleshy socket lining (inside of a larger sphere) so any gap around the
    // eyeball reads as tissue, like the caruncle / conjunctiva, never as a hole.
    const lining = new THREE.Mesh(liningGeo, liningMat);
    lining.scale.setScalar(R * 1.18);
    socket.add(lining);

    const upper = new THREE.Group();
    const upperLid = new THREE.Mesh(upperLidGeo, lidMat);
    upperLid.receiveShadow = true; upperLid.castShadow = true;
    const upperLash = new THREE.Mesh(lashGeo, lashMat);
    upper.add(upperLid, upperLash);
    const lower = new THREE.Group();
    const lowerLid = new THREE.Mesh(lowerLidGeo, lidMat);
    lowerLid.receiveShadow = true;
    lower.add(lowerLid);
    socket.add(upper, lower);

    return { name, socket, bone, upper, lower, yaw: 0, pitch: 0, tYaw: 0, tPitch: 0 };
  });

  // ---------- framing --------------------------------------------------------
  const eyeMid = new THREE.Vector3();
  eyes.forEach((e) => eyeMid.add(e.socket.getWorldPosition(new THREE.Vector3())));
  eyeMid.multiplyScalar(1 / eyes.length);
  const bbox = new THREE.Box3().setFromObject(body);
  const size = bbox.getSize(new THREE.Vector3());
  const ipd = eyes.length === 2
    ? eyes[0].socket.getWorldPosition(new THREE.Vector3()).distanceTo(eyes[1].socket.getWorldPosition(new THREE.Vector3()))
    : size.x * 0.1;

  const lookCenter = eyeMid.clone().addScaledVector(worldUp, -ipd * 1.2);
  const placeCamera = () => {
    const aspect = camera.aspect;
    // Fit roughly head + shoulders; tighter on wide panels.
    const frameH = ipd * (aspect < 0.8 ? 8.5 : 7.2);
    const dist = frameH / 2 / Math.tan((camera.fov * DEG) / 2);
    camera.position.copy(lookCenter).addScaledVector(faceForward, dist).addScaledVector(worldUp, ipd * 0.35);
    camera.up.copy(worldUp);
    camera.lookAt(lookCenter);
    camera.updateMatrixWorld();
  };

  camera.near = ipd * 0.05; camera.far = ipd * 400; camera.updateProjectionMatrix();
  key.shadow.normalBias = ipd * 0.012;
  key.shadow.bias = -0.0002;
  const s = ipd * 12;
  key.position.copy(eyeMid).addScaledVector(faceForward, s).addScaledVector(worldRight, -s * 0.55).addScaledVector(worldUp, s * 0.6);
  key.target.position.copy(eyeMid);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -ipd * 5; sc.right = sc.top = ipd * 5; sc.near = 0.01; sc.far = s * 3;
  sc.updateProjectionMatrix();
  fill.position.copy(eyeMid).addScaledVector(faceForward, s).addScaledVector(worldRight, s * 0.8);
  rim.position.copy(eyeMid).addScaledVector(faceForward, -s).addScaledVector(worldRight, s * 0.6).addScaledVector(worldUp, s * 0.5);

  // ---------- input ----------------------------------------------------------
  const pointer = { x: 0, y: 0, has: false, lastMove: -1e9 };
  const onMove = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    pointer.has = true;
    pointer.lastMove = performance.now();
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  window.addEventListener('pointerdown', onMove, { passive: true });
  document.addEventListener('pointerleave', () => { pointer.lastMove = -1e9; });

  // ---------- animation state ------------------------------------------------
  const state = {
    headYaw: 0, headPitch: 0, headYawV: 0, headPitchV: 0,
    blink: 0, blinkT: -1, nextBlink: 1.5 + Math.random() * 2, doubleBlink: false,
    micro: new THREE.Vector2(), nextMicro: 0.4,
    idleGlance: new THREE.Vector2(), nextGlance: 3,
    speaking: 0, speakingSmoothed: 0,
    lastTargetYaw: 0, lastTargetPitch: 0,
    time: 0,
  };

  const tmpV = new THREE.Vector3();
  const tmpM = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpE = new THREE.Euler();
  const target = new THREE.Vector3();

  // Target in world space: the point on the "screen plane" (through the
  // camera) where the cursor is, so the character looks at *you* / your cursor.
  function computeTarget(t) {
    const camDir = camera.getWorldDirection(new THREE.Vector3());
    const camRight = new THREE.Vector3().crossVectors(camDir, camera.up).normalize();
    const camUp = new THREE.Vector3().crossVectors(camRight, camDir).normalize();
    const dist = camera.position.distanceTo(eyeMid);
    const halfH = Math.tan((camera.fov * DEG) / 2) * dist;
    const halfW = halfH * camera.aspect;
    const idle = performance.now() - pointer.lastMove > 4500 || !pointer.has;
    let nx = pointer.x, ny = pointer.y;
    if (idle) {
      // Look at the viewer with occasional natural glances.
      if (t > state.nextGlance) {
        const r = Math.random();
        state.idleGlance.set(r < 0.55 ? 0 : (Math.random() - 0.5) * 1.6, r < 0.55 ? 0 : (Math.random() - 0.5) * 0.7);
        state.nextGlance = t + (r < 0.55 ? 2.5 : 0.9) + Math.random() * 2.5;
      }
      nx = state.idleGlance.x; ny = state.idleGlance.y + 0.12;
    }
    target.copy(camera.position)
      .addScaledVector(camRight, nx * halfW)
      .addScaledVector(camUp, ny * halfH);
    return target;
  }

  // Yaw/pitch of a world point as seen from an object's rest frame.
  function anglesInFrame(frameWorldMatrix, worldPoint) {
    tmpM.copy(frameWorldMatrix).invert();
    tmpV.copy(worldPoint).applyMatrix4(tmpM);
    return [Math.atan2(tmpV.x, tmpV.z), Math.atan2(tmpV.y, Math.hypot(tmpV.x, tmpV.z))];
  }

  // World-space delta → local quaternion for a bone in the chain.
  const deltaQ = new THREE.Quaternion();
  const axisUp = worldUp.clone(), axisRight = worldRight.clone();
  function applyDelta(rest, yaw, pitch, roll = 0) {
    deltaQ.setFromAxisAngle(axisUp, yaw)
      .multiply(tmpQ.setFromAxisAngle(axisRight, -pitch))
      .multiply(new THREE.Quaternion().setFromAxisAngle(faceForward, roll));
    const pInv = rest.parentWorld.clone().invert();
    rest.bone.quaternion.copy(pInv).multiply(deltaQ).multiply(rest.parentWorld).multiply(rest.q0);
  }

  // Critically damped spring (frame-rate independent).
  function spring(x, v, goal, omega, dt) {
    const f = 1 + 2 * dt * omega, oo = omega * omega, hoo = dt * oo, hhoo = dt * hoo;
    const det = 1 / (f + hhoo);
    const nx = (f * x + dt * v + hhoo * goal) * det;
    const nv = (v + hoo * (goal - x)) * det;
    return [nx, nv];
  }

  // Reference frame for the head angles: the character's rest head frame.
  const headFrame = new THREE.Object3D();
  headFrame.position.copy(eyeMid);
  headFrame.quaternion.copy(eyeRestQuat);
  headFrame.updateMatrixWorld(true);

  const clock = new THREE.Clock();
  function update() {
    const dt = Math.min(clock.getDelta(), 0.05);
    const t = (state.time += dt);
    computeTarget(t);

    // ----- head / neck: slow, damped follow (takes part of the rotation) -----
    const [tYaw, tPitch] = anglesInFrame(headFrame.matrixWorld, target);
    const hYawGoal = THREE.MathUtils.clamp(tYaw * 0.6, -CFG.headYawLimit, CFG.headYawLimit);
    const hPitchGoal = THREE.MathUtils.clamp(tPitch * 0.5, -CFG.headPitchLimit, CFG.headPitchLimit);
    [state.headYaw, state.headYawV] = spring(state.headYaw, state.headYawV, hYawGoal, 5.0, dt);
    [state.headPitch, state.headPitchV] = spring(state.headPitch, state.headPitchV, hPitchGoal, 5.0, dt);

    // Large gaze shifts often trigger a blink in real people.
    const shift = Math.hypot(tYaw - state.lastTargetYaw, tPitch - state.lastTargetPitch);
    if (shift > 22 * DEG && state.blinkT < 0 && Math.random() < 0.6) state.blinkT = 0;
    if (shift > 4 * DEG) { state.lastTargetYaw = tYaw; state.lastTargetPitch = tPitch; }

    // Idle life: breathing + tiny head drift + speaking nods.
    state.speakingSmoothed += (state.speaking - state.speakingSmoothed) * Math.min(1, dt * 12);
    const breath = Math.sin(t * 1.25);
    const drift = (Math.sin(t * 0.37) + Math.sin(t * 0.61 + 1.3)) * 0.5;
    const talkNod = state.speakingSmoothed * (0.035 * Math.sin(t * 7.3) + 0.02 * Math.sin(t * 3.1));
    const tilt = Math.sin(t * 0.23) * 1.2 * DEG + state.headYaw * -0.08;

    if (spineRest) applyDelta(spineRest, 0, breath * 0.25 * DEG);
    if (chestRest) applyDelta(chestRest, state.headYaw * 0.08, breath * 0.5 * DEG + state.headPitch * 0.05);
    const w = neckRest.length === 3 ? [0.3, 0.25, 0.45] : neckRest.map(() => 1 / neckRest.length);
    neckRest.forEach((r, i) => {
      applyDelta(
        r,
        state.headYaw * w[i] * (chestRest ? 0.92 : 1) + drift * 0.6 * DEG * w[i],
        state.headPitch * w[i] + (talkNod + drift * 0.3 * DEG) * w[i],
        tilt * w[i],
      );
    });
    fbx.updateMatrixWorld(true);

    // ----- eyes: saccades + pursuit + micro-saccades + vergence -----
    if (t > state.nextMicro) {
      state.micro.set((Math.random() - 0.5) * 0.9 * DEG, (Math.random() - 0.5) * 0.7 * DEG);
      state.nextMicro = t + 0.35 + Math.random() * 1.1;
    }
    for (const e of eyes) {
      let [y, p] = anglesInFrame(e.socket.matrixWorld, target);
      y = THREE.MathUtils.clamp(y + state.micro.x, -CFG.eyeYawLimit, CFG.eyeYawLimit);
      p = THREE.MathUtils.clamp(p + state.micro.y, -CFG.eyePitchDown, CFG.eyePitchUp);
      e.tYaw = y; e.tPitch = p;
      const err = Math.hypot(y - e.yaw, p - e.pitch);
      // Saccade when the error is large (very fast), smooth pursuit otherwise.
      const rate = err > 2 * DEG ? 38 : 14;
      const k = 1 - Math.exp(-rate * dt);
      e.yaw += (y - e.yaw) * k;
      e.pitch += (p - e.pitch) * k;
      e.bone.quaternion.setFromEuler(tmpE.set(-e.pitch, e.yaw, 0, 'YXZ'));
    }

    // ----- blinking & eyelids -----
    if (state.blinkT < 0 && t > state.nextBlink) {
      state.blinkT = 0;
      state.doubleBlink = Math.random() < 0.15;
    }
    if (state.blinkT >= 0) {
      state.blinkT += dt;
      const close = 0.07, hold = 0.03, open = 0.13;
      const bt = state.blinkT;
      state.blink = bt < close ? easeInOut(bt / close)
        : bt < close + hold ? 1
          : bt < close + hold + open ? 1 - easeInOut((bt - close - hold) / open) : 0;
      if (bt > close + hold + open) {
        state.blinkT = state.doubleBlink ? -0.0001 : -1;
        if (state.doubleBlink) { state.doubleBlink = false; state.blinkT = -1; state.nextBlink = t + 0.12; }
        else state.nextBlink = t + 2 + Math.random() * 4.5;
      }
    }
    if (params.has('blink')) state.blink = num('blink', 1);
    const avgPitch = eyes.reduce((a, e) => a + e.pitch, 0) / eyes.length;
    for (const e of eyes) {
      // Elevation (deg) of the lid edge in front of the eye; lids follow gaze.
      const upOpen = CFG.lidUpperOpen + (avgPitch / DEG) * 0.75;
      const loOpen = CFG.lidLowerOpen + (avgPitch / DEG) * 0.3;
      const up = THREE.MathUtils.lerp(upOpen, -6, state.blink);
      const lo = THREE.MathUtils.lerp(loOpen, -8, state.blink);
      // A top hemisphere rotated by α about X has its front edge at elevation −α.
      e.upper.rotation.set(-up * DEG, 0, 0);
      e.lower.rotation.set(-lo * DEG, 0, 0);
    }

    renderer.render(scene, camera);
  }
  CFG.lidUpperOpen = num('lu', 30);
  CFG.lidLowerOpen = num('ll', -30);

  // ---------- resize / loop ----------------------------------------------------
  const resize = () => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    placeCamera();
  };
  new ResizeObserver(resize).observe(container);
  resize();

  renderer.setAnimationLoop(update);

  if (params.has('debug')) {
    window.__farq = { scene, camera, eyes, bones, CFG, state, eyeMid, faceForward, body, fbx };
  }

  return {
    /** 0..1 – drive subtle head motion while the assistant is talking */
    setSpeaking(level) { state.speaking = Math.max(0, Math.min(1, level)); },
    blink() { if (state.blinkT < 0) state.blinkT = 0; },
  };
}

function easeInOut(x) { return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2; }

// Procedural eyeball texture (equirectangular, iris centred on the sphere's pole).
function makeEyeTexture(irisRGB) {
  const W = 1024, H = 512;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  // Deterministic noise
  let seed = 1337;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const fibers = new Float32Array(W);
  for (let i = 0; i < W; i++) fibers[i] = rnd();
  const smoothFib = (u, k) => {
    let s = 0;
    for (let j = -k; j <= k; j++) s += fibers[(u + j + W) % W];
    return s / (2 * k + 1);
  };
  const veins = [];
  for (let i = 0; i < 26; i++) veins.push({ u: rnd() * W, wob: rnd() * 6, w: 0.6 + rnd() * 1.6, start: 0.55 + rnd() * 0.2 });

  const IRIS = 0.52;   // iris angular radius (rad) ≈ 11.5 mm iris on 12 mm eye
  const PUPIL = 0.19;
  for (let y = 0; y < H; y++) {
    const theta = (y / H) * Math.PI; // 0 = front pole (iris)
    for (let x = 0; x < W; x++) {
      let r, g, b;
      if (theta < PUPIL) {
        const e = theta / PUPIL;
        r = g = b = 6 + e * 6;
      } else if (theta < IRIS) {
        const k = (theta - PUPIL) / (IRIS - PUPIL);
        const f = smoothFib(x, 1) * 0.6 + smoothFib(x, 6) * 0.4;
        const collarette = Math.exp(-Math.pow((k - 0.32) / 0.08, 2)) * 0.35;
        const inner = 1 - k; // warmer/darker near the pupil (heterochromia ring)
        let base = 0.62 + (f - 0.5) * 0.7 + collarette;
        base *= 0.72 + 0.28 * Math.sin(k * Math.PI);
        r = irisRGB[0] * base + inner * 26;
        g = irisRGB[1] * base + inner * 14;
        b = irisRGB[2] * base;
        const limbus = Math.max(0, (k - 0.78) / 0.22); // dark limbal ring
        const lf = 1 - limbus * 0.75;
        r *= lf; g *= lf; b *= lf;
      } else {
        // sclera: slightly warm, darker toward periphery, faint veins
        const k = (theta - IRIS) / (Math.PI - IRIS);
        const soft = Math.min(1, (theta - IRIS) / 0.05);
        let v = 214 - Math.min(1, k * 1.6) * 95;
        r = v * 1.0; g = v * 0.965; b = v * 0.93;
        for (const vn of veins) {
          if (k < vn.start - 0.5) continue;
          const ux = vn.u + Math.sin(theta * 9 + vn.wob) * 14;
          let du = Math.abs(x - ux); du = Math.min(du, W - du);
          const a = Math.max(0, 1 - du / vn.w) * Math.min(1, (k - (vn.start - 0.5)) * 2.4) * 0.5;
          r = r * (1 - a) + 180 * a; g = g * (1 - a) + 70 * a; b = b * (1 - a) + 70 * a;
        }
        // blend from limbus
        const lr = irisRGB[0] * 0.25, lg = irisRGB[1] * 0.25, lb = irisRGB[2] * 0.25;
        r = lr + (r - lr) * soft; g = lg + (g - lg) * soft; b = lb + (b - lb) * soft;
      }
      const i = (y * W + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
