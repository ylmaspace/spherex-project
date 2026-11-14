import asyncio

import httpx
import pytest

from backend.services.catalog import CatalogError, CatalogProductNotFoundError, IRSAFileCatalog


def test_parse_directory_entries_only_official_root_links():
    response_url = httpx.URL("https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/")
    html = '''<html><a href="2025W18_2B/">2025W18_2B/</a>
    <a href="image.fits">image.fits</a><a href="https://evil.example/x.fits">bad</a>
    <a href="../">Parent Directory</a></html>'''
    entries = IRSAFileCatalog._parse_listing(html, response_url, "")
    assert {(item.name, item.kind) for item in entries} == {
        ("2025W18_2B/", "directory"), ("image.fits", "fits")
    }
    assert all("evil.example" not in item.url for item in entries)


def test_path_traversal_and_non_fits_proxy_are_rejected():
    with pytest.raises(ValueError):
        IRSAFileCatalog.normalize_path("../outside")
    with pytest.raises(ValueError):
        IRSAFileCatalog.validate_fits_path("folder/not-a-fits.txt")


def test_catalog_search_filters_and_paginates(monkeypatch):
    catalog = IRSAFileCatalog()
    from backend.services.catalog import CatalogEntry

    async def listing(path=None):
        return [CatalogEntry("a_D1.fits", "2025/D1/a_D1.fits", "https://irsa.ipac.caltech.edu/a", "fits"),
                CatalogEntry("b_D2.fits", "2025/D2/b_D2.fits", "https://irsa.ipac.caltech.edu/b", "fits"),
                CatalogEntry("period/", "2025/period", "https://irsa.ipac.caltech.edu/period/", "directory")]
    monkeypatch.setattr(catalog, "list_directory", listing)
    result = asyncio.run(catalog.search(path="", detector="D1", page=1, page_size=1))
    assert result["count"] == 1
    assert result["observations"][0]["name"] == "a_D1.fits"
    assert len(result["directories"]) == 1


def test_fits_url_is_not_synthesized_as_catalog_entry():
    # Catalog entries are produced only from links returned by the IRSA listing.
    response_url = httpx.URL("https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/")
    entries = IRSAFileCatalog._parse_listing("<html>no files listed</html>", response_url, "")
    assert entries == []


def test_fits_stream_requires_exact_official_listing_entry(monkeypatch):
    catalog = IRSAFileCatalog()

    async def empty_listing(path=None):
        return []

    monkeypatch.setattr(catalog, "list_directory", empty_listing)
    with pytest.raises(CatalogProductNotFoundError):
        asyncio.run(catalog.stream_fits("2025W18_2B/not-listed.fits"))
