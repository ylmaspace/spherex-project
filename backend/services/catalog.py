"""Progressive, bounded browser for official IRSA IBE QR2 Level 2 directory listings."""
from __future__ import annotations

import html
import logging
import os
import re
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import quote, urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)
IBE_LEVEL2_ROOT = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/"
_ALLOWED_HOST = "irsa.ipac.caltech.edu"
_CACHE_TTL = 300
_FITS_SUFFIXES = (".fits", ".fit", ".fts", ".fits.gz", ".fit.gz", ".fts.gz")


class CatalogError(RuntimeError):
    """IRSA IBE catalog or product access failure."""


class CatalogProductNotFoundError(CatalogError):
    """The requested FITS product is not present in an official listing."""


@dataclass(frozen=True)
class CatalogEntry:
    name: str
    path: str
    url: str
    kind: str
    size: int | None = None


class _DirectoryParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._href: str | None = None
        self._text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() == "a":
            self._href = dict(attrs).get("href")
            self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "a" and self._href is not None:
            self.links.append((self._href, "".join(self._text).strip()))
            self._href = None
            self._text = []


class IRSAFileCatalog:
    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "20")))
        self._cache: dict[str, tuple[float, list[CatalogEntry]]] = {}

    @staticmethod
    def normalize_path(path: str | None) -> str:
        value = (path or "").strip().replace("\\", "/")
        if not value:
            return ""
        pieces = value.strip("/").split("/")
        if any(piece in {"", ".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", piece) for piece in pieces):
            raise ValueError("Invalid IRSA catalog path")
        return "/".join(pieces)

    async def list_directory(self, path: str | None = None, *, refresh: bool = False) -> list[CatalogEntry]:
        normalized = self.normalize_path(path)
        cached = self._cache.get(normalized)
        if not refresh and cached and time.monotonic() - cached[0] < _CACHE_TTL:
            return cached[1]
        directory_url = IBE_LEVEL2_ROOT + (quote(normalized, safe="/") + "/" if normalized else "")
        logger.info("IRSA IBE directory listing path=%s", normalized or "/")
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.get(directory_url, headers={"Accept": "text/html, application/json"})
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning("IRSA IBE listing HTTP status=%s path=%s", exc.response.status_code, normalized)
            raise CatalogError(f"IRSA IBE returned HTTP {exc.response.status_code} for this directory") from exc
        except httpx.HTTPError as exc:
            logger.warning("IRSA IBE listing transport failure path=%s: %s", normalized, exc)
            raise CatalogError("Could not connect to the official IRSA IBE archive") from exc
        final = urlparse(str(response.url))
        root_path = urlparse(IBE_LEVEL2_ROOT).path
        if final.scheme != "https" or final.hostname != _ALLOWED_HOST or not final.path.startswith(root_path):
            raise CatalogError("IRSA redirected directory listing outside the official QR2 Level 2 archive")
        try:
            entries = self._parse_listing(response.text, response.url)
        except (ValueError, TypeError) as exc:
            logger.exception("Could not parse IRSA IBE listing path=%s", normalized)
            raise CatalogError("IRSA returned an unsupported directory listing") from exc
        self._cache[normalized] = (time.monotonic(), entries)
        logger.info("IRSA IBE listing succeeded path=%s entries=%d", normalized, len(entries))
        return entries

    @staticmethod
    def _parse_listing(body: str, response_url: httpx.URL, path: str | None = None) -> list[CatalogEntry]:
        base_url = str(response_url)
        try:
            import json
            document = json.loads(body)
        except (ValueError, TypeError):
            document = None
        raw: list[tuple[str, str, int | None]] = []
        if isinstance(document, dict) and isinstance(document.get("entries"), list):
            for item in document["entries"]:
                if isinstance(item, dict) and item.get("name"):
                    size = item.get("size")
                    raw.append((str(item["name"]), str(item.get("href") or item["name"]),
                                int(size) if str(size or "").isdigit() else None))
        else:
            parser = _DirectoryParser()
            parser.feed(body)
            raw = [(label, href, None) for href, label in parser.links]

        root_path = urlparse(IBE_LEVEL2_ROOT).path
        entries: dict[str, CatalogEntry] = {}
        for label, href, size in raw:
            href = html.unescape(href).strip()
            if not href or href.startswith(("?", "#")) or href in {"../", "./", "/"}:
                continue
            resolved = urljoin(base_url, href)
            parsed = urlparse(resolved)
            if parsed.scheme != "https" or parsed.hostname != _ALLOWED_HOST or not parsed.path.startswith(root_path):
                continue
            name = html.unescape(label or parsed.path.rstrip("/").split("/")[-1]).strip()
            if not name or name in {"Parent Directory", "Name", "Last modified", "Size", "Description"}:
                continue
            is_dir = parsed.path.endswith("/") or href.endswith("/")
            relative = parsed.path[len(root_path):].strip("/")
            if not relative:
                continue
            kind = "directory" if is_dir else "fits" if name.lower().endswith(_FITS_SUFFIXES) else "file"
            entries[relative] = CatalogEntry(name, relative, resolved, kind, size)
        return list(entries.values())

    async def search(self, *, path: str | None = None, query: str = "", detector: str = "",
                     planning_period: str = "", date: str = "", band: str = "",
                     page: int = 1, page_size: int = 50, sort: str = "name") -> dict:
        entries = await self.list_directory(path)
        files = [entry for entry in entries if entry.kind == "fits"]
        filters = [query, detector, planning_period, date, band]
        needles = [str(value or "").casefold().strip() for value in filters]
        files = [entry for entry in files if all(not needle or needle in (entry.name + " " + entry.path).casefold()
                                                 for needle in needles)]
        if sort == "path":
            files.sort(key=lambda entry: entry.path.casefold())
        elif sort == "detector":
            files.sort(key=lambda entry: (self._detector(entry.path) or "", entry.name.casefold()))
        else:
            files.sort(key=lambda entry: entry.name.casefold())
        page = max(1, int(page))
        page_size = min(100, max(1, int(page_size)))
        start = (page - 1) * page_size
        directories = [{"name": entry.name, "path": entry.path, "url": entry.url}
                       for entry in entries if entry.kind == "directory"]
        return {
            "source": "IRSA IBE SPHEREx QR2 Level 2",
            "root_url": IBE_LEVEL2_ROOT,
            "path": self.normalize_path(path),
            "directories": directories,
            "count": len(files),
            "page": page,
            "page_size": page_size,
            "pages": (len(files) + page_size - 1) // page_size,
            "observations": [self._entry_dict(entry) for entry in files[start:start + page_size]],
            "metadata_note": "Only listing-provided metadata is returned. FITS headers/WCS are not inferred from filenames.",
        }

    @staticmethod
    def _detector(path: str) -> str | None:
        match = re.search(r"(?i)(?:^|[_/])(D\d+|DET[_-]?\d+)(?:[_./]|$)", path)
        return match.group(1) if match else None

    @classmethod
    def _entry_dict(cls, entry: CatalogEntry) -> dict[str, Any]:
        return {"name": entry.name, "path": entry.path, "url": entry.url, "kind": entry.kind,
                "size_bytes": entry.size, "detector": cls._detector(entry.path)}

    @classmethod
    def validate_fits_path(cls, path: str) -> str:
        normalized = cls.normalize_path(path)
        if not normalized.lower().endswith(_FITS_SUFFIXES):
            raise ValueError("Only FITS products listed under the IRSA Level 2 root may be opened")
        return normalized

    async def stream_fits(self, path: str, range_header: str | None = None):
        normalized = self.validate_fits_path(path)
        # A product is streamable only if its exact link was returned by the
        # official listing for its parent directory; never synthesize FITS URLs.
        parent, _, filename = normalized.rpartition("/")
        entries = await self.list_directory(parent)
        listed = next((entry for entry in entries
                       if entry.kind == "fits" and entry.path == normalized), None)
        if listed is None:
            raise CatalogProductNotFoundError("The requested FITS product is not present in the official IRSA directory listing")
        url = listed.url
        headers = {"Range": range_header} if range_header and re.fullmatch(r"bytes=\d*-\d*", range_header) else {}
        client = httpx.AsyncClient(timeout=self.timeout, follow_redirects=True)
        try:
            response = await client.send(client.build_request("GET", url, headers=headers), stream=True)
            final = urlparse(str(response.url))
            if final.scheme != "https" or final.hostname != _ALLOWED_HOST or not final.path.startswith(urlparse(IBE_LEVEL2_ROOT).path):
                await response.aclose()
                raise CatalogError("FITS product redirected outside the official IRSA archive")
            if response.status_code not in (200, 206):
                status = response.status_code
                await response.aclose()
                raise CatalogError(f"IRSA FITS request returned HTTP {status}")

            async def chunks():
                try:
                    async for chunk in response.aiter_bytes():
                        yield chunk
                finally:
                    await response.aclose()
                    await client.aclose()
            return response, chunks()
        except httpx.HTTPError as exc:
            await client.aclose()
            raise CatalogError("Could not retrieve the FITS product from the official IRSA archive") from exc
        except Exception:
            await client.aclose()
            raise
