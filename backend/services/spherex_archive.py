from io import BytesIO
from typing import Any

import httpx
from astropy.io.votable import parse_single_table


class ArchiveQueryError(Exception):
    """Raised when IRSA SIA cannot return a usable archive response."""


class SPHERExArchiveService:
    """Search the public SPHEREx image collections through IRSA SIA2."""

    SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
    COLLECTIONS = {
        "spherex_dr1",
        "spherex_dr1_deep",
        "spherex_dr1_cube",
        "spherex_qr3",
        "spherex_qr3_deep",
    }
    RESULT_FIELDS = (
        "obs_id",
        "obs_title",
        "dataproduct_type",
        "instrument_name",
        "s_ra",
        "s_dec",
        "s_fov",
        "t_min",
        "t_max",
        "bandpass_id",
        "access_url",
        "access_format",
    )

    async def search(
        self,
        ra: float,
        dec: float,
        radius: float,
        collection: str = "spherex_qr3",
        limit: int = 50,
    ) -> dict[str, Any]:
        if collection not in self.COLLECTIONS:
            raise ValueError("Colección SPHEREx no válida.")

        params = {
            "COLLECTION": collection,
            "POS": f"circle {ra} {dec} {radius}",
            "MAXREC": limit,
        }
        headers = {"Accept": "application/x-votable+xml"}

        try:
            async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
                response = await client.get(self.SIA_URL, params=params, headers=headers)
                response.raise_for_status()
            table = parse_single_table(BytesIO(response.content)).to_table()
        except (httpx.HTTPError, Exception) as exc:
            raise ArchiveQueryError(f"No se pudo consultar el archivo IRSA: {exc}") from exc

        available = set(table.colnames)
        records = []
        for row in table:
            record = {}
            for field in self.RESULT_FIELDS:
                if field not in available:
                    continue
                value = row[field]
                if getattr(value, "mask", False):
                    continue
                if hasattr(value, "item"):
                    value = value.item()
                if isinstance(value, bytes):
                    value = value.decode("utf-8", errors="replace")
                if value is not None:
                    record[field] = value
            if record.get("access_url"):
                records.append(record)

        return {
            "collection": collection,
            "query": {"ra": ra, "dec": dec, "radius": radius},
            "count": len(records),
            "results": records,
        }
