import * as THREE from 'three';
import * as xb from 'xrblocks';

// Application state
const state = {
  manifest: null,
  totalSlices: 230,
  currentSlice: 115,
  density: 50,         // Window center (0 - 100)
  windowWidth: 70,     // Window width (5 - 100)
  colorMode: 0,        // 0: Grayscale, 1: Dental False-Color Heatmap
  isPlaying: false,
  sliceThicknessMm: 0.104,
  totalDepthMm: 23.92,
  widthMm: 8.84,
  heightMm: 7.80,
};

// Texture cache and preloader
const textureLoader = new THREE.TextureLoader();
const textureCache = new Map();
let sliceMaterial = null;
let sliceMesh = null;
let volumeBox = null;
let volumeGroup = null;

// UI elements references (Spatial and 2D)
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
  depthSlider: document.getElementById('slider-depth'),
  depthVal: document.getElementById('depth-val'),
  densitySlider: document.getElementById('slider-density'),
  densityVal: document.getElementById('density-val'),
  widthSlider: document.getElementById('slider-width'),
  widthVal: document.getElementById('width-val'),
  btnColormap: document.getElementById('btn-colormap'),
  btnPlay: document.getElementById('btn-play'),
  btnReset: document.getElementById('btn-reset'),
  btnRecenter: document.getElementById('btn-recenter'),
  screenControls: document.getElementById('screen-controls'),
  controlsToggle: document.getElementById('controls-toggle'),
};

/**
 * Fetch slice texture with caching.
 */
function getSliceTexture(index) {
  if (textureCache.has(index)) {
    return Promise.resolve(textureCache.get(index));
  }

  const manifest = state.manifest;
  const fileName = manifest && manifest.slices && manifest.slices[index]
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
    setTimeout(step, 20); // Small interval to keep UI responsive
  };
  setTimeout(step, 200);
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
    const normalizedY = (index / (state.totalSlices - 1)) - 0.5; // -0.5 to +0.5
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

  // Preload surrounding slices for 0ms lag scrubbing
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
    // Dynamic air thresholding: automatically masks out air/noise
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
  const label = state.colorMode === 1 ? 'False-Color: ON' : 'False-Color: OFF';
  dom.btnColormap.textContent = state.colorMode === 1 ? '🎨 Colormap: Heatmap' : '⚪ Colormap: Grayscale';
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
    this.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2.5));
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
    dirLight.position.set(2, 4, 3);
    this.add(dirLight);
  }

  setupVolumeVisualization() {
    volumeGroup = new THREE.Group();
    // Default position: floating conveniently in front of user in AR space
    volumeGroup.position.set(-0.15, 1.35, -0.9);

    const boxWidth = 0.22;   // ~22 cm (scaled up for ergonomic AR inspection)
    const boxHeight = 0.24;  // ~24 cm
    const boxDepth = 0.20;   // ~20 cm

    // 1. Outer volumetric bounding wireframe box
    const boxGeo = new THREE.BoxGeometry(boxWidth, boxHeight, boxDepth);
    const edges = new THREE.EdgesGeometry(boxGeo);
    volumeBox = new THREE.LineSegments(
      edges,
      new THREE.LineBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.45,
        linewidth: 1.5,
      })
    );
    volumeGroup.add(volumeBox);

    // 2. Base examination stand / pedestal
    const standGeo = new THREE.CylinderGeometry(0.18, 0.20, 0.015, 32);
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

    // 3. Custom Shader Material for the slice
    sliceMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTexture: { value: null },
        uWindowCenter: { value: state.density / 100 },
        uWindowWidth: { value: state.windowWidth / 100 },
        uThreshold: { value: 0.02 },
        uColorMode: { value: state.colorMode },
        uOpacity: { value: 1.0 },
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

          // Discard air / background noise
          if (val < uThreshold) {
            discard;
          }

          // Window / Level mapping
          float halfW = max(0.005, uWindowWidth * 0.5);
          float low = uWindowCenter - halfW;
          float high = uWindowCenter + halfW;
          float intensity = clamp((val - low) / (high - low), 0.0, 1.0);

          vec3 color = vec3(intensity);
          if (uColorMode == 1) {
            // Dental colormap: soft tissue (blue) -> dentin (amber) -> enamel (white)
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

    // 4. Active slice plane (placed horizontally in X-Z plane, moving along Y depth)
    const planeGeo = new THREE.PlaneGeometry(boxWidth, boxDepth);
    sliceMesh = new THREE.Mesh(planeGeo, sliceMaterial);
    sliceMesh.rotation.x = -Math.PI / 2; // Flat horizontal plane
    sliceMesh.position.y = 0;
    volumeGroup.add(sliceMesh);

    // Subtle slice boundary halo
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

    spatialSliceText = new xb.UIText({
      text: `${state.currentSlice + 1} / ${state.totalSlices} (${currentMm} mm)`,
      style: { fontSize: 15, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialDepthSlider = new xb.UISlider({
      ariaLabel: 'Depth Slice Slider',
      min: 0,
      max: state.totalSlices - 1,
      step: 1,
      value: state.currentSlice,
      style: { width: '100%', height: 36 },
      onInput: (val) => {
        setSlice(val, false, true);
      },
    });

    spatialDensityText = new xb.UIText({
      text: `${state.density}%`,
      style: { fontSize: 15, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialDensitySlider = new xb.UISlider({
      ariaLabel: 'Density Level Slider',
      min: 0,
      max: 100,
      step: 1,
      value: state.density,
      style: { width: '100%', height: 36 },
      onInput: (val) => {
        setDensity(val, false, true);
      },
    });

    spatialWidthText = new xb.UIText({
      text: `${state.windowWidth}%`,
      style: { fontSize: 15, color: '#38bdf8', fontWeight: 'bold' },
    });

    spatialWidthSlider = new xb.UISlider({
      ariaLabel: 'Window Width Slider',
      min: 5,
      max: 100,
      step: 1,
      value: state.windowWidth,
      style: { width: '100%', height: 36 },
      onInput: (val) => {
        setWindowWidth(val, false, true);
      },
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
      size: { width: 0.52, height: 'auto' },
      manipulation: true,
      edge: true,
      style: {
        flexDirection: 'column',
        gap: 12,
        padding: 18,
        backgroundColor: 'rgba(15, 23, 42, 0.92)',
        borderRadius: 16,
      },
      children: [
        new xb.UIText({
          text: 'Micro-CT Sample S2428',
          style: { fontSize: 22, fontWeight: 'bold', textAlign: 'center', color: '#ffffff' },
        }),
        new xb.UIText({
          text: `13µm Resolution • ${state.totalSlices} Slices • Depth: ${state.totalDepthMm.toFixed(1)}mm`,
          style: { fontSize: 13, opacity: 0.75, textAlign: 'center', color: '#94a3b8' },
        }),

        // Depth Slider Row
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
          children: [
            new xb.UIText({ text: 'Depth Slice', style: { fontSize: 14, color: '#e2e8f0' } }),
            spatialSliceText,
          ],
        }),
        spatialDepthSlider,

        // Density Slider Row
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
          children: [
            new xb.UIText({ text: 'Density / Level', style: { fontSize: 14, color: '#e2e8f0' } }),
            spatialDensityText,
          ],
        }),
        spatialDensitySlider,

        // Contrast Slider Row
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
          children: [
            new xb.UIText({ text: 'Window Width', style: { fontSize: 14, color: '#e2e8f0' } }),
            spatialWidthText,
          ],
        }),
        spatialWidthSlider,

        // Action Buttons Row
        new xb.UIPanel({
          style: { width: '100%', flexDirection: 'row', gap: 8, marginTop: 4 },
          children: [spatialColorBtn, spatialPlayBtn, resetBtn],
        }),
      ],
    });

    // Angled comfortably to the right of the tooth volume
    card.position.set(0.42, 1.35, -0.85);
    card.rotation.y = -0.32;
    this.add(card);
  }

  update() {
    // Auto-play animation
    if (state.isPlaying) {
      let nextSlice = state.currentSlice + 1;
      if (nextSlice >= state.totalSlices) {
        nextSlice = 0;
      }
      setSlice(nextSlice, true, true);
    }

    // Subtle idle rotation of the stand if not in XR session
    if (volumeGroup && !xb.core?.session) {
      // gentle rotation
      volumeGroup.rotation.y += 0.002;
    }
  }
}

/**
 * Connect 2D HUD Events.
 */
function initDomEvents() {
  // Depth slider
  dom.depthSlider.addEventListener('input', (e) => {
    setSlice(Number(e.target.value), true, false);
  });

  // Density slider
  dom.densitySlider.addEventListener('input', (e) => {
    setDensity(Number(e.target.value), true, false);
  });

  // Width slider
  dom.widthSlider.addEventListener('input', (e) => {
    setWindowWidth(Number(e.target.value), true, false);
  });

  // Action buttons
  dom.btnColormap.addEventListener('click', toggleColorMode);
  dom.btnPlay.addEventListener('click', togglePlay);
  dom.btnReset.addEventListener('click', resetSettings);

  // Recenter button
  dom.btnRecenter.addEventListener('click', () => {
    if (volumeGroup) {
      volumeGroup.position.set(-0.15, 1.35, -0.9);
      volumeGroup.rotation.set(0, 0, 0);
    }
  });

  // Toggle collapsible controls
  dom.controlsToggle.addEventListener('click', () => {
    dom.screenControls.classList.toggle('collapsed');
  });
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
        dom.statSlices.textContent = `${state.totalSlices} Slices`;
      }
      if (dom.depthSlider) {
        dom.depthSlider.max = state.totalSlices - 1;
        dom.depthSlider.value = state.currentSlice;
      }
    }
  } catch (err) {
    console.warn('Could not load manifest.json, using defaults:', err);
  }

  // Preload initial slice
  dom.loadingSubtitle.textContent = 'Loading initial dental slice...';
  try {
    await preloadNearbySlices(state.currentSlice, 3);
  } catch (err) {
    console.warn('Preload notice:', err);
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
      header: 'Dental Micro-CT Explorer',
      description: 'Use the 3D sliders to inspect depth and density slices. In AR, walk around the tooth and pinch controls.',
    },
  ];

  await xb.init(options);

  // Set initial slice
  await setSlice(state.currentSlice);

  // Hide loading screen
  dom.loadingOverlay.classList.add('hidden');

  // Start background progressive preloading
  startBackgroundPreloading();
}

// Start application
window.addEventListener('DOMContentLoaded', main);
