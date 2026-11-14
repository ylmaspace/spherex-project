"""Verified IRSA TAP client for SPHEREx ObsCore observations.

The service discovers tables and columns through TAP_SCHEMA at runtime and never
falls back to fabricated/demo observations.
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)
TAP_SYNC_URL = "https://irsa.ipac.caltech.edu/TAP/sync"


class IRSAError(RuntimeError):
    """Base error for IRSA archive operations."""


class IRSAConnectionError(IRSAError):
    """IRSA could not be reached or returned an unusable response."""


class IRSATAPQueryError(IRSAError):
    """IRSA rejected a TAP query."""


class IRSATableNotFoundError(IRSAError):
    """No supported SPHEREx ObsCore table was found."""


class IRSAIncompatibleSchemaError(IRSAError):
    """The discovered table does not expose the required ObsCore columns."""


class ObservationNotFoundError(IRSAError):
    """The requested observation identifier does not exist."""


class IRSAService:
    TABLE_CANDIDATES = (("spherex", "obscore"), ("ivoa", "obscore"))
    REQUIRED_COORDINATES = ("s_ra", "s_dec")

    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "20")))
        self.max_results = min(500, max(1, int(os.getenv("IRSA_MAX_RESULTS", "100"))))
        # Demo data is deliberately unsupported: the public API must never disguise it as science data.
        self.demo_mode = False
        self._table: tuple[str, str] | None = None
        self._columns: set[str] | None = None

    async def _tap(self, adql: str) -> list[dict[str, Any]]:
        payload = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": adql}
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.post(TAP_SYNC_URL, data=payload,
                    headers={"Accept": "application/json", "User-Agent": "YLMA-SPHEREx-Explorer/1.0"})
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            body = exc.response.text[:500]
            logger.warning("IRSA TAP HTTP %s: %s", exc.response.status_code, body)
            raise IRSATAPQueryError(f"IRSA TAP returned HTTP {exc.response.status_code}") from exc
        except httpx.HTTPError as exc:
            logger.warning("IRSA TAP connection failed: %s", exc)
            raise IRSAConnectionError("Could not connect to the official IRSA TAP service") from exc
        try:
            document = response.json()
        except ValueError as exc:
            raise IRSAConnectionError("IRSA TAP returned a non-JSON response") from exc
        if not isinstance(document, dict) or not isinstance(document.get("data"), list):
            raise IRSAConnectionError("IRSA TAP returned an unexpected response schema")
        fields = document.get("metadata") or []
        names = [str(field.get("name", "")) for field in fields if isinstance(field, dict)]
        rows = []
        for values in document["data"]:
            if isinstance(values, dict):
                rows.append(values)
            elif isinstance(values, list) and names and len(values) == len(names):
                rows.append(dict(zip(names, values)))
            else:
                raise IRSAConnectionError("IRSA TAP returned rows with an incompatible schema")
        return rows

    async def _discover_table(self) -> tuple[str, str, set[str]]:
        if self._table and self._columns:
            return self._table[0], self._table[1], self._columns
        rows = await self._tap(
            "SELECT schema_name, table_name FROM TAP_SCHEMA.tables "
            "WHERE LOWER(table_name) = 'obscore'"
        )
        available = {
            (str(row.get("schema_name", "")).lower(), str(row.get("table_name", "")).lower())
            for row in rows
        }
        for schema, table in self.TABLE_CANDIDATES:
            if (schema, table) not in available:
                continue
            column_rows = await self._tap(
                "SELECT column_name FROM TAP_SCHEMA.columns "
                f"WHERE LOWER(schema_name) = '{schema}' AND LOWER(table_name) = '{table}'"
            )
            columns = {str(row.get("column_name", "")).lower() for row in column_rows}
            if all(column in columns for column in self.REQUIRED_COORDINATES):
                self._table, self._columns = (schema, table), columns
                return schema, table, columns
        if not available:
            raise IRSATableNotFoundError("No ObsCore table was advertised by IRSA TAP_SCHEMA")
        raise IRSAIncompatibleSchemaError("IRSA ObsCore tables do not expose s_ra and s_dec")

    async def query_observations(self, ra: float, dec: float, radius: float,
                                 limit: int | None = None) -> dict[str, Any]:
        if not (0 <= float(ra) <= 360 and -90 <= float(dec) <= 90 and 0 < float(radius) <= 10):
            raise ValueError("RA, Dec or search radius is outside the supported range")
        schema, table, columns = await self._discover_table()
        safe_limit = min(self.max_results, max(1, int(limit or self.max_results)))
        selected = ["*"]
        where = (
            f"CONTAINS(POINT('ICRS', s_ra, s_dec), "
            f"CIRCLE('ICRS', {float(ra):.8f}, {float(dec):.8f}, {float(radius):.8f})) = 1"
        )
        adql = f"SELECT TOP {safe_limit} {', '.join(selected)} FROM {schema}.{table} WHERE {where}"
        if "t_min" in columns:
            adql += " ORDER BY t_min DESC"
        rows = await self._tap(adql)
        return {
            "source": f"IRSA TAP {schema}.{table}",
            "is_demo": False,
            "count": len(rows),
            "observations": rows,
            "query": {"ra": float(ra), "dec": float(dec), "radius": float(radius), "limit": safe_limit},
        }

    async def get_observation_detail(self, obs_id: str) -> dict[str, Any]:
        if not isinstance(obs_id, str) or not obs_id.strip() or len(obs_id) > 256:
            raise ValueError("Invalid observation identifier")
        schema, table, columns = await self._discover_table()
        identifier = "obs_id" if "obs_id" in columns else "obs_publisher_did" if "obs_publisher_did" in columns else None
        if identifier is None:
            raise IRSAIncompatibleSchemaError("The IRSA ObsCore table has no supported observation identifier")
        escaped = obs_id.strip().replace("'", "''")
        rows = await self._tap(f"SELECT TOP 1 * FROM {schema}.{table} WHERE {identifier} = '{escaped}'")
        if not rows:
            raise ObservationNotFoundError(f"Observation {obs_id} was not found")
        return {"source": f"IRSA TAP {schema}.{table}", "is_demo": False, "observation": rows[0]}


# Backwards-compatible name used by older API handlers.
IRSAUnavailableError = IRSAConnectionError
