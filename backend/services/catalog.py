import asyncio
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


class CatalogError(RuntimeError):
    """The official IRSA IBE catalog cannot be read or parsed."""


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
    """Progressive, bounded browser for the official public IBE directory index.

    It reads one requested directory at a time; it does not crawl or download the full
    archive. Only directory listing names and metadata actually provided by IRSA are
    returned. FITS header/WCS metadata is not inferred from filenames.
    """

    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "20")))
        self._cache: dict[str, tuple[float, list[CatalogEntry]]] = {}

    @staticmethod
    def normalize_path(path: str | None) -> str:
        path = (path or "").strip().strip("/")").replace("\\", "/")
        if not path:
            return ""
        pieces = path.split("/")
        if any(piece in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", piece) for piece in pieces):
            raise ValueError("Invalid IRSA catalog path")
        return "/".join(pieces)

    async def list_directory(self, path: str | None = None) -> list[CatalogEntry]:
        normalized = self.normalize_path(path)
        cached = self._cache.get(normalized)
        if cached and time.monotonic() - cached[0] < _CACHE_TTL:
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
            logger.exception("IRSA IBE listing transport error path=%s", normalized)
            raise CatalogError("Could not connect to the official IRSA IBE archive") from exc

        try:
            entries = self._parse_listing(response.text, response.url, normalized)
        except (ValueError, TypeError) as exc:
            logger.exception("IRSA IBE listing parse error path=%s", normalized)
            raise CatalogError("IRSA returned a directory listing in an unsupported format") from exc
        self._cache[normalized] = (time.monotonic(), entries)
        logger.info("IRSA IBE listing succeeded path=%s entries=%d", normalized, len(entries))
        return entries

    @staticmethod
    def _parse_listing(body: str, response_url: httpx.URL, current_path: str) -> list[CatalogEntry]:
        content_type_url = str(response_url)
        # JSON listing support for IBE/API deployments that return a JSON directory index.
        try:
            import json
            document = json.loads(body)
        except (ValueError, TypeError):
            document = None
        raw_entries: list[tuple[str, str, int | None]] = []
        if isinstance(document, dict) and isinstance(document.get("entries"), list):
            for item in document["entries"]:
                if not isinstance(item, dict) or not item.get("name"):
                    continue
                raw_entries.append((str(item["name"]), str(item.get("href") or item["name"]),
                                    int(item["size"]) if str(item.get("size", "")).isdigit() else None))
        else:
            parser = _DirectoryParser()
            parser.feed(body)
            for href, label in parser.links:
                raw_entries.append((label, href, None))

        entries: list[CatalogEntry] = []
        for label, href, size in raw_entries:
            href = html.unescape(href).strip()
            if not href or href in {"../", "./", "/"} or href.startswith(("?", "#")):
                continue
            resolved = urljoin(content_type_url, href)
            parsed = urlparse(resolved)
            if parsed.scheme != "https" or parsed.hostname != _ALLOWED_HOST:
                continue
            base_path = urlparse(IBE_LEVEL2_ROOT).path
            if not parsed.path.startswith(base_path):
                continue
            name = html.unescape(label or parsed.path.rstrip("/").split("/")[-1]).strip()
            if not name or name in {"Parent Directory", "Name", "Last modified", "Size", "Description"}:
                continue
            is_dir = parsed.path.endswith("/") or href.endswith("/")
            relative = parsed.path[len(base_path):].strip("/")
            entries.append(CatalogEntry(name=name, path=relative, url=resolved,
                                        kind="directory" if is_dir else "fits" if name.lower().endswith((".fits", ".fit", ".fits.gz", ".fit.gz")) else "file",
                                        size=size))
        # Deduplicate directory indexes which sometimes link the same item more than once.
        return list({entry.path: entry for entry in entries}.values())

    async def search(self, *, path: str | None, query: str = "", detector: str = "",
                     planning_period: str = "", page: int = 1, page_size: int = 50,
                     sort: str = "name") -> dict:
        entries = await self.list_directory(path)
        files = [entry for entry in entries if entry.kind == "fits"]
        q = query.casefold().strip()
        detector_filter = detector.casefold().strip()
        period_filter = planning_period.casefold().strip()
        files = [entry for entry in files if (not q or q in entry.name.casefold())
                 and (not detector_filter or detector_filter in entry.path.casefold())
                 and (not period_filter or period_filter in entry.path.casefold())]
        if sort == "path":
            files.sort(key=lambda entry: entry.path.casefold())
        else:
            files.sort(key=lambda entry: entry.name.casefold())
        page = max(1, page)
        page_size = min(100, max(1, page_size))
        start = (page - 1) * page_size
        directories = [{"name": item.name, "path": item.path, "url": item.url}
                       for item in entries if item.kind == "directory"]
        return {
            "source": "IRSA IBE SPHEREx QR2 Level 2",
            "root_url": IBE_LEVEL2_ROOT,
            "path": self.normalize_path(path),
            "directories": directories,
            "count": len(files),
            "page": page,
            "page_size": page_size,
            "pages": (len(files) + page_size - 1) // page_size,
            "observations": [self._entry_dict(item) for item in files[start:start + page_size]],
            "metadata_note": "Only metadata present in the official directory listing is returned; FITS header/WCS metadata is not inferred.",
        }

    @staticmethod
    def _entry_dict(entry: CatalogEntry) -> dict:
        parts = entry.path.split("/")
        detector = next((part for part in parts if re.fullmatch(r"(?i)(d|det)[_-]?\d+", part)), None)
        return {"name": entry.name, "path": entry.path, "url": entry.url, "kind": entry.kind,
                "size_bytes": entry.size, "detector": detector, "planning_period": parts[0] if len(parts) > 1 else None}

    @staticmethod
    def validate_fits_path(path: str) -> str:
        normalized = IRSAFileCatalog.normalize_path(path)
        if not normalized.lower().endswith((".fits", ".fit", ".fits.gz", ".fit.gz")):
            raise ValueError("Only FITS product paths from the IRSA Level 2 archive are accepted")
        return normalized

    async def stream_fits(self, path: str, range_header: str | None = None):
        normalized = self.validate_fits_path(path)
        url = IBE_LEVEL2_ROOT + quote(normalized, safe="/")
        request_headers = {"Range": range_header} if range_header and re.fullmatch(r"bytes=\d*-\d*", range_header) else {}
        client = httpx.AsyncClient(timeout=self.timeout, follow_redirects=True)
        try:
            request = client.build_request("GET", url, headers=request_headers)
            response = await client.send(request, stream=True)
            if response.status_code not in (200, 206):
                status = response.status_code
                await response.aclose()
                await client.aclose()
                raise CatalogError(f"IRSA FITS request returned HTTP {status}")
            async def chunks():
                try:
                    async for chunk in response.aiter_bytes():
                        yield chunk
                finally:
                    await response.aclose()
                    await client.aclose()
            return response, chunks()
        except Exception:
            await client.aclose()
            raise
