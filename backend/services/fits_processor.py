"""FITS upload inspection, WCS extraction and Aladin-compatible image preparation."""
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
            candidates = []
            for index, hdu in enumerate(hdus):
                data = hdu.data
                if data is None:
                    continue
                array = np.asarray(data)
                if array.ndim < 2 or array.size == 0:
                    continue
                # For cubes, take the central plane of every leading axis.
                while array.ndim > 2:
                    array = array[tuple(size // 2 for size in array.shape[:-2])]
                if array.ndim == 2 and array.shape[0] > 1 and array.shape[1] > 1:
                    candidates.append((array.shape[0] * array.shape[1], index, hdu, array))
            if not candidates:
                raise FITSProcessingError("No se encontró ninguna extensión con una imagen 2D.")
            _, hdu_index, selected_hdu, image = max(candidates, key=lambda item: item[0])
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
            # Produce a compact single-image FITS so Aladin displays the selected HDU,
            # even when the original product is a multi-extension FITS (MEF).
            fits.PrimaryHDU(data=np.asarray(image, dtype=np.float32), header=header).writeto(
                display_path, overwrite=True, output_verify="silentfix"
            )
            # Independent PNG preview: does not call Aladin, CDS, IRSA or any remote API.
            preview_data = np.asarray(image, dtype=np.float32)
            valid = preview_data[np.isfinite(preview_data)]
            if valid.size == 0:
                raise FITSProcessingError("La extensión seleccionada no contiene píxeles válidos.")
            p_low, p_high = np.percentile(valid, [1.0, 99.5])
            if not np.isfinite(p_low) or not np.isfinite(p_high) or p_high <= p_low:
                p_low, p_high = float(valid.min()), float(valid.max())
            if p_high <= p_low:
                p_high = p_low + 1.0
            normalized = np.nan_to_num((preview_data - p_low) / (p_high - p_low), nan=0.0, posinf=1.0, neginf=0.0)
            pixels = np.clip(normalized * 255.0, 0, 255).astype(np.uint8)
            Image.fromarray(pixels, mode="L").save(preview_path, format="PNG", optimize=True)
            finite = np.asarray(image, dtype=np.float32)
            finite = finite[np.isfinite(finite)]
            if finite.size == 0:
                raise FITSProcessingError("La extensión seleccionada solo contiene valores no finitos.")
            low, high = np.percentile(finite, [1.0, 99.5])
            if not np.isfinite(low) or not np.isfinite(high) or high <= low:
                low, high = float(finite.min()), float(finite.max())
            if high <= low:
                high = low + 1.0
            try:
                from astropy.wcs.utils import proj_plane_pixel_scales
                scales = np.abs(proj_plane_pixel_scales(wcs)) * 3600.0 if wcs.has_celestial else []
                pixel_scale_arcsec = float(np.mean(scales)) if len(scales) else None
            except Exception:
                pixel_scale_arcsec = None
            original_path.unlink(missing_ok=True)
            return {
                "id": upload_id,
                "filename": Path(filename).name[:180],
                "size_bytes": len(content),
                "hdu_index": hdu_index,
                "hdu_count": len(hdus),
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
