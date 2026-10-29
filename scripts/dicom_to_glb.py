#!/usr/bin/env python3
"""
DICOM Micro-CT to 5-Mesh Polygonal GLB Exporter.
Extracts 5 distinct density isosurfaces from Micro-CT DICOM scans (e.g. S2428)
and packages them into a single, performant GLB container with named nodes and materials.
"""

import os
import sys
import glob
import time
import argparse
import numpy as np
import pydicom
from PIL import Image
from skimage import measure
import trimesh
from trimesh.visual.material import PBRMaterial


def parse_args():
    parser = argparse.ArgumentParser(
        description="Convert DICOM CT volume into a 5-layer density GLB model"
    )
    parser.add_argument(
        "--input_dir",
        type=str,
        default="S2428",
        help="Path to directory containing DICOM slices (.dcm / .dcm;1)",
    )
    parser.add_argument(
        "--output",
        type=str,
        default="data/tooth_5_densities.glb",
        help="Path to output .glb file",
    )
    parser.add_argument(
        "--stride",
        type=int,
        default=4,
        help="Slice subsampling stride along Z axis (e.g. 4 = every 4th slice)",
    )
    parser.add_argument(
        "--scale",
        type=float,
        default=0.5,
        help="In-plane spatial scaling factor (e.g. 0.5 = downscale rows & cols by 2x)",
    )
    parser.add_argument(
        "--max_faces",
        type=int,
        default=50000,
        help="Target maximum triangle count per layer after decimation",
    )
    parser.add_argument(
        "--smooth_iterations",
        type=int,
        default=3,
        help="Number of Laplacian smoothing passes to eliminate stepping artifacts",
    )
    return parser.parse_args()


# Anatomically calibrated density thresholds for S2428 Micro-CT (16-bit range ~ -7300 to +25000)
DEFAULT_LAYERS = [
    {
        "name": "Density_1_PulpCanal",
        "label": "Pulp Chamber & Root Canal",
        "iso_value": 7500,
        "color": [0.88, 0.20, 0.20, 1.0],     # Crimson red
        "roughness": 0.5,
        "metallic": 0.05,
    },
    {
        "name": "Density_2_InnerDentin",
        "label": "Predentin / Deep Dentin",
        "iso_value": 13500,
        "color": [0.92, 0.72, 0.40, 0.85],   # Warm amber, slightly translucent
        "roughness": 0.4,
        "metallic": 0.05,
    },
    {
        "name": "Density_3_BulkDentin",
        "label": "Bulk Mineralized Dentin",
        "iso_value": 17500,
        "color": [0.96, 0.92, 0.82, 0.80],   # Ivory bone
        "roughness": 0.35,
        "metallic": 0.05,
    },
    {
        "name": "Density_4_DEJ_Boundary",
        "label": "Dentin-Enamel Junction",
        "iso_value": 20500,
        "color": [0.70, 0.85, 0.90, 0.65],   # Pale mineral cyan/gray
        "roughness": 0.3,
        "metallic": 0.1,
    },
    {
        "name": "Density_5_EnamelCap",
        "label": "Hyper-dense Enamel Crown",
        "iso_value": 22500,
        "color": [0.98, 0.99, 1.00, 0.35],   # Translucent pearl enamel
        "roughness": 0.15,
        "metallic": 0.1,
    },
]


def load_volume(input_dir, stride=4, scale=0.5):
    all_files = sorted(
        [
            os.path.join(input_dir, f)
            for f in os.listdir(input_dir)
            if f.lower().endswith(".dcm") or ".dcm;" in f.lower()
        ]
    )
    if not all_files:
        raise FileNotFoundError(f"No DICOM slices found in {input_dir}")

    selected_files = all_files[::stride]
    print(f"Found {len(all_files)} total slices. Selected {len(selected_files)} slices with stride={stride}")

    # Read first slice to determine dimensions and voxel spacing
    first_dcm = pydicom.dcmread(selected_files[0])
    orig_rows, orig_cols = first_dcm.pixel_array.shape
    new_cols = int(round(orig_cols * scale))
    new_rows = int(round(orig_rows * scale))

    raw_spacing = getattr(first_dcm, "PixelSpacing", [0.013, 0.013])
    raw_spacing = [float(x) for x in raw_spacing] if raw_spacing else [0.013, 0.013]
    slice_thickness = float(getattr(first_dcm, "SliceThickness", 0.013))

    # Real-world physical spacing in millimeters
    dx = raw_spacing[1] / scale
    dy = raw_spacing[0] / scale
    dz = slice_thickness * stride

    print(f"Physical voxel dimensions: dx={dx:.4f}mm, dy={dy:.4f}mm, dz={dz:.4f}mm")
    print(f"Allocating volume matrix: ({len(selected_files)}, {new_rows}, {new_cols}) float32...")

    volume = np.empty((len(selected_files), new_rows, new_cols), dtype=np.float32)

    t0 = time.time()
    for i, fpath in enumerate(selected_files):
        dcm = pydicom.dcmread(fpath)
        arr = dcm.pixel_array.astype(np.float32)
        if scale != 1.0:
            img = Image.fromarray(arr)
            img = img.resize((new_cols, new_rows), Image.Resampling.BILINEAR)
            volume[i] = np.array(img, dtype=np.float32)
        else:
            volume[i] = arr

        if (i + 1) % 50 == 0 or (i + 1) == len(selected_files):
            print(f"  Loaded slice {i+1}/{len(selected_files)} ({(i+1)/len(selected_files)*100:.1f}%)")

    print(f"Volume loaded in {time.time() - t0:.2f}s. Min: {volume.min():.1f}, Max: {volume.max():.1f}")
    return volume, (dz, dy, dx)


def extract_meshes_and_export_glb(volume, spacing, output_path, max_faces=50000, smooth_passes=3):
    dz, dy, dx = spacing
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    scene = trimesh.Scene()
    total_triangles = 0

    # Calculate physical bounding box center for zero-centering
    z_len = volume.shape[0] * dz
    y_len = volume.shape[1] * dy
    x_len = volume.shape[2] * dx
    center_offset = np.array([z_len / 2.0, y_len / 2.0, x_len / 2.0])

    print("\n--- Extracting 5 Polygonal Density Meshes ---")
    for idx, layer in enumerate(DEFAULT_LAYERS):
        name = layer["name"]
        iso = layer["iso_value"]
        color = layer["color"]
        label = layer["label"]

        print(f"\n[{idx+1}/5] Extracting '{name}' ({label}) at isovalue {iso}...")
        t_start = time.time()

        try:
            # skimage marching_cubes: spacing argument accepts (dz, dy, dx)
            verts, faces, normals, _ = measure.marching_cubes(
                volume,
                level=iso,
                spacing=(dz, dy, dx),
                step_size=1,
                allow_degenerate=False,
            )
        except Exception as e:
            print(f"  Warning: Isosurface extraction failed for {name}: {e}")
            continue

        # In Three.js / WebXR standard coordinates: Z is depth, Y is up, X is right.
        # DICOM slices: Z is slice index (axial), Y is row (sagittal/coronal), X is col.
        # We re-orient so tooth is upright (Z axial becomes Y vertical axis in Three.js standard).
        # (z, y, x) -> (x - cx, z - cz, -(y - cy))
        verts_centered = verts - center_offset
        # Transform coords: X -> X, Z -> Y (up), Y -> Z
        reoriented_verts = np.column_stack([
            verts_centered[:, 2],   # X
            verts_centered[:, 0],   # Y (axial slice axis is UP)
            -verts_centered[:, 1],  # Z
        ])

        mesh = trimesh.Trimesh(
            vertices=reoriented_verts,
            faces=faces,
            process=True,
        )

        initial_faces = len(mesh.faces)

        # Apply Laplacian smoothing to eliminate voxelization stepping
        if smooth_passes > 0:
            try:
                trimesh.smoothing.filter_laplacian(mesh, lamb=0.5, iterations=smooth_passes)
            except Exception as e:
                print(f"  Note: Smoothing skipped: {e}")

        # Decimate if face count exceeds target budget
        if max_faces and len(mesh.faces) > max_faces:
            print(f"  Simplifying mesh from {initial_faces:,} to ~{max_faces:,} faces...")
            try:
                mesh = mesh.simplify_quadric_decimation(face_count=max_faces)
            except Exception as e:
                print(f"  Note: Decimation failed ({e}), keeping original faces")

        print(f"  Final mesh: {len(mesh.vertices):,} vertices, {len(mesh.faces):,} faces (took {time.time() - t_start:.2f}s)")
        total_triangles += len(mesh.faces)

        # Create PBR material with custom opacity & color
        pbr_mat = PBRMaterial(
            name=f"Mat_{name}",
            baseColorFactor=color,
            roughnessFactor=layer["roughness"],
            metallicFactor=layer["metallic"],
            alphaMode="BLEND" if color[3] < 1.0 else "OPAQUE",
            doubleSided=True,
        )

        mesh.visual.material = pbr_mat
        mesh.metadata["name"] = name
        mesh.metadata["label"] = label
        mesh.metadata["iso_value"] = iso

        # Add to GLB scene graph as a distinct named node
        scene.add_geometry(mesh, node_name=name, geom_name=name)

    print("\n--- Packaging into GLB Container ---")
    t_exp = time.time()
    glb_bytes = scene.export(file_type="glb")
    with open(output_path, "wb") as f:
        f.write(glb_bytes)

    fsize_mb = os.path.getsize(output_path) / (1024 * 1024)
    print(f"Successfully generated: {output_path}")
    print(f"File size:             {fsize_mb:.2f} MB")
    print(f"Total polygon count:   {total_triangles:,} triangles across 5 meshes")
    print(f"Export time:           {time.time() - t_exp:.2f}s")


def main():
    args = parse_args()
    print("=" * 60)
    print(" DICOM Micro-CT -> 5-Mesh Polygonal GLB Converter")
    print("=" * 60)
    print(f"Input Directory:  {args.input_dir}")
    print(f"Output File:      {args.output}")
    print(f"Stride:           {args.stride} (every {args.stride}th slice)")
    print(f"Scale:            {args.scale} (xy downsampling)")
    print(f"Max Faces/Layer:  {args.max_faces}")
    print(f"Smooth Passes:    {args.smooth_iterations}")

    vol, spacing = load_volume(args.input_dir, stride=args.stride, scale=args.scale)
    extract_meshes_and_export_glb(
        vol,
        spacing,
        args.output,
        max_faces=args.max_faces,
        smooth_passes=args.smooth_iterations,
    )


if __name__ == "__main__":
    main()
