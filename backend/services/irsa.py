"""SPHEREx image search using IRSA's current Simple Image Access v2 service."""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)
SIA_URL = "https://irsa.ipac.caltech.edu/SIA"


class IRSAError(RuntimeError):
    """Base error for IRSA archive operations."""


class IRSAConnectionError(IRSAError):
    """IRSA could not be reached or returned an unusable response."""


class IRSATAPQueryError(IRSAError):
    """IRSA rejected a query."""


class IRSATableNotFoundError(IRSAError):
    """Kept for backwards compatibility with older callers."""


class IRSAIncompatibleSchemaError(IRSAError):
    """IRSA returned an unsupported result schema."""


class ObservationNotFoundError(IRSAError):
    """The requested observation identifier does not exist."""


class IRSAService:
    # QR2 is deliberately excluded: IRSA retired QR2 from searchable services in Nov 2026.
    COLLECTIONS = (
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_qr3",
        "spherex_qr3_deep",
    )

    def __init__(self) -> None:
        self.timeout = max(3.0, float(os.getenv("IRSA_TIMEOUT_SECONDS", "25")))
        self.max_results = min(500, max(1, int(os.getenv("IRSA_MAX_RESULTS", "100"))))
        self.demo_mode = False

    async def _query_collection(self, collection: str, ra: float, dec: float,
                                radius: float, limit: int) -> list[dict[str, Any]]:
        params = {
            "COLLECTION": collection,
            "POS": f"circle {ra:.8f} {dec:.8f} {radius:.8f}",
            "RESPONSEFORMAT": "JSON",
            "MAXREC": str(limit),
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.get(
                    SIA_URL, params=params,
                    headers={"Accept": "application/json", "User-Agent": "YLMA-SPHEREx-Explorer/2.0"},
                )
                response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            logger.warning("IRSA SIA2 HTTP %s for %s: %s",
                           exc.response.status_code, collection, exc.response.text[:400])
            raise IRSATAPQueryError(
                f"IRSA SIA2 returned HTTP {exc.response.status_code} for {collection}"
            ) from exc
        except httpx.HTTPError as exc:
            logger.warning("IRSA SIA2 connection failed for %s: %s", collection, exc)
            raise IRSAConnectionError("Could not connect to the official IRSA SIA2 service") from exc

        try:
            document = response.json()
        except ValueError as exc:
            raise IRSAIncompatibleSchemaError("IRSA SIA2 returned a non-JSON response") from exc

        if isinstance(document, list):
            return [row for row in document if isinstance(row, dict)]
        if not isinstance(document, dict):
            raise IRSAIncompatibleSchemaError("IRSA SIA2 returned an unsupported JSON structure")

        # IRSA JSON tables normally expose metadata + row arrays; accept object rows too.
        rows = document.get("data")
        if rows is None and isinstance(document.get("results"), list):
            rows = document["results"]
        if not isinstance(rows, list):
            if document.get("status") == "OK" and not rows:
                return []
            raise IRSAIncompatibleSchemaError("IRSA SIA2 response has no tabular data")

        if not rows:
            return []
        if all(isinstance(row, dict) for row in rows):
            return rows

        metadata = document.get("metadata") or document.get("fields") or []
        names = []
        for field in metadata:
            if isinstance(field, dict):
                names.append(str(field.get("name") or field.get("column_name") or ""))
            elif isinstance(field, str):
                names.append(field)
        if not names or any(not isinstance(row, list) or len(row) != len(names) for row in rows):
            raise IRSAIncompatibleSchemaError("IRSA SIA2 returned rows with incompatible metadata")
        return [dict(zip(names, row)) for row in rows]

    async def query_observations(self, ra: float, dec: float, radius: float,
                                 limit: int | None = None) -> dict[str, Any]:
        ra, dec, radius = float(ra), float(dec), float(radius)
        if not (0 <= ra <= 360 and -90 <= dec <= 90 and 0 < radius <= 10):
            raise ValueError("RA, Dec or search radius is outside the supported range")
        safe_limit = min(self.max_results, max(1, int(limit or self.max_results)))
        # Search each current public collection independently so one unavailable
        # collection cannot hide results from the others.
        import asyncio
        results = await asyncio.gather(
            *(self._query_collection(collection, ra, dec, radius, safe_limit)
              for collection in self.COLLECTIONS),
            return_exceptions=True,
        )
        observations: list[dict[str, Any]] = []
        failures: list[BaseException] = []
        for collection, result in zip(self.COLLECTIONS, results):
            if isinstance(result, BaseException):
                failures.append(result)
                continue
            for row in result:
                normalized = {str(key).lower(): value for key, value in row.items()}
                normalized.setdefault("collection", collection)
                # The frontend uses these standard ObsCore-like display fields.
                if normalized.get("obs_id") is None:
                    normalized["obs_id"] = normalized.get("obs_publisher_did") or normalized.get("obs_title")
                observations.append(normalized)

        if failures and not observations:
            first = failures[0]
            if isinstance(first, IRSAError):
                raise first
            raise IRSAConnectionError("All IRSA SIA2 collection queries failed") from first

        # Deduplicate by the stable archive URL / publisher identifier.
        unique: dict[str, dict[str, Any]] = {}
        for index, row in enumerate(observations):
            key = str(row.get("access_url") or row.get("obs_publisher_did") or row.get("obs_id") or index)
            unique[key] = row
        ordered = list(unique.values())
        ordered.sort(key=lambda row: float(row.get("t_min") or 0), reverse=True)
        ordered = ordered[:safe_limit]
        return {
            "source": "IRSA SIA2 — SPHEREx DR1 + QR3",
            "is_demo": False,
            "count": len(ordered),
            "observations": ordered,
            "query": {"ra": ra, "dec": dec, "radius": radius, "limit": safe_limit,
                      "collections": list(self.COLLECTIONS)},
            "warnings": [str(error) for error in failures] if failures else [],
        }

    async def get_observation_detail(self, obs_id: str) -> dict[str, Any]:
        if not isinstance(obs_id, str) or not obs_id.strip() or len(obs_id) > 256:
            raise ValueError("Invalid observation identifier")
        raise ObservationNotFoundError(
            "Direct detail lookup is not exposed by SIA2; search by sky position instead."
        )


# Backwards-compatible name used by older API handlers.
IRSAUnavailableError = IRSAConnectionError
