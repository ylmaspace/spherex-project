import asyncio
import json
import logging
import os
import re
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class IRSAUnavailableError(RuntimeError):
    """The public IRSA TAP service or its schema could not be queried."""


class ObservationNotFoundError(LookupError):
    """No archive observation exists for the requested identifier."""


class IRSAService:
    """Discover and query the public IRSA TAP schema without guessing table names."""

    BASE_TAP_URL = "https://irsa.ipac.caltech.edu/TAP/sync"
    MAX_ATTEMPTS = 3

    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "20")))
        self.max_results = min(500, max(1, int(os.getenv("IRSA_MAX_RESULTS", "100"))))
        self.demo_mode = os.getenv("DEMO_MODE", "false").strip().lower() in {"1", "true", "yes"}
        self.demo_data_path = Path(__file__).resolve().parents[2] / "data" / "demo_data.json"

    async def _request(self, query: str) -> dict[str, Any]:
        params = {"REQUEST": "doQuery", "LANG": "ADQL", "FORMAT": "json", "QUERY": query}
        last_error: Exception | None = None
        for attempt in range(self.MAX_ATTEMPTS):
            try:
                async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                    response = await client.get(self.BASE_TAP_URL, params=params)
                    response.raise_for_status()
                    payload = response.json()
                    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                        raise ValueError("IRSA TAP returned an unexpected JSON response")
                    return payload
            except (httpx.HTTPError, ValueError, json.JSONDecodeError) as exc:
                last_error = exc
                logger.warning("IRSA TAP request failed (attempt %s/%s): %s", attempt + 1, self.MAX_ATTEMPTS, exc)
                if attempt + 1 < self.MAX_ATTEMPTS:
                    await asyncio.sleep(0.25 * (2**attempt))
        raise IRSAUnavailableError("IRSA TAP is unavailable or returned an unsupported response") from last_error

    async def _discover_table(self) -> tuple[str, set[str]]:
        try:
            tables_payload = await self._request(
                "SELECT schema_name, table_name FROM TAP_SCHEMA.tables"
            )
            table_rows = tables_payload["data"]
            available: list[str] = []
            for row in table_rows:
                if isinstance(row, dict):
                    schema, name = row.get("schema_name"), row.get("table_name")
                elif isinstance(row, list) and len(row) >= 2:
                    schema, name = row[0], row[1]
                else:
                    continue
                if schema and name and re.fullmatch(r"[A-Za-z0-9_]+", str(schema)) and re.fullmatch(r"[A-Za-z0-9_]+", str(name)):
                    available.append(f"{schema}.{name}")

            # Prefer standard ObsCore only when the live TAP schema advertises it.
            ordered = sorted(available, key=lambda value: ("obscore" not in value.lower(), value.lower()))
            for table in ordered:
                columns_payload = await self._request(
                    "SELECT column_name FROM TAP_SCHEMA.columns "
                    f"WHERE table_name = '{table}'"
                )
                columns: set[str] = set()
                for row in columns_payload["data"]:
                    value = row.get("column_name") if isinstance(row, dict) else row[0] if isinstance(row, list) and row else None
                    if value:
                        columns.add(str(value).lower())
                if {"s_ra", "s_dec"}.issubset(columns):
                    return table, columns
        except IRSAUnavailableError:
            raise
        except Exception as exc:
            logger.exception("Could not discover a usable SPHEREx TAP table")
            raise IRSAUnavailableError("Could not inspect IRSA TAP_SCHEMA") from exc
        raise IRSAUnavailableError("IRSA TAP_SCHEMA has no table with verified s_ra/s_dec columns")

    @staticmethod
    def _row_dicts(payload: dict[str, Any]) -> list[dict[str, Any]]:
        rows = payload.get("data", [])
        fields = payload.get("fields", [])
        names = [str(field.get("name", "")) for field in fields if isinstance(field, dict)]
        result: list[dict[str, Any]] = []
        for row in rows:
            if isinstance(row, dict):
                result.append(row)
            elif isinstance(row, list) and names and len(row) == len(names):
                result.append(dict(zip(names, row)))
        return result

    async def query_observations(self, ra: float, dec: float, radius: float, limit: int | None = None) -> dict[str, Any]:
        if self.demo_mode:
            return self._demo_observations(ra, dec, radius)
        table, columns = await self._discover_table()
        selected = [name for name in (
            "obs_id", "dataproduct_type", "calib_level", "target_name", "s_ra", "s_dec",
            "em_min", "em_max", "t_min", "t_max", "access_url", "obs_publisher_did", "facility_name"
        ) if name in columns]
        if "s_ra" not in selected or "s_dec" not in selected:
            raise IRSAUnavailableError("Discovered TAP table lacks required coordinate columns")
        result_limit = min(self.max_results, max(1, int(limit or self.max_results)))
        adql = (
            f"SELECT TOP {result_limit} {', '.join(selected)} FROM {table} "
            "WHERE CONTAINS(POINT('ICRS', s_ra, s_dec), "
            f"CIRCLE('ICRS', {ra:.8f}, {dec:.8f}, {radius:.8f})) = 1"
        )
        records = self._row_dicts(await self._request(adql))
        return {
            "query_parameters": {"ra": ra, "dec": dec, "radius": radius, "limit": result_limit},
            "count": len(records), "source": "IRSA/IPAC TAP", "is_demo": False,
            "table": table, "observations": records,
        }

    async def get_observation_detail(self, obs_id: str) -> dict[str, Any]:
        if self.demo_mode:
            for observation in self._load_demo_data():
                if observation.get("id") == obs_id:
                    return {**observation, "source": "local demonstration data", "is_demo": True}
            raise ObservationNotFoundError(obs_id)
        table, columns = await self._discover_table()
        id_column = next((name for name in ("obs_id", "obs_publisher_did") if name in columns), None)
        if not id_column:
            raise IRSAUnavailableError("Discovered TAP table has no supported observation identifier")
        escaped_id = obs_id.replace("'", "''")
        selected = [name for name in columns if re.fullmatch(r"[a-z][a-z0-9_]*", name)]
        adql = f"SELECT TOP 1 {', '.join(selected)} FROM {table} WHERE {id_column} = '{escaped_id}'"
        records = self._row_dicts(await self._request(adql))
        if not records:
            raise ObservationNotFoundError(obs_id)
        return {**records[0], "source": "IRSA/IPAC TAP", "is_demo": False, "table": table}

    def _load_demo_data(self) -> list[dict[str, Any]]:
        try:
            with self.demo_data_path.open(encoding="utf-8") as file:
                payload = json.load(file)
            return payload.get("observations", [])
        except (OSError, ValueError, TypeError):
            logger.exception("Could not load explicitly enabled demo observations")
            return []

    def _demo_observations(self, ra: float, dec: float, radius: float) -> dict[str, Any]:
        # Do not rewrite static demo coordinates to imply a match at the requested sky position.
        observations = self._load_demo_data()
        return {
            "query_parameters": {"ra": ra, "dec": dec, "radius": radius},
            "count": len(observations), "source": "local demonstration data (not scientific observations)",
            "is_demo": True, "observations": observations,
        }
