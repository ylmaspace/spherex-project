"""Live-only IRSA TAP and QR2 archive integration.

No local/demo observation data is returned from this module. Table and column
identifiers are discovered from TAP_SCHEMA at runtime before ADQL is constructed.
"""
from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import re
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, urljoin, urlparse

import httpx

logger = logging.getLogger(__name__)


class IRSAError(RuntimeError):
    """Base error for a failed or incompatible IRSA response."""


class IRSAConnectionError(IRSAError):
    """IRSA could not be reached or returned a non-success status."""


class IRSATAPQueryError(IRSAError):
    """IRSA returned a TAP/ADQL error or an invalid TAP payload."""


class IRSATableNotFoundError(IRSAError):
    """No advertised SPHEREx ObsCore table is available."""


class IRSAIncompatibleSchemaError(IRSAError):
    """A candidate table does not expose the verified fields required by this app."""


class ObservationNotFoundError(LookupError):
    """An observation identifier did not match a live IRSA record."""


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


class IRSAService:
    BASE_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
    BASE_QR2_LEVEL2 = "https://irsa.ipac.caltech.edu/ibe/data/spherex/qr2/level2/"
    MAX_ATTEMPTS = 3
    MAX_RESULTS = min(500, max(1, int(os.getenv("IRSA_MAX_RESULTS", "100"))))
    IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
    OBSCORE_COLUMNS = (
        "obs_id", "obs_publisher_did", "dataproduct_type", "calib_level",
        "obs_collection", "obs_title", "target_name", "s_ra", "s_dec",
        "s_fov", "s_region", "em_min", "em_max", "t_min", "t_max",
        "access_url", "access_format", "facility_name", "instrument_name",
    )

    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "20")))
        self.max_results = min(500, max(1, int(os.getenv("IRSA_MAX_RESULTS", "100"))))
        self._table_cache: list[dict[str, str]] | None = None
        self._column_cache: dict[str, set[str]] = {}
        self._directory_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    @staticmethod
    def _safe_identifier(value: Any) -> str | None:
        text = str(value or "").strip()
        return text if IRSAService.IDENTIFIER.fullmatch(text) else None

    @staticmethod
    def _tap_error(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None
        error = payload.get("error") or payload.get("ERROR")
        if error:
            return str(error)[:1000]
        metadata = payload.get("metadata", [])
        if isinstance(metadata, list):
            for field in metadata:
                if isinstance(field, dict) and str(field.get("name", "")).upper() == "QUERY_STATUS":
                    value = str(field.get("value") or field.get("description") or "")
                    if value.upper().startswith("ERROR"):
                        return value[:1000]
        return None

    async def _request(self, query: str, *, phase: str) -> dict[str, Any]:
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": query}
        for attempt in range(self.MAX_ATTEMPTS):
            logger.info("IRSA TAP phase=%s attempt=%d query=%s", phase, attempt + 1, query)
            try:
                async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                    response = await client.get(self.BASE_TAP_URL, params=params)
            except httpx.HTTPError as exc:
                logger.warning("IRSA TAP transport failure phase=%s attempt=%d: %s", phase, attempt + 1, exc)
                if attempt + 1 < self.MAX_ATTEMPTS:
                    await asyncio.sleep(0.2 * (2**attempt))
                    continue
                raise IRSAConnectionError(f"IRSA TAP connection failed during {phase}") from exc
            if not response.is_success:
                body = response.text[:1000].replace("\n", " ")
                logger.error("IRSA TAP HTTP failure phase=%s status=%d body=%s", phase, response.status_code, body)
                if response.status_code >= 500 and attempt + 1 < self.MAX_ATTEMPTS:
                    await asyncio.sleep(0.2 * (2**attempt))
                    continue
                if response.status_code in {400, 422} or any(word in body.lower() for word in ("adql", "table", "column", "syntax")):
                    raise IRSATAPQueryError(f"IRSA rejected {phase}: {body}")
                raise IRSAConnectionError(f"IRSA returned HTTP {response.status_code} during {phase}")
            try:
                payload = response.json()
            except (ValueError, json.JSONDecodeError) as exc:
                raise IRSATAPQueryError(f"IRSA returned a non-JSON response during {phase}") from exc
            if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                raise IRSATAPQueryError(f"IRSA returned an unsupported TAP JSON format during {phase}")
            error = self._tap_error(payload)
            if error:
                logger.error("IRSA TAP response error phase=%s: %s", phase, error)
                raise IRSATAPQueryError(f"IRSA TAP error during {phase}: {error}")
            return payload
        raise IRSAConnectionError(f"IRSA TAP connection failed during {phase}")

    @staticmethod
    def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
        rows = payload.get("data", [])
        fields = payload.get("fields") or payload.get("metadata") or []
        names: list[str] = []
        for field in fields:
            if isinstance(field, dict):
                name = field.get("name") or field.get("column_name")
                if name:
                    names.append(str(name))
            elif isinstance(field, str):
                names.append(field)
        result: list[dict[str, Any]] = []
        for row in rows:
            if isinstance(row, dict):
                result.append({str(key).lower(): value for key, value in row.items()})
            elif isinstance(row, (list, tuple)) and names and len(row) == len(names):
                result.append({name.lower(): value for name, value in zip(names, row)})
        return result

    async def discover_tables(self, *, refresh: bool = False) -> list[dict[str, str]]:
        if self._table_cache is not None and not refresh:
            return self._table_cache
        payload = await self._request(
            "SELECT schema_name, table_name FROM TAP_SCHEMA.tables",
            phase="discover-tables",
        )
        tables = []
        for row in self._rows(payload):
            schema = self._safe_identifier(row.get("schema_name"))
            table = self._safe_identifier(row.get("table_name"))
            if schema and table:
                tables.append({"schema_name": schema, "table_name": table, "qualified_name": f"{schema}.{table}"})
        self._table_cache = tables
        logger.info("IRSA TAP_SCHEMA listed %d tables", len(tables))
        return tables

    async def discover_columns(self, schema_name: str, table_name: str) -> set[str]:
        schema = self._safe_identifier(schema_name)
        table = self._safe_identifier(table_name)
        if not schema or not table:
            raise ValueError("Invalid TAP schema or table identifier")
        qualified = f"{schema}.{table}"
        if qualified in self._column_cache:
            return self._column_cache[qualified]

        tables = await self.discover_tables()
        duplicate = sum(item["table_name"].lower() == table.lower() for item in tables) > 1
        # TAP_SCHEMA.columns uses table_name as the table identity. Query the qualified
        # identity first, then the unqualified table name only when TAP_SCHEMA confirms
        # it is unique or returns schema_name metadata we can filter separately.
        probes = [(qualified, True), (table, False)]
        rows: list[dict[str, Any]] = []
        for table_identity, is_qualified in probes:
            escaped = table_identity.replace("'", "''")
            payload = await self._request(
                "SELECT table_name, column_name FROM TAP_SCHEMA.columns "
                f"WHERE table_name = '{escaped}'",
                phase=f"discover-columns:{qualified}",
            )
            candidates = self._rows(payload)
            candidates = [row for row in candidates if str(row.get("table_name", "")).lower() in {
                table_identity.lower(), qualified.lower(), table.lower()
            }]
            if candidates:
                rows = candidates
                if is_qualified or not duplicate:
                    break
                # If only unqualified identities are returned while ambiguous, do not
                # accidentally attach another schema's columns to this candidate.
                if not any("schema_name" in row for row in candidates):
                    return set()
                rows = [row for row in candidates if str(row.get("schema_name", "")).lower() == schema.lower()]
                break
        columns = {column for row in rows if (column := self._safe_identifier(row.get("column_name")))}
        result = {column.lower() for column in columns}
        self._column_cache[qualified] = result
        logger.info("IRSA TAP_SCHEMA found %d columns for %s", len(result), qualified)
        return result

    async def discover_spherex_table(self) -> tuple[str, set[str]]:
        tables = await self.discover_tables()
        by_name = {item["qualified_name"].lower(): item for item in tables}
        candidates = ["spherex.obscore", "ivoa.obscore"]
        advertised = [name for name in candidates if name in by_name]
        if not advertised:
            raise IRSATableNotFoundError("IRSA TAP_SCHEMA does not advertise spherex.obscore or ivoa.obscore")
        for qualified in advertised:
            item = by_name[qualified]
            columns = await self.discover_columns(item["schema_name"], item["table_name"])
            if not {"s_ra", "s_dec"}.issubset(columns):
                logger.warning("IRSA candidate %s is missing verified s_ra/s_dec", qualified)
                continue
            if qualified == "ivoa.obscore" and "obs_collection" not in columns:
                logger.warning("Ignoring generic ivoa.obscore without obs_collection")
                continue
            return qualified, columns
        raise IRSAIncompatibleSchemaError("Published ObsCore tables do not expose verified SPHEREx-compatible coordinate columns")

    @staticmethod
    def build_spatial_query(table: str, columns: set[str], ra: float, dec: float, radius: float, limit: int) -> str:
        parts = table.split(".")
        safe_parts = [IRSAService._safe_identifier(part) for part in parts]
        if len(safe_parts) != 2 or any(part is None for part in safe_parts):
            raise ValueError("Invalid qualified TAP table identifier")
        selected = [column for column in IRSAService.OBSCORE_COLUMNS if column in columns]
        if not {"s_ra", "s_dec"}.issubset(selected):
            raise IRSAIncompatibleSchemaError("Required spatial columns are not available")
        predicates = [
            "CONTAINS(POINT('ICRS', s_ra, s_dec), "
            f"CIRCLE('ICRS', {ra:.8f}, {dec:.8f}, {radius:.8f})) = 1"
        ]
        if table.lower() == "ivoa.obscore":
            if "obs_collection" not in columns:
                raise IRSAIncompatibleSchemaError("ivoa.obscore lacks obs_collection; cannot isolate SPHEREx records")
            predicates.append("obs_collection LIKE '%SPHEREx%'")
        return f"SELECT TOP {int(limit)} {', '.join(selected)} FROM {'.'.join(safe_parts)} WHERE " + " AND ".join(predicates)

    async def query_observations(self, ra: float, dec: float, radius: float, limit: int | None = None) -> dict[str, Any]:
        if not 0 <= ra <= 360 or not -90 <= dec <= 90 or not 0 < radius <= 10:
            raise ValueError("Coordinates or radius are outside supported astronomical ranges")
        table, columns = await self.discover_spherex_table()
        result_limit = min(self.max_results, max(1, int(limit or self.max_results)))
        query = self.build_spatial_query(table, columns, ra, dec, radius, result_limit)
        records = self._rows(await self._request(query, phase="spatial-search"))
        return {"query_parameters": {"ra": ra, "dec": dec, "radius": radius, "limit": result_limit},
                "count": len(records), "source": "IRSA/IPAC TAP", "is_demo": False,
                "table": table, "observations": records}

    async def get_observation_detail(self, obs_id: str) -> dict[str, Any]:
        table, columns = await self.discover_spherex_table()
        id_column = "obs_id" if "obs_id" in columns else "obs_publisher_did" if "obs_publisher_did" in columns else None
        if not id_column:
            raise IRSAIncompatibleSchemaError("No verified observation identifier column is available")
        selected = [column for column in self.OBSCORE_COLUMNS if column in columns]
        escaped = obs_id.replace("'", "''")
        query = f"SELECT TOP 1 {', '.join(selected)} FROM {table} WHERE {id_column} = '{escaped}'"
        records = self._rows(await self._request(query, phase="observation-detail"))
        if not records:
            raise ObservationNotFoundError(obs_id)
        return {**records[0], "source": "IRSA/IPAC TAP", "is_demo": False, "table": table}

    async def list_qr2_directory(self, path: str = "", *, refresh: bool = False) -> dict[str, Any]:
        normalized = path.strip("/")
        if normalized and any(part in {".", ".."} or not re.fullmatch(r"[A-Za-z0-9._-]+", part) for part in normalized.split("/")):
            raise ValueError("Invalid archive directory path")
        url = self.BASE_QR2_LEVEL2 + (quote(normalized, safe="/") + "/" if normalized else "")
        if not refresh and normalized in self._directory_cache:
            cached_at, data = self._directory_cache[normalized]
            if asyncio.get_running_loop().time() - cached_at < 300:
                return data
        logger.info("IRSA QR2 listing path=%s", normalized or "/")
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.get(url)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("IRSA QR2 directory request failed path=%s: %s", normalized, exc)
            raise IRSAConnectionError("Could not retrieve the official IRSA QR2 Level 2 directory") from exc
        final_url = urlparse(str(response.url))
        root_path = urlparse(self.BASE_QR2_LEVEL2).path
        if final_url.scheme != "https" or final_url.hostname != "irsa.ipac.caltech.edu" or not final_url.path.startswith(root_path):
            raise IRSAConnectionError("IRSA directory redirected outside the official QR2 archive root")
        parser = _DirectoryParser()
        parser.feed(response.text)
        directories: list[dict[str, str]] = []
        files: list[dict[str, str]] = []
        for href, label in parser.links:
            href = html.unescape(href).strip()
            resolved = urljoin(str(response.url), href)
            parsed = urlparse(resolved)
            if parsed.scheme != "https" or parsed.hostname != "irsa.ipac.caltech.edu" or not parsed.path.startswith(root_path):
                continue
            filename = html.unescape(label or parsed.path.rstrip("/").split("/")[-1]).strip()
            if not filename or filename in {"Parent Directory", "Name", "Last modified", "Size", "Description"}:
                continue
            item_path = parsed.path[len(root_path):].strip("/")
            item = {"name": filename.rstrip("/"), "path": item_path, "url": resolved}
            if parsed.path.endswith("/") or href.endswith("/"):
                directories.append(item)
            elif filename.lower().endswith((".fits", ".fit", ".fts", ".fits.gz", ".fit.gz", ".fts.gz")):
                files.append(item)
        result = {"source": "IRSA IBE SPHEREx QR2 Level 2", "path": normalized, "url": str(response.url),
                  "directories": directories, "files": files,
                  "metadata_note": "Only names/URLs in the live IRSA directory listing are returned; FITS metadata is not inferred."}
        self._directory_cache[normalized] = (asyncio.get_running_loop().time(), result)
        return result
