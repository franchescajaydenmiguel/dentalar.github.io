import * as THREE from 'three';
import * as xb from 'xrblocks';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Application state
const state = {
  manifest: null,
  viewMode: 'mesh', // 'mesh', 'slice', 'combined'
  totalSlices: 230,
  currentSlice: 115,
  density: 50, // Window center (0 - 100)
  windowWidth: 70, // Window width (5 - 100)
  colorMode: 0, // 0: Grayscale, 1: Dental False-Color Heatmap
  isPlaying: false,
  sliceThicknessMm: 0.104,
  totalDepthMm: 23.92,
  widthMm: 8.84,
  heightMm: 7.80,

  // 3D Polygonal Mesh state
  peelLevel: 5, // 1 (Pulp only) to 5 (Full Tooth)
  enamelOpacity: 35, // 0 to 100%
  layerVisibility: {
    Density_1_PulpCanal: true,
    Density_2_InnerDentin: true,
    Density_3_BulkDentin: true,
    Density_4_DEJ_Boundary: true,
    Density_5_EnamelCap: true,
  },
};

const LAYER_ORDER = [
  'Density_1_PulpCanal',
  'Density_2_InnerDentin',
  'Density_3_BulkDentin',
  'Density_4_DEJ_Boundary',
  'Density_5_EnamelCap',
];

const PEEL_LABELS = {
  1: '1/5: Pulp & Canal Only',
  2: '2/5: + Inner Dentin',
  3: '3/5: + Bulk Dentin',
  4: '4/5: + DEJ Boundary',
  5: 'All 5 Layers (Full Tooth)',
};

// Texture cache and preloader
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
const gltfLoader = new GLTFLoader();

let sliceMaterial = null;
let sliceMesh = null;
let volumeBox = null;
let volumeGroup = null;
let gltfToothGroup = null;
const meshLayers = new Map();

// Spatial UI element references
let spatialModeBtn = null;
let spatialPeelSlider = null;
let spatialPeelText = null;
let spatialDepthSlider = null;
let spatialSliceText = null;
let spatialDensitySlider = null;
let spatialDensityText = null;
let spatialWidthSlider = null;
let spatialWidthText = null;
let spatialColorBtn = null;
let spatialPlayBtn = null;

// 2D DOM element references
const dom = {
  loadingOverlay: document.getElementById('loading-overlay'),
  loadingSubtitle: document.getElementById('loading-subtitle'),
  progressBar: document.getElementById('progress-bar'),
  statSlices: document.getElementById('stat-slices'),

  // Header & View Mode
  btnToggleView: document.getElementById('btn-toggle-view'),
  btnToggleViewText: document.getElementById('btn-toggle-view-text'),
  btnRecenter: document.getElementById('btn-recenter'),
  screenControls: document.getElementById('screen-controls'),
  controlsToggle: document.getElementById('controls-toggle'),
  controlsTitleText: document.getElementById('controls-title-text'),

  // Tabs
  tabMesh: document.getElementById('tab-mesh'),
  tabSlice: document.getElementById('tab-slice'),
  tabCombined: document.getElementById('tab-combined'),

  // Mesh Controls
  meshControlsGroup: document.getElementById('mesh-controls-group'),
  sliderPeel: document.getElementById('slider-peel'),
  peelVal: document.getElementById('peel-val'),
  layerChips: document.getElementById('layer-chips'),
  sliderEnamelOpacity: document.getElementById('slider-enamel-opacity'),
  enamelOpacityVal: document.getElementById('enamel-opacity-val'),
  btnIsolatePulp: document.getElementById('btn-isolate-pulp'),

  // Slice Controls
  sliceControlsGroup: document.getElementById('slice-controls-group'),
  depthSlider: document.getElementById('slider-depth'),
  depthVal: document.getElementById('depth-val'),
  densitySlider: document.getElementById('slider-density'),
  densityVal: document.getElementById('density-val'),
  widthSlider: document.getElementById('slider-width'),
  widthVal: document.getElementById('width-val'),
  btnColormap: document.getElementById('btn-colormap'),
  btnPlay: document.getElementById('btn-play'),
  btnReset: document.getElementById('btn-reset'),
};

/**
 * Fetch slice texture with caching.
 */
function getSliceTexture(index) {
  if (textureCache.has(index)) {
    return Promise.resolve(textureCache.get(index));
  }

  const manifest = state.manifest;
  const fileName =
    manifest && manifest.slices && manifest.slices[index]
      ? manifest.slices[index]
      : `slice_${String(index).padStart(4, '0')}.png`;

  const url = `data/slices/${fileName}`;

  return new Promise((resolve, reject) => {
    textureLoader.load(
      url,
      (tex) => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.NoColorSpace;
        textureCache.set(index, tex);
        resolve(tex);
      },
      undefined,
      reject
    );
  });
}

/**
 * Preload initial slices around current slice.
 */
async function preloadNearbySlices(centerIndex, radius = 5) {
  const start = Math.max(0, centerIndex - radius);
  const end = Math.min(state.totalSlices - 1, centerIndex + radius);
  const promises = [];
  for (let i = start; i <= end; i++) {
    if (!textureCache.has(i)) {
      promises.push(getSliceTexture(i));
    }
  }
  await Promise.all(promises);
}

/**
 * Progressive background loader for remaining slices.
 */
function startBackgroundPreloading() {
  let idx = 0;
  const step = () => {
    if (idx >= state.totalSlices) return;
    if (!textureCache.has(idx)) {
      getSliceTexture(idx).then(() => {
        const pct = Math.round((textureCache.size / state.totalSlices) * 100);
        if (dom.progressBar && pct < 100) {
          dom.progressBar.style.width = `${pct}%`;
        }
      });
    }
    idx++;
    setTimeout(step, 25);
  };
  setTimeout(step, 200);
}

/**
 * Load 5-mesh polygonal GLB into the Three.js scene.
 */
function loadToothGLB() {
  return new Promise((resolve, reject) => {
    const glbUrl =
      state.manifest && state.manifest.glb_path
        ? state.manifest.glb_path
        : 'data/tooth_5_densities.glb';

    gltfLoader.load(
      glbUrl,
      (gltf) => {
        gltfToothGroup = gltf.scene;

        // Physical coordinates in GLB are in millimeters (height: 23.85mm).
        // Scaling by 0.01 converts 23.85 mm to 0.2385 m (23.85 cm), perfectly fitting the 0.24m AR bounding cage.
        gltfToothGroup.scale.setScalar(0.01);
        gltfToothGroup.position.set(0, 0, 0);

        gltfToothGroup.traverse((child) => {
          if (child.isMesh) {
            meshLayers.set(child.name, child);
            child.castShadow = true;
            child.receiveShadow = true;
            child.material.side = THREE.DoubleSide;

            // Render order & alpha sorting: inner layers render first, translucent outer layers render last
            if (child.name === 'Density_1_PulpCanal') {
              child.renderOrder = 1;
              child.material.depthWrite = true;
            } else if (child.name === 'Density_2_InnerDentin') {
              child.renderOrder = 2;
              child.material.transparent = true;
              child.material.depthWrite = false;
            } else if (child.name === 'Density_3_BulkDentin') {
              child.renderOrder = 3;
              child.material.transparent = true;
              child.material.depthWrite = false;
            } else if (child.name === 'Density_4_DEJ_Boundary') {
              child.renderOrder = 4;
              child.material.transparent = true;
              child.material.depthWrite = false;
            } else if (child.name === 'Density_5_EnamelCap') {
              child.renderOrder = 5;
              child.material.transparent = true;
              child.material.opacity = state.enamelOpacity / 100;
              child.material.depthWrite = false;
            }
          }
        });

        if (volumeGroup) {
          volumeGroup.add(gltfToothGroup);
        }

        console.log(`Loaded GLB with ${meshLayers.size} density meshes:`, Array.from(meshLayers.keys()));
        resolve(gltfToothGroup);
      },
      undefined,
      (err) => {
        console.error('Failed to load GLB:', err);
        reject(err);
      }
    );
  });
}

/**
 * Update active view mode ('mesh', 'slice', or 'combined').
 */
function setViewMode(mode) {
  state.viewMode = mode;
  const isMesh = mode === 'mesh' || mode === 'combined';
  const isSlice = mode === 'slice' || mode === 'combined';

  if (gltfToothGroup) {
    gltfToothGroup.visible = isMesh;
  }
  if (sliceMesh) {
    sliceMesh.visible = isSlice;
  }

  // Update tabs
  [dom.tabMesh, dom.tabSlice, dom.tabCombined].forEach((tab) => {
    if (tab) {
      tab.classList.toggle('active', tab.dataset.mode === mode);
    }
  });

  // Update header button label
  if (dom.btnToggleViewText) {
    if (mode === 'mesh') dom.btnToggleViewText.textContent = '🦷 3D Meshes';
    else if (mode === 'slice') dom.btnToggleViewText.textContent = '🔬 2D Slices';
    else dom.btnToggleViewText.textContent = '✨ Combined';
  }

  // Update panel display
  if (dom.meshControlsGroup) {
    dom.meshControlsGroup.style.display = isMesh ? 'flex' : 'none';
  }
  if (dom.sliceControlsGroup) {
    dom.sliceControlsGroup.style.display = isSlice ? 'flex' : 'none';
  }

  if (dom.controlsTitleText) {
    if (mode === 'mesh') dom.controlsTitleText.textContent = '🦷 3D Meshes & Depth Densities';
    else if (mode === 'slice') dom.controlsTitleText.textContent = '🔬 Micro-CT Slice Scrubber';
    else dom.controlsTitleText.textContent = '✨ 3D Meshes & CT Slice Combined';
  }

  // Synchronize 3D Spatial UI
  if (spatialModeBtn) {
    const labels = { mesh: 'Mode: 3D Mesh', slice: 'Mode: 2D Slices', combined: 'Mode: Combined' };
    spatialModeBtn.label = labels[mode] || 'Mode';
  }
}

/**
 * Cycle view mode: mesh -> slice -> combined -> mesh.
 */
function cycleViewMode() {
  const nextMode =
    state.viewMode === 'mesh' ? 'slice' : state.viewMode === 'slice' ? 'combined' : 'mesh';
  setViewMode(nextMode);
}

/**
 * Set layer peel level (1 to 5).
 */
function setPeelLevel(level, updateDom = true, updateSpatial = true) {
  state.peelLevel = Math.max(1, Math.min(5, Number(level)));
  const label = PEEL_LABELS[state.peelLevel] || `Level ${state.peelLevel}`;

  LAYER_ORDER.forEach((layerId, idx) => {
    const isVisible = idx < state.peelLevel;
    state.layerVisibility[layerId] = isVisible;
    const mesh = meshLayers.get(layerId);
    if (mesh) mesh.visible = isVisible;

    // Synchronize DOM chips
    const chip = document.querySelector(`.layer-chip[data-layer="${layerId}"]`);
    if (chip) {
      chip.classList.toggle('active', isVisible);
      chip.classList.toggle('inactive', !isVisible);
    }
  });

  if (updateDom) {
    if (dom.sliderPeel) dom.sliderPeel.value = state.peelLevel;
    if (dom.peelVal) dom.peelVal.textContent = label;
  }

  if (updateSpatial && spatialPeelSlider) {
    spatialPeelSlider.value = state.peelLevel;
    if (spatialPeelText) spatialPeelText.text = label;
  }
}

/**
 * Toggle individual density layer on/off.
 */
function toggleIndividualLayer(layerId) {
  const current = state.layerVisibility[layerId] !== false;
  const next = !current;
  state.layerVisibility[layerId] = next;

  const mesh = meshLayers.get(layerId);
  if (mesh) mesh.visible = next;

  const chip = document.querySelector(`.layer-chip[data-layer="${layerId}"]`);
  if (chip) {
    chip.classList.toggle('active', next);
    chip.classList.toggle('inactive', !next);
  }
}

/**
 * Set enamel translucency.
 */
function setEnamelOpacity(value, updateDom = true) {
  state.enamelOpacity = Number(value);
  const enamelMesh = meshLayers.get('Density_5_EnamelCap');
  if (enamelMesh) {
    const alpha = state.enamelOpacity / 100;
    enamelMesh.material.opacity = alpha;
    enamelMesh.material.transparent = alpha < 1.0;
    enamelMesh.material.depthWrite = alpha >= 0.99;
  }

  if (updateDom) {
    if (dom.sliderEnamelOpacity) dom.sliderEnamelOpacity.value = state.enamelOpacity;
    if (dom.enamelOpacityVal) dom.enamelOpacityVal.textContent = `${state.enamelOpacity}%`;
  }
}

/**
 * Isolate internal pulp chamber & root canal.
 */
function isolatePulp() {
  setPeelLevel(1);
}

/**
 * Update depth slice.
 */
async function setSlice(index, updateSpatial = true, updateDom = true) {
  index = Math.max(0, Math.min(state.totalSlices - 1, Math.round(index)));
  state.currentSlice = index;

  const currentMm = (index * state.sliceThicknessMm).toFixed(2);
  const textLabel = `${index + 1} / ${state.totalSlices} (${currentMm} mm)`;

  // Update DOM
  if (updateDom && dom.depthSlider) {
    dom.depthSlider.value = index;
    dom.depthVal.textContent = textLabel;
  }

  // Update Spatial UI
  if (updateSpatial && spatialDepthSlider) {
    spatialDepthSlider.value = index;
    if (spatialSliceText) {
      spatialSliceText.text = textLabel;
    }
  }

  // Update 3D slice quad position along Y (height in bounding cage)
  if (sliceMesh && volumeBox) {
    const boxHeight = 0.24; // Physical box height in meters
    const normalizedY = index / (state.totalSlices - 1) - 0.5; // -0.5 to +0.5
    sliceMesh.position.y = normalizedY * boxHeight;
  }

  // Update Texture on Shader Material
  try {
    const tex = await getSliceTexture(index);
    if (sliceMaterial && sliceMaterial.uniforms.uTexture) {
      sliceMaterial.uniforms.uTexture.value = tex;
      sliceMaterial.uniformsNeedUpdate = true;
    }
  } catch (err) {
    console.error(`Error loading slice texture ${index}:`, err);
  }

  // Preload surrounding slices
  preloadNearbySlices(index, 6);
}

/**
 * Update density / window level.
 */
function setDensity(value, updateSpatial = true, updateDom = true) {
  state.density = Number(value);
  const normalized = state.density / 100;

  if (sliceMaterial) {
    sliceMaterial.uniforms.uWindowCenter.value = normalized;
    sliceMaterial.uniforms.uThreshold.value = Math.max(0.01, normalized * 0.35);
  }

  if (updateDom && dom.densitySlider) {
    dom.densitySlider.value = state.density;
    dom.densityVal.textContent = `${state.density}%`;
  }

  if (updateSpatial && spatialDensitySlider) {
    spatialDensitySlider.value = state.density;
    if (spatialDensityText) {
      spatialDensityText.text = `${state.density}%`;
    }
  }
}

/**
 * Update window width (contrast).
 */
function setWindowWidth(value, updateSpatial = true, updateDom = true) {
  state.windowWidth = Number(value);
  const normalized = state.windowWidth / 100;

  if (sliceMaterial) {
    sliceMaterial.uniforms.uWindowWidth.value = normalized;
  }

  if (updateDom && dom.widthSlider) {
    dom.widthSlider.value = state.windowWidth;
    dom.widthVal.textContent = `${state.windowWidth}%`;
  }

  if (updateSpatial && spatialWidthSlider) {
    spatialWidthSlider.value = state.windowWidth;
    if (spatialWidthText) {
      spatialWidthText.text = `${state.windowWidth}%`;
    }
  }
}

/**
 * Toggle color mode between Grayscale and Dental False-Color Heatmap.
 */
function toggleColorMode() {
  state.colorMode = state.colorMode === 0 ? 1 : 0;
  if (sliceMaterial) {
    sliceMaterial.uniforms.uColorMode.value = state.colorMode;
  }
  dom.btnColormap.textContent =
    state.colorMode === 1 ? '🎨 Colormap: Heatmap' : '⚪ Colormap: Grayscale';
  dom.btnColormap.classList.toggle('active', state.colorMode === 1);

  if (spatialColorBtn) {
    spatialColorBtn.label = state.colorMode === 1 ? 'Heatmap' : 'Grayscale';
  }
}

/**
 * Toggle auto-play animation.
 */
function togglePlay() {
  state.isPlaying = !state.isPlaying;
  dom.btnPlay.textContent = state.isPlaying ? '⏸ Pause' : '▶ Auto-Play';
  dom.btnPlay.classList.toggle('active', state.isPlaying);

  if (spatialPlayBtn) {
    spatialPlayBtn.label = state.isPlaying ? 'Pause' : 'Auto-Play';
  }
}

/**
 * Reset all settings to defaults.
 */
function resetSettings() {
  setViewMode('mesh');
  setPeelLevel(5);
  setEnamelOpacity(35);
  setSlice(Math.floor(state.totalSlices / 2));
  setDensity(50);
  setWindowWidth(70);
  if (state.colorMode !== 0) toggleColorMode();
  if (state.isPlaying) togglePlay();
}

/**
 * XR Blocks Scene Script
 */
class DentalViewerScene extends xb.Script {
  init() {
    this.setupLighting();
    this.setupVolumeVisualization();
    this.setupSpatialUI();
  }

  setupLighting() {
    // Ambient & hemisphere light
    this.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2.8));

    // Key directional light
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.0);
    dirLight1.position.set(2, 4, 3);
    this.add(dirLight1);

    // Fill directional light for rich 3D mesh curvature
    const dirLight2 = new THREE.DirectionalLight(0x90cdf4, 1.2);
    dirLight2.position.set(-3, -1, -2);
    this.add(dirLight2);
  }

  setupVolumeVisualization() {
    volumeGroup = new THREE.Group();
    // Default position: floating conveniently in front of user in AR space
    volumeGroup.position.set(-0.15, 1.35, -0.9);

    const boxWidth = 0.22; // ~22 cm
    const boxHeight = 0.24; // ~24 cm
    const boxDepth = 0.20; // ~20 cm

    // 1. Volumetric wireframe bounding cage
    const boxGeo = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);
    const edges = new THREE.EdgesGeometry(boxGeo);
    volumeBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.35,
        linewidth: 1.5,
      })
    );
    volumeGroup.add(volumeBox);

    // 2. Base pedestal stand
    const standGeo = new THREE.CylinderGeometry(0.18, 0.2, 0.015, 32);
    const standMat = new THREE.MeshStandardMaterial({
      color: 0x1e293b,
      metalness: 0.3,
      roughness: 0.6,
      transparent: true,
      opacity: 0.85,
    });
    const stand = new THREE.Mesh(standGeo, standMat);
    stand.position.y = -boxHeight * 0.5 - 0.01;
    volumeGroup.add(stand);

    // Subtle grid on the base
    const grid = new THREE.GridHelper(0.3, 10, 0x38bdf8, 0x1e3a5f);
    grid.position.y = -boxHeight * 0.5 - 0.002;
    volumeGroup.add(grid);

    // 3. Custom Shader Material for slice scrubbing
    sliceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: null },
        uWindowCenter: { value: state.density / 100 },
        uWindowWidth: { value: state.windowWidth / 100 },
        uThreshold: { value: 0.02 },
        uColorMode: { value: state.colorMode },
        uOpacity: { value: 0.95 },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uTexture;
        uniform float uWindowCenter;
        uniform float uWindowWidth;
        uniform float uThreshold;
        uniform int uColorMode;
        uniform float uOpacity;
        varying vec2 vUv;

        void main() {
          vec4 tex = texture2D(uTexture, vUv);
          float val = tex.r;

          if (val < uThreshold) {
            discard;
          }

          float halfW = max(0.005, uWindowWidth * 0.5);
          float low = uWindowCenter - halfW;
          float high = uWindowCenter + halfW;
          float intensity = clamp((val - low) / (high - low), 0.0, 1.0);

          vec3 color = vec3(intensity);
          if (uColorMode == 1) {
            vec3 c0 = vec3(0.06, 0.10, 0.22);
            vec3 c1 = vec3(0.12, 0.55, 0.85);
            vec3 c2 = vec3(0.96, 0.65, 0.20);
            vec3 c3 = vec3(1.0, 1.0, 0.96);

            if (intensity < 0.28) {
              color = mix(c0, c1, intensity / 0.28);
            } else if (intensity < 0.70) {
              color = mix(c1, c2, (intensity - 0.28) / 0.42);
            } else {
              color = mix(c2, c3, (intensity - 0.70) / 0.30);
            }
          }

          gl_FragColor = vec4(color, uOpacity);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    // 4. Slice plane mesh
    const planeGeo = new THREE.PlaneGeometry(boxWidth, boxDepth);
    sliceMesh = new THREE.Mesh(planeGeo, sliceMaterial);
    sliceMesh.rotation.x = -Math.PI / 2;
    sliceMesh.position.y = 0;
    sliceMesh.visible = false; // Initial mode is 'mesh'
    volumeGroup.add(sliceMesh);

    const haloGeo = new THREE.EdgesGeometry(planeGeo);
    const halo = new THREE.LineSegments(
      haloGeo,
      new THREE.LineBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0.8 })
    );
    sliceMesh.add(halo);

    this.add(volumeGroup);
  }

  setupSpatialUI() {
    const currentMm = (state.currentSlice * state.sliceThicknessMm).toFixed(2);

    // Mode Toggle Button in Spatial UI
    spatialModeBtn = new xb.UIButton({
      label: 'Mode: 3D Mesh',
      style: { flexGrow: 1 },
      onClick: () => cycleViewMode(),
    });

    // Layer Peel Slider
    spatialPeelText = new xb.UIText({
      text: PEEL_LABELS[5],
      style: { fontSize: 14, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialPeelSlider = new xb.UISlider({
      ariaLabel: 'Layer Peel Slider',
      min: 1,
      max: 5,
      step: 1,
      value: 5,
      style: { width: '100%', height: 36 },
      onInput: (val) => setPeelLevel(val, true, false),
    });

    // Depth Slice Text & Slider
    spatialSliceText = new xb.UIText({
      text: `${state.currentSlice + 1} / ${state.totalSlices} (${currentMm} mm)`,
      style: { fontSize: 14, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialDepthSlider = new xb.UISlider({
      ariaLabel: 'Depth Slice Slider',
      min: 0,
      max: state.totalSlices - 1,
      step: 1,
      value: state.currentSlice,
      style: { width: '100%', height: 36 },
      onInput: (val) => setSlice(val, false, true),
    });

    // Density Text & Slider
    spatialDensityText = new xb.UIText({
      text: `${state.density}%`,
      style: { fontSize: 14, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialDensitySlider = new xb.UISlider({
      ariaLabel: 'Density Level Slider',
      min: 0,
      max: 100,
      step: 1,
      value: state.density,
      style: { width: '100%', height: 36 },
      onInput: (val) => setDensity(val, false, true),
    });

    spatialWidthText = new xb.UIText({
      text: `${state.windowWidth}%`,
      style: { fontSize: 14, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialWidthSlider = new xb.UISlider({
      ariaLabel: 'Window Width Slider',
      min: 5,
      max: 100,
      step: 1,
      value: state.windowWidth,
      style: { width: '100%', height: 36 },
      onInput: (val) => setWindowWidth(val, false, true),
    });

    spatialColorBtn = new xb.UIButton({
      label: 'Colormap',
      style: { flexGrow: 1 },
      onClick: () => toggleColorMode(),
    });

    spatialPlayBtn = new xb.UIButton({
      label: 'Auto-Play',
      style: { flexGrow: 1 },
      onClick: () => togglePlay(),
    });

    const resetBtn = new xb.UIButton({
      label: 'Reset',
      style: { flexGrow: 1 },
      onClick: () => resetSettings(),
    });

    // XR Blocks Retained Spatial UICard
    const card = new xb.UICard({
      size: { width: 0.54, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 12,
        padding: 18,
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        borderRadius: 16,
      },
      children: [
        new xb.UIText({
          text: 'Micro-CT Sample S2428',
          style: { fontSize: 20, fontWeight: 'bold', textAlign: 'center', color: '#ffffff' },
        }),
        new xb.UIText({
          text: '5 Density Polygonal Meshes • 13µm Resolution • WebXR',
          style: { fontSize: 12, opacity: 0.75, textAlign: 'center', color: '#94a3b8' },
        }),

        // Mode switch button
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8 },
          children: [spatialModeBtn, resetBtn],
        }),

        // 3D Density Peel Section
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          },
          children: [
            new xb.UIText({
              text: 'Peel Layers (Pulp -> Enamel)',
              style: { fontSize: 13, color: '#e2e8f0' },
            }),
            spatialPeelText,
          ],
        }),
        spatialPeelSlider,

        // Depth Slice Row
        new xb.UIPanel({
          style: {
            width: '100%',
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
          },
          children: [
            new xb.UIText({ text: 'CT Depth Slice', style: { fontSize: 13, color: '#e2e8f0' } }),
            spatialSliceText,
          ],
        }),
        spatialDepthSlider,

        // Action Buttons Row
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8, marginTop: 4 },
          children: [spatialColorBtn, spatialPlayBtn],
        }),
      ],
    });

    card.position.set(0.44, 1.35, -0.85);
    card.rotation.y = -0.32;
    this.add(card);
  }

  update() {
    if (state.isPlaying && (state.viewMode === 'slice' || state.viewMode === 'combined')) {
      let nextSlice = state.currentSlice + 1;
      if (nextSlice >= state.totalSlices) {
        nextSlice = 0;
      }
      setSlice(nextSlice, true, true);
    }

    // Gentle idle rotation of tooth model when not in active VR session
    if (volumeGroup && !xb.core?.session) {
      volumeGroup.rotation.y += 0.002;
    }
  }
}

/**
 * Connect 2D HUD Events.
 */
function initDomEvents() {
  // Header view toggle button
  if (dom.btnToggleView) {
    dom.btnToggleView.addEventListener('click', cycleViewMode);
  }

  // View Mode Tabs
  if (dom.tabMesh) dom.tabMesh.addEventListener('click', () => setViewMode('mesh'));
  if (dom.tabSlice) dom.tabSlice.addEventListener('click', () => setViewMode('slice'));
  if (dom.tabCombined) dom.tabCombined.addEventListener('click', () => setViewMode('combined'));

  // Mesh Peel Slider
  if (dom.sliderPeel) {
    dom.sliderPeel.addEventListener('input', (e) => setPeelLevel(e.target.value, true, true));
  }

  // 5 Density Layer Toggle Chips
  if (dom.layerChips) {
    dom.layerChips.querySelectorAll('.layer-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const layerId = chip.dataset.layer;
        if (layerId) toggleIndividualLayer(layerId);
      });
    });
  }

  // Enamel Opacity Slider
  if (dom.sliderEnamelOpacity) {
    dom.sliderEnamelOpacity.addEventListener('input', (e) => setEnamelOpacity(e.target.value, true));
  }

  // Isolate Pulp Button
  if (dom.btnIsolatePulp) {
    dom.btnIsolatePulp.addEventListener('click', isolatePulp);
  }

  // Depth slider
  if (dom.depthSlider) {
    dom.depthSlider.addEventListener('input', (e) => setSlice(Number(e.target.value), true, false));
  }

  // Density slider
  if (dom.densitySlider) {
    dom.densitySlider.addEventListener('input', (e) => setDensity(Number(e.target.value), true, false));
  }

  // Width slider
  if (dom.widthSlider) {
    dom.widthSlider.addEventListener('input', (e) => setWindowWidth(Number(e.target.value), true, false));
  }

  // Action buttons
  if (dom.btnColormap) dom.btnColormap.addEventListener('click', toggleColorMode);
  if (dom.btnPlay) dom.btnPlay.addEventListener('click', togglePlay);
  if (dom.btnReset) dom.btnReset.addEventListener('click', resetSettings);

  // Recenter button
  if (dom.btnRecenter) {
    dom.btnRecenter.addEventListener('click', () => {
      if (volumeGroup) {
        volumeGroup.position.set(-0.15, 1.35, -0.9);
        volumeGroup.rotation.set(0, 0, 0);
      }
    });
  }

  // Toggle collapsible controls
  if (dom.controlsToggle) {
    dom.controlsToggle.addEventListener('click', () => {
      dom.screenControls.classList.toggle('collapsed');
    });
  }
}

/**
 * Main application bootstrap.
 */
async function main() {
  initDomEvents();

  // Load manifest.json
  try {
    const res = await fetch('data/manifest.json');
    if (res.ok) {
      const data = await res.json();
      state.manifest = data;
      state.totalSlices = data.total_slices || 230;
      state.sliceThicknessMm = data.slice_thickness_mm || 0.104;
      state.totalDepthMm = data.total_depth_mm || 23.92;
      state.currentSlice = Math.floor(state.totalSlices / 2);

      if (dom.statSlices) {
        dom.statSlices.textContent = `${state.totalSlices} Slices • 5 Meshes`;
      }
      if (dom.depthSlider) {
        dom.depthSlider.max = state.totalSlices - 1;
        dom.depthSlider.value = state.currentSlice;
      }
    }
  } catch (err) {
    console.warn('Could not load manifest.json, using defaults:', err);
  }

  // Add XR Blocks Scene
  const sceneScript = new DentalViewerScene();
  xb.add(sceneScript);

  // Initialize XR Blocks
  const options = new xb.Options();
  options.setAppTitle('Dental Micro-CT XR Explorer');
  options.world.enablePlaneDetection();

  options.simulator.instructions.customInstructions = [
    {
      header: 'Dental 5-Mesh Density Explorer',
      description:
        'Inspect the 5 distinct anatomical density layers. Use the Peel slider or click individual layers to reveal internal root canal anatomy.',
    },
  ];

  await xb.init(options);

  // Load 3D GLB Model and initial slice
  dom.loadingSubtitle.textContent = 'Loading 5-mesh polygonal GLB model...';
  try {
    await loadToothGLB();
  } catch (err) {
    console.warn('GLB load notice:', err);
  }

  try {
    await preloadNearbySlices(state.currentSlice, 3);
    await setSlice(state.currentSlice);
  } catch (err) {
    console.warn('Preload notice:', err);
  }

  // Initial display: 3D Meshes mode with all 5 layers active
  setViewMode('mesh');
  setPeelLevel(5);

  // Hide loading screen
  if (dom.loadingOverlay) {
    dom.loadingOverlay.classList.add('hidden');
  }

  // Background progressive preloading for slice scrubber
  startBackgroundPreloading();
}

// Start application
window.addEventListener('DOMContentLoaded', main);
