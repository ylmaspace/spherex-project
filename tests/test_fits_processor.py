from __future__ import annotations

import numpy as np
import pytest
from astropy.io import fits

from backend.services.fits_processor import FITSProcessingError, get_display_path, get_preview_path, process_fits_upload


def make_fits_bytes():
    data = np.arange(100, dtype=np.float32).reshape(10, 10)
    header = fits.Header()
    header["CTYPE1"] = "RA---TAN"
    header["CTYPE2"] = "DEC--TAN"
    header["CRVAL1"] = 150.25
    header["CRVAL2"] = 2.5
    header["CRPIX1"] = 5.5
    header["CRPIX2"] = 5.5
    header["CDELT1"] = -0.001
    header["CDELT2"] = 0.001
    import io
    buffer = io.BytesIO()
    fits.PrimaryHDU(data=data, header=header).writeto(buffer)
    return buffer.getvalue()


def test_process_fits_extracts_image_and_celestial_coordinates(tmp_path, monkeypatch):
    import backend.services.fits_processor as processor
    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    result = process_fits_upload("test-observation.fits", make_fits_bytes())

    assert result["filename"] == "test-observation.fits"
    assert result["width"] == 10
    assert result["height"] == 10
    assert result["ra"] == pytest.approx(150.25, abs=0.01)
    assert result["dec"] == pytest.approx(2.5, abs=0.01)
    assert result["hdu_index"] == 0
    assert get_display_path(result["id"]).is_file()
    assert get_preview_path(result["id"]).is_file()


def test_fits_without_celestial_wcs_still_renders_preview(tmp_path, monkeypatch):
    # Missing WCS must not prevent the raster preview from being displayed.
    import io
    import backend.services.fits_processor as processor
    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    buffer = io.BytesIO()
    fits.PrimaryHDU(data=np.ones((4, 4), dtype=np.float32)).writeto(buffer)
    result = process_fits_upload("no-wcs.fits", buffer.getvalue())
    assert result["ra"] is None
    assert result["dec"] is None
    assert result["width"] == 4
    assert get_preview_path(result["id"]).is_file()


def test_rejects_non_fits_upload():
    with pytest.raises(FITSProcessingError, match="Formato no admitido"):
        process_fits_upload("notes.txt", b"not fits")

def test_selects_largest_hdu_and_extracts_central_cube_plane(tmp_path, monkeypatch):
    import io
    from PIL import Image
    import backend.services.fits_processor as processor

    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    small = np.ones((5, 5), dtype=np.float32)
    cube = np.stack([
        np.full((10, 10), value, dtype=np.float32)
        for value in range(12)
    ])
    stream = io.BytesIO()
    fits.HDUList([
        fits.PrimaryHDU(data=small),
        fits.ImageHDU(data=cube),
    ]).writeto(stream)

    result = process_fits_upload("multi-extension.fits", stream.getvalue())

    assert result["hdu_index"] == 1
    assert result["hdu_count"] == 2
    assert result["width"] == 10
    assert result["height"] == 10
    with fits.open(get_display_path(result["id"])) as display:
        assert display[0].data.shape == (10, 10)
        assert np.all(display[0].data == 6)
    with Image.open(get_preview_path(result["id"])) as preview:
        assert preview.size == (10, 10)
        assert preview.mode == "L"


def test_rejects_image_with_no_finite_pixels(tmp_path, monkeypatch):
    import io
    import backend.services.fits_processor as processor

    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    stream = io.BytesIO()
    fits.PrimaryHDU(data=np.full((8, 8), np.nan, dtype=np.float32)).writeto(stream)

    with pytest.raises(FITSProcessingError, match="píxeles válidos"):
        process_fits_upload("all-invalid.fits", stream.getvalue())

