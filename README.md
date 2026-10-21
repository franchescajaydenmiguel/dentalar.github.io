# Dental Micro-CT XR Explorer (`dentalar.github.io`)

Dental X BME MicroCT Project — Augmented Reality Gallery of Teeth Samples built with **Google XR Blocks**, **Three.js**, and **WebXR**.

Live Site: [https://dentalar.github.io/](https://dentalar.github.io/)

---

## 🔬 Dataset Overview (Sample S2428)

* **Original Format**: 1,834 DICOM slices (`.DCM;1`)
* **Raw Dataset Size**: ~1.50 GB (818 KB / slice)
* **Image Matrix**: 680 × 600 pixels, 16-bit signed integer (`int16`)
* **Spatial Resolution**: 0.013 mm × 0.013 mm (isotropic 13 µm)
* **Slice Thickness**: 0.013 mm (total physical height: ~23.92 mm)
* **Intensity Range**: -7,476 to +32,767 HU equivalent (dense enamel and dentin)

---

## ⚡ Data Compression & Shrinking Pipeline

Because 1.5 GB exceeds GitHub Pages recommended limits and would crash mobile WebXR WebGL memory, we built an automated preprocessing pipeline in [`scripts/convert_dicom.py`](file:///C:/Users/felix/dentalar.github.io/scripts/convert_dicom.py):

1. **Z-Axis Subsampling (`--stride 8`)**:
   - Takes every 8th slice, reducing slice count from 1,834 to 230 slices.
   - Retains a sub-millimeter depth increment of **0.104 mm**, ensuring smooth cross-section scrubbing across the entire 24 mm tooth.
2. **Spatial Downscaling (`--scale 0.5`)**:
   - Resamples each slice from 680×600 to 340×300 (a 4× area reduction).
   - Preserves fine anatomical structures (enamel boundary, dentin-enamel junction, root pulp canals).
3. **Calibrated Density Normalization**:
   - Normalizes raw 16-bit CT values into 8-bit grayscale across [0, 28000].
   - Compresses slices into optimized PNG format (~52 KB per slice).
4. **Compression Results**:
   - **Original Dataset**: ~1,500 MB (1.5 GB)
   - **Compressed Dataset**: **12.05 MB** (**>99.2% reduction**)
   - Full dataset loads in seconds and fits well within GitHub Pages limits.

### Running the Converter
```bash
py scripts/convert_dicom.py --input_dir "C:\Users\felix\OneDrive\Desktop\AR Project\S2428" --stride 8 --scale 0.5 --format png
```

---

## 🥽 WebXR & XR Blocks Architecture

The web viewer leverages Google's **XR Blocks** SDK and **Three.js**:

* **Retained Spatial UI (`UICard`)**:
  - A world-space, glassmorphic floating control panel built with XR Blocks' flexbox system.
  - Supports direct raycasting, hand pinch interactions in WebXR AR, and mouse drag in the desktop simulator.
* **Dual Sliders**:
  1. **Depth Slice Slider (`UISlider`)**: Smoothly traverses through depth from crown to root (0.104 mm per step). The 3D slice plane physically glides up and down inside the anatomical bounding cage.
  2. **Density / Window Level Slider (`UISlider`)**: Adjusts density thresholding and contrast midpoint in real time on the GPU. Allows dynamic filtering from soft tissue and background wax to hard dentin and mineralized enamel.
  3. **Window Width Slider (`UISlider`)**: Tunes CT contrast windowing.
* **GPU Density Shader**:
  - Double-sided custom fragment shader evaluating scalar intensity in real-time.
  - Includes a **False-Color Heatmap mode** (soft tissue in blue, dentin in amber, dense enamel in bright white).
* **Cross-Platform Responsive HUD**:
  - Provides bidirectional synchronization between the 3D XR Blocks Spatial UI and a 2D HTML/CSS on-screen overlay for phone, tablet, and desktop viewers.

---

## 🚀 Running Locally

```bash
# Start a local web server
py -m http.server 8000

# Open in browser
http://localhost:8000
```
