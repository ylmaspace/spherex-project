"""FITS inspection, WCS extraction and independent raster-preview generation."""
from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image
from astropy.io import fits
from astropy.wcs import WCS

UPLOAD_DIR = Path(os.getenv("SPHEREX_UPLOAD_DIR", "/tmp/ylma-spherex-fits"))
MAX_UPLOAD_BYTES = 120 * 1024 * 1024
PREVIEW_SAMPLE_PIXELS = 2_000_000
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


class FITSProcessingError(ValueError):
    pass


def process_fits_upload(filename: str, content: bytes) -> dict[str, Any]:
    if not content:
        raise FITSProcessingError("El archivo está vacío.")
    if len(content) > MAX_UPLOAD_BYTES:
        raise FITSProcessingError("El archivo supera el límite de 120 MB.")
    if not filename.lower().endswith((".fits", ".fit", ".fts")):
        raise FITSProcessingError("Formato no admitido. Sube un FITS sin comprimir.")

    upload_id = uuid.uuid4().hex
    original_path = UPLOAD_DIR / f"{upload_id}.fits"
    display_path = UPLOAD_DIR / f"{upload_id}-display.fits"
    preview_path = UPLOAD_DIR / f"{upload_id}-preview.png"

    try:
        original_path.write_bytes(content)
        with fits.open(original_path, memmap=False, lazy_load_hdus=True) as hdus:
            # Inspect HDU shapes first. Do not load every image array into RAM just
            # to decide which 2-D plane is the most useful one.
            candidates: list[tuple[int, int]] = []
            for index, hdu in enumerate(hdus):
                shape = getattr(hdu, "shape", None)
                if not shape or len(shape) < 2:
                    continue
                height, width = int(shape[-2]), int(shape[-1])
                if height > 1 and width > 1:
                    candidates.append((height * width, index))

            if not candidates:
                raise FITSProcessingError("No se encontró ninguna extensión con una imagen 2D.")

            _, hdu_index = max(candidates, key=lambda item: item[0])
            selected_hdu = hdus[hdu_index]
            if selected_hdu.data is None:
                raise FITSProcessingError("La extensión de imagen seleccionada no contiene datos.")

            image = np.asarray(selected_hdu.data)
            # For cubes, take the central plane of every leading axis.
            while image.ndim > 2:
                image = image[tuple(size // 2 for size in image.shape[:-2])]
            if image.ndim != 2 or image.shape[0] < 2 or image.shape[1] < 2:
                raise FITSProcessingError("La extensión seleccionada no contiene una imagen 2D válida.")

            header = selected_hdu.header.copy()
            if not WCS(header).has_celestial:
                header = hdus[0].header.copy()
            wcs = WCS(header).celestial

            height, width = image.shape
            center_x, center_y = (width - 1) / 2, (height - 1) / 2
            ra = dec = None
            if wcs.has_celestial:
                ra_value, dec_value = wcs.pixel_to_world_values(center_x, center_y)
                ra, dec = float(ra_value) % 360.0, float(dec_value)
                if not np.isfinite(ra) or not np.isfinite(dec) or not -90 <= dec <= 90:
                    ra = dec = None

            display_data = np.asarray(image, dtype=np.float32)
            fits.PrimaryHDU(data=display_data, header=header).writeto(
                display_path, overwrite=True, output_verify="silentfix"
            )

            # Estimate the display stretch from a bounded sample. The raster is
            # still generated at full resolution, but percentile calculation no
            # longer sorts a second full-size copy of a large science image.
            flat = display_data.reshape(-1)
            sample_step = max(1, int(np.ceil(flat.size / PREVIEW_SAMPLE_PIXELS)))
            sample = flat[::sample_step]
            finite_sample = sample[np.isfinite(sample)]
            if finite_sample.size == 0:
                finite_mask = np.isfinite(display_data)
                if not np.any(finite_mask):
                    raise FITSProcessingError("La extensión seleccionada no contiene píxeles válidos.")
                finite_sample = display_data[finite_mask]

            p_low, p_high = np.percentile(finite_sample, [1.0, 99.5])
            if not np.isfinite(p_low) or not np.isfinite(p_high) or p_high <= p_low:
                p_low, p_high = float(finite_sample.min()), float(finite_sample.max())
            if p_high <= p_low:
                p_high = p_low + 1.0

            normalized = (display_data - np.float32(p_low)) / np.float32(p_high - p_low)
            np.nan_to_num(normalized, copy=False, nan=0.0, posinf=1.0, neginf=0.0)
            np.clip(normalized, 0.0, 1.0, out=normalized)
            normalized *= np.float32(255.0)
            pixels = normalized.astype(np.uint8)
            Image.fromarray(pixels).save(
                preview_path, format="PNG", optimize=False, compress_level=1
            )

            try:
                from astropy.wcs.utils import proj_plane_pixel_scales
                scales = np.abs(proj_plane_pixel_scales(wcs)) * 3600.0 if wcs.has_celestial else []
                pixel_scale_arcsec = float(np.mean(scales)) if len(scales) else None
            except Exception:
                pixel_scale_arcsec = None

            hdu_count = len(hdus)
            original_path.unlink(missing_ok=True)
            return {
                "id": upload_id,
                "filename": Path(filename).name[:180],
                "size_bytes": len(content),
                "hdu_index": hdu_index,
                "hdu_count": hdu_count,
                "width": int(width),
                "height": int(height),
                "ra": ra,
                "dec": dec,
                "pixel_scale_arcsec": pixel_scale_arcsec,
                "display_path": str(display_path),
                "preview_path": str(preview_path),
            }
    except FITSProcessingError:
        original_path.unlink(missing_ok=True)
        display_path.unlink(missing_ok=True)
        preview_path.unlink(missing_ok=True)
        raise
    except Exception as exc:
        original_path.unlink(missing_ok=True)
        display_path.unlink(missing_ok=True)
        preview_path.unlink(missing_ok=True)
        raise FITSProcessingError(f"No se pudo interpretar el FITS: {exc}") from exc


def get_display_path(upload_id: str) -> Path:
    if not upload_id or not upload_id.isalnum() or len(upload_id) != 32:
        raise FITSProcessingError("Identificador de FITS no válido.")
    path = UPLOAD_DIR / f"{upload_id}-display.fits"
    if not path.is_file():
        raise FileNotFoundError("El FITS procesado ya no está disponible en este servidor.")
    return path


def get_preview_path(upload_id: str) -> Path:
    if not upload_id or not upload_id.isalnum() or len(upload_id) != 32:
        raise FITSProcessingError("Identificador de FITS no válido.")
    path = UPLOAD_DIR / f"{upload_id}-preview.png"
    if not path.is_file():
        raise FileNotFoundError("La vista previa ya no está disponible en este servidor.")
    return path
