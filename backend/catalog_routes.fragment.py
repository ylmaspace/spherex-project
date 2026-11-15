import asyncio
from typing import Any

from fastapi import HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from backend.services.catalog import CatalogError, IRSAFileCatalog

# Shared archive listing cache is per process and bounded to the requested directory.
file_catalog = IRSAFileCatalog()


@app.get("/api/catalog")
async def get_archive_catalog(
    path: str = "",
    q: str = "",
    detector: str = "",
    planning_period: str = "",
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=100),
    sort: str = "name",
):
    try:
        return await file_catalog.search(path=path, query=q, detector=detector,
                                         planning_period=planning_period, page=page,
                                         page_size=page_size, sort=sort)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except CatalogError as exc:
        logger.error("IRSA IBE catalog request failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/api/fits")
async def get_irsa_fits(path: str, request: Request):
    """Stream one selected archive product on demand; never mirror the archive."""
    try:
        response, chunks = await file_catalog.stream_fits(path, request.headers.get("range"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except CatalogError as exc:
        logger.error("IRSA FITS stream failed: %s", exc)
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        logger.exception("IRSA FITS transport error")
        raise HTTPException(status_code=502, detail="Could not retrieve FITS product from IRSA") from exc
    headers = {key: value for key, value in response.headers.items()
               if key.lower() in {"content-length", "content-range", "accept-ranges", "last-modified", "etag"}}
    headers["Content-Disposition"] = "inline"
    return StreamingResponse(chunks, status_code=response.status_code,
                             media_type=response.headers.get("content-type", "application/fits"),
                             headers=headers)
