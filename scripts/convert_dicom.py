#!/usr/bin/env python3
"""
DICOM Micro-CT Scan Preprocessor for WebXR Viewer.
Shrinks large DICOM datasets (1.5+ GB) down to lightweight, WebXR-friendly
compressed PNG/WebP slices and generates a manifest.json.
"""

import os
import sys
import glob
import json
import argparse
import time
import numpy as np
from PIL import Image
import pydicom

def parse_args():
    parser = argparse.ArgumentParser(description="Preprocess DICOM CT slices for WebXR")
    parser.add_argument(
        "--input_dir",
        type=str,
        default=r"C:\Users\felix\OneDrive\Desktop\AR Project\S2428",
        help="Path to DICOM slice directory",
    )
    parser.add_argument(
        "--output_dir",
        type=str,
        default=r"data",
        help="Output directory for compressed slices and manifest",
    )
    parser.add_argument(
        "--stride",
        type=int,
        default=8,
        help="Keep every Nth slice (e.g. 8 for ~230 slices from 1834)",
    )
    parser.add_argument(
        "--scale",
        type=float,
        default=0.5,
        help="Scale factor for spatial resolution (e.g. 0.5 for 340x300)",
    )
    parser.add_argument(
        "--format",
        type=str,
        default="png",
        choices=["png", "webp"],
        help="Output image format (png or webp)",
    )
    parser.add_argument(
        "--min_val",
        type=float,
        default=0.0,
        help="Minimum pixel value for normalization clamp (air/background)",
    )
    parser.add_argument(
        "--max_val",
        type=float,
        default=28000.0,
        help="Maximum pixel value for normalization clamp (dense enamel)",
    )
    return parser.parse_args()

def process_dataset():
    args = parse_args()
    input_dir = args.input_dir
    output_dir = args.output_dir
    stride = args.stride
    scale = args.scale
    fmt = args.format.lower()
    min_val = args.min_val
    max_val = args.max_val

    if not os.path.isdir(input_dir):
        print(f"Error: Input directory does not exist: {input_dir}")
        sys.exit(1)

    slices_dir = os.path.join(output_dir, "slices")
    os.makedirs(slices_dir, exist_ok=True)

    # Find all DICOM files
    all_files = sorted(
        [
            os.path.join(input_dir, f)
            for f in os.listdir(input_dir)
            if f.lower().endswith(".dcm") or ".dcm;" in f.lower()
        ]
    )
    total_found = len(all_files)
    if total_found == 0:
        print(f"Error: No DICOM files found in {input_dir}")
        sys.exit(1)

    print(f"Found {total_found} DICOM slices in {input_dir}")

    # Subsample files by stride
    selected_files = all_files[::stride]
    num_selected = len(selected_files)
    print(f"Selected {num_selected} slices using stride={stride} (every {stride}th slice)")

    # Read first slice for metadata
    first_dcm = pydicom.dcmread(selected_files[0])
    orig_rows, orig_cols = first_dcm.pixel_array.shape
    new_cols = int(round(orig_cols * scale))
    new_rows = int(round(orig_rows * scale))

    pixel_spacing = getattr(first_dcm, "PixelSpacing", [0.013, 0.013])
    pixel_spacing = [float(x) for x in pixel_spacing] if pixel_spacing else [0.013, 0.013]
    slice_thickness = float(getattr(first_dcm, "SliceThickness", 0.013))
    effective_slice_thickness = slice_thickness * stride

    print(f"Original resolution: {orig_cols}x{orig_rows}")
    print(f"Scaled resolution:   {new_cols}x{new_rows} (scale={scale})")
    print(f"Original spacing:    {pixel_spacing[0]:.4f} mm x {pixel_spacing[1]:.4f} mm")
    print(f"Effective depth step:{effective_slice_thickness:.4f} mm (total depth: {num_selected * effective_slice_thickness:.2f} mm)")

    manifest_slices = []
    t0 = time.time()
    total_bytes = 0

    print("Processing slices...")
    for idx, fpath in enumerate(selected_files):
        try:
            dcm = pydicom.dcmread(fpath)
            raw = dcm.pixel_array.astype(np.float32)

            # Normalize to 0 - 255
            norm = np.clip((raw - min_val) / (max_val - min_val) * 255.0, 0, 255).astype(np.uint8)
            img = Image.fromarray(norm)

            if scale != 1.0:
                img = img.resize((new_cols, new_rows), Image.Resampling.LANCZOS)

            fname = f"slice_{idx:04d}.{fmt}"
            out_path = os.path.join(slices_dir, fname)

            if fmt == "webp":
                img.save(out_path, format="WEBP", quality=90)
            else:
                img.save(out_path, format="PNG", optimize=True)

            fsize = os.path.getsize(out_path)
            total_bytes += fsize
            manifest_slices.append(fname)

            if (idx + 1) % 50 == 0 or idx + 1 == num_selected:
                print(f"  Processed {idx + 1}/{num_selected} slices ({(idx + 1)/num_selected*100:.1f}%)")

        except Exception as e:
            print(f"Warning: Failed to process slice {fpath}: {e}")

    elapsed = time.time() - t0
    total_mb = total_bytes / (1024 * 1024)

    # Save manifest.json
    manifest = {
        "title": "Dental Micro-CT Sample S2428",
        "total_slices": len(manifest_slices),
        "original_slices": total_found,
        "stride": stride,
        "width": new_cols,
        "height": new_rows,
        "original_width": orig_cols,
        "original_height": orig_rows,
        "pixel_spacing_mm": [pixel_spacing[0] / scale, pixel_spacing[1] / scale],
        "slice_thickness_mm": effective_slice_thickness,
        "total_depth_mm": len(manifest_slices) * effective_slice_thickness,
        "intensity_range": [min_val, max_val],
        "format": fmt,
        "slices_dir": "slices",
        "slices": manifest_slices,
    }

    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print("\nProcessing complete!")
    print(f"Total slices saved:  {len(manifest_slices)}")
    print(f"Total dataset size:  {total_mb:.2f} MB")
    print(f"Time taken:          {elapsed:.2f} seconds")
    print(f"Manifest written to: {manifest_path}")

if __name__ == "__main__":
    process_dataset()
