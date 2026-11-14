"""IRSA TAP integration for real SPHEREx ObsCore metadata.

No local demonstration data is returned by this service. TAP schemas and columns are
queried at runtime because the public archive schema can change.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class IRSAError(RuntimeError):
    """Base class for errors returned by the IRSA integration."""


class IRSAConnectionError(IRSAError):
    """IRSA could not be reached or returned a non-success HTTP status."""


class IRSATAPQueryError(IRSAError):
    """IRSA returned a TAP/ADQL error or an invalid TAP payload."""


class IRSATableNotFoundError(IRSAError):
    """No advertised SPHEREx ObsCore table was found."""


class IRSAIncompatibleSchemaError(IRSAError):
    """The discovered table does not expose required spatial/identity columns."""


class ObservationNotFoundError(LookupError):
    """An observation identifier did not match a live IRSA record."""


class IRSAService:
    BASE_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
    MAX_ATTEMPTS = 3
    IDENTIFIER = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
    OPTIONAL_OBSCORE_COLUMNS = (
        "obs_id", "obs_publisher_did", "dataproduct_type", "calib_level",
        "obs_collection", "obs_title", "target_name", "s_ra", "s_dec",
        "s_fov", "s_region", "em_min", "em_max", "t_min", "t_max",
        "access_url", "access_format", "facility_name", "instrument_name",
    )

    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "20")))
        self.max_results = min(500, max(1, int(os.getenv("IRSA_MAX_RESULTS", "100"))))
        # DEMO_MODE is intentionally not used as a fallback. This service returns IRSA data only.
        self._schema_cache: dict[str, Any] | None = None

    @staticmethod
    def _format_tap_error(payload: Any) -> str | None:
        if not isinstance(payload, dict):
            return None
        error = payload.get("error") or payload.get("ERROR")
        if error:
            return str(error)[:1000]
        for item in payload.get("metadata", []) if isinstance(payload.get("metadata"), list) else []:
            if isinstance(item, dict) and str(item.get("name", "")).upper() == "QUERY_STATUS":
                value = str(item.get("value") or item.get("description") or "")
                if value.upper().startswith("ERROR"):
                    return value[:1000]
        return None

    async def _request(self, query: str, *, phase: str) -> dict[str, Any]:
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": query}
        last_error: Exception | None = None
        for attempt in range(self.MAX_ATTEMPTS):
            logger.info("IRSA TAP phase=%s attempt=%s query=%s", phase, attempt + 1, query)
            try:
                async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                    response = await client.get(self.BASE_TAP_URL, params=params)
            except httpx.HTTPError as exc:
                last_error = exc
                logger.warning("IRSA TAP connection failed phase=%s attempt=%d: %s", phase, attempt + 1, exc)
                if attempt + 1 < self.MAX_ATTEMPTS:
                    await asyncio.sleep(0.2 * (2**attempt))
                    continue
                raise IRSAConnectionError(f"Unable to connect to IRSA TAP during {phase}") from exc

            if not response.is_success:
                message = response.text[:1000].replace("\n", " ")
                logger.error("IRSA TAP HTTP error phase=%s status=%d body=%s", phase, response.status_code, message)
                if response.status_code >= 500 and attempt + 1 < self.MAX_ATTEMPTS:
                    await asyncio.sleep(0.2 * (2**attempt))
                    continue
                if response.status_code in (400, 422) or any(term in message.lower() for term in ("adql", "table", "column", "syntax")):
                    raise IRSATAPQueryError(f"IRSA rejected {phase} (HTTP {response.status_code}): {message}")
                raise IRSAConnectionError(f"IRSA returned HTTP {response.status_code} during {phase}")
            try:
                payload = response.json()
            except (ValueError, json.JSONDecodeError) as exc:
                raise IRSATAPQueryError(f"IRSA returned non-JSON data during {phase}") from exc
            if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                raise IRSATAPQueryError(f"IRSA returned an unexpected TAP JSON structure during {phase}")
            tap_error = self._format_tap_error(payload)
            if tap_error:
                logger.error("IRSA TAP query failure phase=%s error=%s", phase, tap_error)
                raise IRSATAPQueryError(f"IRSA TAP error during {phase}: {tap_error}")
            return payload
        raise IRSAConnectionError(f"Unable to connect to IRSA TAP during {phase}") from last_error

    @staticmethod
    def _rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
        """Normalize TAP JSON array rows or named object rows using response metadata."""
        data = payload.get("data", [])
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
        for row in data:
            if isinstance(row, dict):
                result.append({str(key).lower(): value for key, value in row.items()})
            elif isinstance(row, (list, tuple)) and names and len(row) == len(names):
                result.append({name.lower(): value for name, value in zip(names, row)})
        return result

    @staticmethod
    def _safe_identifier(value: Any) -> str | None:
        text = str(value or "").strip()
        return text if IRSAService.IDENTIFIER.fullmatch(text) else None

    async def discover_tables(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        if self._schema_cache is not None and not refresh:
            return self._schema_cache["tables"]
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
        self._schema_cache = {"tables": tables}
        logger.info("IRSA TAP_SCHEMA listed %d tables", len(tables))
        return tables

    async def discover_columns(self, schema_name: str, table_name: str) -> set[str]:
        schema = self._safe_identifier(schema_name)
        table = self._safe_identifier(table_name)
        if not schema or not table:
            raise ValueError("Invalid TAP schema or table identifier")

        # TAP_SCHEMA.tables supplies schema and table separately. In columns, table_name
        # is queried unqualified; if schema_name is also exposed, filter it independently.
        payload = await self._request(
            "SELECT * FROM TAP_SCHEMA.columns "
            f"WHERE table_name = '{table}'",
            phase=f"discover-columns:{schema}.{table}",
        )
        rows = self._rows(payload)
        columns_table_has_schema = any("schema_name" in row for row in rows)
        columns: set[str] = set()
        for row in rows:
            row_schema = row.get("schema_name")
            row_table = str(row.get("table_name") or "").strip()
            if row_schema is not None and str(row_schema).lower() != schema.lower():
                continue
            # Some TAP implementations expose qualified table_name in TAP_SCHEMA.columns.
            if row_table and row_table.lower() not in {table.lower(), f"{schema}.{table}".lower()}:
                continue
            column = self._safe_identifier(row.get("column_name"))
            if column:
                columns.add(column.lower())

        # If schema is absent from columns metadata and the TAP has duplicate table names,
        # refusing to guess is safer than associating another schema's columns.
        duplicate_name = sum(1 for item in await self.discover_tables() if item["table_name"].lower() == table.lower()) > 1
        if duplicate_name and not columns_table_has_schema:
            logger.warning("IRSA TAP columns metadata has no schema_name for ambiguous table=%s", table)
            return set()
        logger.info("IRSA TAP_SCHEMA found %d columns for %s.%s", len(columns), schema, table)
        return columns

    async def discover_sphex_table(self) -> tuple[str, set[str]]:
        tables = await self.discover_tables()
        by_name = {item["qualified_name"].lower(): item for item in tables}
        candidates = ["spherex.obscore", "ivoa.obscore"]
        advertised = [name for name in candidates if name in by_name]
        if not advertised:
            raise IRSATableNotFoundError("IRSA TAP_SCHEMA does not advertise spherex.obscore or ivoa.obscore")

        for qualified in advertised:
            item = by_name[qualified]
            columns = await self.discover_columns(item["schema_name"], item["table_name"])
            required = {"s_ra", "s_dec"}
            if not required.issubset(columns):
                logger.warning("IRSA table %s is missing required coordinates columns", qualified)
                continue
            # ivoa.obscore is generic. Only accept it when the live schema has a way to
            # identify the SPHEREx collection and constrain the subsequent ADQL query.
            if qualified == "ivoa.obscore" and "obs_collection" not in columns:
                logger.warning("Ignoring generic ivoa.obscore without obs_collection")
                continue
            return qualified, columns
        raise IRSAIncompatibleSchemaError("Advertised ObsCore tables lack verified SPHEREx-compatible coordinate/collection columns")

    @staticmethod
    def build_spatial_query(table: str, columns: set[str], ra: float, dec: float, radius: float, limit: int) -> str:
        safe_table = ".".join(IRSAService._safe_identifier(part) or "" for part in table.split("."))
        if not safe_table or ".." in safe_table:
            raise ValueError("Invalid table identifier")
        selected = [column for column in IRSAService.OPTIONAL_OBSCORE_COLUMNS if column in columns]
        if not {"s_ra", "s_dec"}.issubset(selected):
            raise IRSAIncompatibleSchemaError("No verified s_ra/s_dec columns are available")
        predicates = [
            "CONTAINS(POINT('ICRS', s_ra, s_dec), "
            f"CIRCLE('ICRS', {ra:.8f}, {dec:.8f}, {radius:.8f})) = 1"
        ]
        if table.lower() == "ivoa.obscore":
            predicates.append("obs_collection LIKE '%SPHEREx%'")
        return f"SELECT TOP {limit} {', '.join(selected)} FROM {safe_table} WHERE " + " AND ".join(predicates)

    async def query_observations(self, ra: float, dec: float, radius: float, limit: int | None = None) -> dict[str, Any]:
        if not 0 <= ra <= 360 or not -90 <= dec <= 90 or not 0 < radius <= 10:
            raise ValueError("Coordinates or radius are outside supported astronomical ranges")
        table, columns = await self.discover_sphex_table()
        max_rows = min(self.max_results, max(1, int(limit or self.max_results)))
        query = self.build_spatial_query(table, columns, ra, dec, radius, max_rows)
        rows = self._rows(await self._request(query, phase="spatial-search"))
        return {
            "query_parameters": {"ra": ra, "dec": dec, "radius": radius, "limit": max_rows},
            "count": len(rows), "source": "IRSA/IPAC TAP", "is_demo": False,
            "table": table, "observations": rows,
        }

    async def get_observation_detail(self, obs_id: str) -> dict[str, Any]:
        table, columns = await self.discover_sphex_table()
        id_column = "obs_id" if "obs_id" in columns else "obs_publisher_did" if "obs_publisher_did" in columns else None
        if id_column is None:
            raise IRSAIncompatibleSchemaError("The discovered table has no verified observation identifier")
        selected = [column for column in self.OPTIONAL_OBSCORE_COLUMNS if column in columns]
        escaped = obs_id.replace("'", "''")
        query = f"SELECT TOP 1 {', '.join(selected)} FROM {table} WHERE {id_column} = '{escaped}'"
        rows = self._rows(await self._request(query, phase="observation-detail"))
        if not rows:
            raise ObservationNotFoundError(obs_id)
        return {**rows[0], "source": "IRSA/IPAC TAP", "is_demo": False, "table": table}

    async def list_qr2_directory(self, path: str = "", *, refresh: bool = False) -> dict[str, Any]:
        """Fetch only one live QR2 Level 2 directory listing; never crawl/download recursively."""
        normalized = path.strip("/")
        if normalized and any(part in {".", ".."} for part in normalized.split("/")):
            raise ValueError("Invalid archive directory path")
        base_url = self.BASE_QR2_LEVEL2
        url = base_url + normalized + ("/" if normalized else "")
        if not url.startswith(base_url):
            raise ValueError("Directory path is outside the official IRSA QR2 Level 2 root")
        if not refresh and normalized in self._directory_cache:
            return self._directory_cache[normalized]
        logger.info("Fetching IRSA QR2 Level 2 directory %s", normalized or "/")
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.get(url)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise IRSAConnectionError(f"Could not retrieve IRSA IBE directory {normalized or '/'}") from exc
        if urlparse(str(response.url)).hostname != "irsa.ipac.caltech.edu":
            raise IRSAConnectionError("IRSA directory redirected outside the official archive host")
        parser = _DirectoryHTMLParser()
        parser.feed(response.text)
        directories: list[dict[str, Any]] = []
        files: list[dict[str, Any]] = []
        for item in parser.items:
            entry_url = urljoin(str(response.url), item["href"])
            parsed = urlparse(entry_url)
            if parsed.scheme != "https" or parsed.hostname != "irsa.ipac.caltech.edu" or not parsed.path.startswith(urlparse(base_url).path):
                continue
            entry = {"name": item["name"], "url": entry_url, "path": parsed.path[len(urlparse(base_url).path):].strip("/")}
            if item["is_dir"]:
                directories.append(entry)
            elif item["name"].lower().endswith((".fits", ".fit", ".fts", ".fits.gz", ".fit.gz", ".fts.gz")):
                files.append(entry)
        result = {"source": "IRSA IBE SPHEREx QR2 Level 2", "path": normalized,
                  "url": str(response.url), "directories": directories, "files": files,
                  "metadata_note": "Only names and URLs available in the live directory response are included; FITS metadata is not inferred."}
        self._directory_cache[normalized] = result
        return result


class IRSATableNotFoundError(IRSAError):
    """No advertised SPHEREx ObsCore table was found."""


class IRSAIncompatibleSchemaError(IRSAError):
    """The discovered table does not expose required coordinate/identifier fields."""
