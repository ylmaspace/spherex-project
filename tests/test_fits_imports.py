from __future__ import annotations

import asyncio
import gzip
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import backend.main as main
from backend.services.catalog import CatalogEntry


def test_decompress_gzipped_fits_with_output_limit():
    original = b"SIMPLE  =                    T"
    name, payload = main._decompress_fits_if_needed("sample.fits.gz", gzip.compress(original))
    assert name == "sample.fits"
    assert payload == original


def test_rejects_invalid_gzip_fits():
    with pytest.raises(main.FITSProcessingError, match="GZIP"):
        main._decompress_fits_if_needed("broken.fits.gz", b"not gzip")


class FakeCatalog:
    @staticmethod
    def normalize_path(path):
        return "qr2/level2/sample"

    async def list_directory(self, path):
        return [CatalogEntry(
            name="one.fits", path="qr2/level2/sample/one.fits",
            url="https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/sample/one.fits",
            kind="fits", size=4,
        )]

    async def stream_fits(self, path):
        async def chunks():
            yield b"FITS"
        return SimpleNamespace(headers={}), chunks()

    async def stream_access_url(self, url):
        if not url.startswith("https://irsa.ipac.caltech.edu/ibe/data/spherex/"):
            raise ValueError("Only official IRSA URLs are accepted")
        async def chunks():
            yield b"FITS"
        return SimpleNamespace(headers={"content-type": "application/fits"}), chunks()


def test_directory_import_creates_processed_result(monkeypatch):
    monkeypatch.setattr(main, "catalog_service", FakeCatalog())

    async def fake_process(filename, content):
        assert filename == "one.fits"
        assert content == b"FITS"
        return {"id": "a" * 32, "filename": filename, "display_url": "/api/fits/local/" + "a" * 32}

    monkeypatch.setattr(main, "_process_fits_content", fake_process)
    result = asyncio.run(main.import_fits_directory({
        "directory_path": "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/sample/",
        "files": ["qr2/level2/sample/one.fits"],
    }))
    assert result["requested"] == 1
    assert result["imported"] == 1
    assert result["results"][0]["id"] == "a" * 32
    assert result["errors"] == []


def test_directory_import_rejects_oversized_package(monkeypatch):
    monkeypatch.setattr(main, "catalog_service", FakeCatalog())
    with pytest.raises(HTTPException) as error:
        asyncio.run(main.import_fits_directory({
            "directory_path": "sample",
            "files": ["a.fits", "b.fits", "c.fits", "d.fits", "e.fits"],
        }))
    assert error.value.status_code == 413


def test_direct_url_import_uses_server_side_stream(monkeypatch):
    monkeypatch.setattr(main, "catalog_service", FakeCatalog())

    async def fake_process(filename, content):
        assert filename == "sample.fits"
        assert content == b"FITS"
        return {"id": "b" * 32, "filename": filename, "display_url": "/api/fits/local/" + "b" * 32}

    monkeypatch.setattr(main, "_process_fits_content", fake_process)
    result = asyncio.run(main.import_fits_url({
        "url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/sample.fits"
    }))
    assert result["id"] == "b" * 32
