from __future__ import annotations

import asyncio
import gzip
import io
from types import SimpleNamespace

import numpy as np
import pytest
from astropy.io import fits
from fastapi import HTTPException
from starlette.datastructures import UploadFile

import backend.main as main
import backend.services.fits_processor as processor
from backend.services.catalog import CatalogEntry


def make_fits_bytes():
    data = np.arange(64, dtype=np.float32).reshape(8, 8)
    header = fits.Header()
    header["CTYPE1"] = "RA---TAN"
    header["CTYPE2"] = "DEC--TAN"
    header["CRVAL1"] = 150.25
    header["CRVAL2"] = 2.5
    header["CRPIX1"] = 4.5
    header["CRPIX2"] = 4.5
    header["CDELT1"] = -0.001
    header["CDELT2"] = 0.001
    stream = io.BytesIO()
    fits.PrimaryHDU(data=data, header=header).writeto(stream)
    return stream.getvalue()


def test_decompress_gzipped_fits_with_output_limit():
    original = b"SIMPLE  =                    T"
    name, payload = main._decompress_fits_if_needed("sample.fits.gz", gzip.compress(original))
    assert name == "sample.fits"
    assert payload == original


def test_rejects_invalid_gzip_fits():
    with pytest.raises(main.FITSProcessingError, match="GZIP"):
        main._decompress_fits_if_needed("broken.fits.gz", b"not gzip")


class FakeCatalog:
    def __init__(self, content):
        self.content = content

    @staticmethod
    def normalize_path(path):
        return "qr2/level2/sample"

    async def list_directory(self, path):
        return [CatalogEntry(
            name="one.fits", path="qr2/level2/sample/one.fits",
            url="https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/sample/one.fits",
            kind="fits", size=len(self.content),
        )]

    async def stream_fits(self, path):
        async def chunks():
            yield self.content
        return SimpleNamespace(headers={}), chunks()

    async def stream_access_url(self, url):
        if not url.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/"):
            raise ValueError("Only official IRSA URLs are accepted")

        async def chunks():
            yield self.content
        return SimpleNamespace(headers={"content-type": "application/fits"}), chunks()


def test_directory_import_downloads_processes_and_publishes_preview(tmp_path, monkeypatch):
    content = make_fits_bytes()
    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(main, "catalog_service", FakeCatalog(content))
    result = asyncio.run(main.import_fits_directory({
        "directory_path": "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/sample/",
        "files": ["qr2/level2/sample/one.fits"],
    }))
    assert result["requested"] == 1
    assert result["imported"] == 1
    record = result["results"][0]
    assert record["width"] == 8
    assert record["height"] == 8
    assert record["source_path"] == "qr2/level2/sample/one.fits"
    assert record["display_url"] == f"/api/fits/local/{record['id']}"
    assert processor.get_preview_path(record["id"]).is_file()
    assert processor.get_display_path(record["id"]).is_file()
    assert result["errors"] == []


def test_directory_import_rejects_oversized_package(monkeypatch):
    monkeypatch.setattr(main, "catalog_service", FakeCatalog(b"FITS"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.import_fits_directory({
            "directory_path": "sample",
            "files": ["a.fits", "b.fits", "c.fits", "d.fits", "e.fits"],
        }))
    assert error.value.status_code == 413


def test_direct_url_import_downloads_and_processes_on_server(tmp_path, monkeypatch):
    content = make_fits_bytes()
    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    monkeypatch.setattr(main, "catalog_service", FakeCatalog(content))
    result = asyncio.run(main.import_fits_url({
        "url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/sample.fits"
    }))
    assert result["width"] == 8
    assert result["height"] == 8
    assert processor.get_preview_path(result["id"]).is_file()
    assert processor.get_display_path(result["id"]).is_file()


def test_local_upload_accepts_plain_and_gzipped_fits(tmp_path, monkeypatch):
    content = make_fits_bytes()
    monkeypatch.setattr(processor, "UPLOAD_DIR", tmp_path)
    plain = UploadFile(filename="local.fits", file=io.BytesIO(content))
    compressed = UploadFile(filename="local.fits.gz", file=io.BytesIO(gzip.compress(content)))
    plain_result = asyncio.run(main.upload_local_fits(plain))
    gzip_result = asyncio.run(main.upload_local_fits(compressed))
    assert plain_result["width"] == gzip_result["width"] == 8
    assert plain_result["height"] == gzip_result["height"] == 8
    assert processor.get_preview_path(plain_result["id"]).is_file()
    assert processor.get_preview_path(gzip_result["id"]).is_file()
