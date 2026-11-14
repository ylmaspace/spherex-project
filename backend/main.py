import gzip
import io
import logging
import os
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

from fastapi import Body, Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend.database import Base, engine, get_db
from backend.models import AnswerLog, User
from backend.schemas import AnswerResponse, AnswerSubmit, StatsResponse, UserCreate, UserResponse
from backend.services.irsa import IRSAError, IRSAUnavailableError, ObservationNotFoundError
from backend.services.catalog import CatalogError, CatalogProductNotFoundError, IRSAFileCatalog
from backend.services.questions import QuestionsService
from backend.services.spherex import SPHERExService
from backend.services.statistics import StatisticsService
from backend.services.fits_processor import FITSProcessingError, MAX_UPLOAD_BYTES, get_display_path, get_preview_path, process_fits_upload

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())
logger = logging.getLogger(__name__)
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="YLMA SPHEREx Explorer API",
    description="Backend API for YLMA SPHEREx Explorer",
    version="1.1.0",
)

origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "").split(",") if origin.strip()]
if origins:
    app.add_middleware(
        CORSMiddleware, allow_origins=origins, allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["Content-Type"],
    )

# Lightweight per-process guard. Use a shared limiter (e.g. Redis-backed) for multi-instance deployments.
_rate_windows: dict[str, deque[float]] = defaultdict(deque)

@app.middleware("http")
async def request_rate_limit(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        client_ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window = _rate_windows[client_ip]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= 120:
            return JSONResponse(status_code=429, content={"detail": "Too many requests; retry in a minute."})
        window.append(now)
    return await call_next(request)

spherex_service = SPHERExService()
catalog_service = IRSAFileCatalog()
questions_service = QuestionsService()

@app.get("/api/health")
def health_check():
    return {"status": "healthy", "mission": "NASA Space Apps 2026", "project": "YLMA SPHEREx Explorer"}

@app.get("/api/config")
def get_config():
    return {
        "appName": "YLMA SPHEREx Explorer", "brand": "YLMA SPACE",
        "subtitle": "Explore how the sky changes over time.", "version": app.version,
        "demoModeActive": spherex_service.irsa.demo_mode,
        "irsaEndpoint": "https://irsa.ipac.caltech.edu/TAP/sync",
    }

@app.get("/api/observations")
async def get_observations(
    ra: float = Query(150.1, ge=0, le=360),
    dec: float = Query(2.2, ge=-90, le=90),
    radius: float = Query(0.5, gt=0, le=10),
    limit: int = Query(100, ge=1, le=500),
):
    try:
        return await spherex_service.search_sky(ra, dec, radius, limit)
    except IRSAError as exc:
        logger.warning("IRSA observations unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="IRSA SIA2 no está disponible o devolvió una respuesta incompatible. Inténtalo más tarde.") from exc

@app.get("/api/observation/{obs_id}")
async def get_observation_detail(obs_id: str):
    if not obs_id or len(obs_id) > 256:
        raise HTTPException(status_code=422, detail="Invalid observation identifier")
    try:
        return await spherex_service.get_observation(obs_id)
    except ObservationNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Observation not found") from exc
    except IRSAUnavailableError as exc:
        logger.warning("IRSA observation detail unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="El archivo IRSA no está disponible o no tiene un esquema compatible.") from exc

@app.get("/api/catalog")
async def get_catalog(
    path: str = Query("", max_length=512),
    query: str = Query("", max_length=200),
    detector: str = Query("", max_length=40),
    planning_period: str = Query("", max_length=80),
    date: str = Query("", max_length=40),
    band: str = Query("", max_length=40),
    page: int = Query(1, ge=1, le=100000),
    page_size: int = Query(50, ge=1, le=100),
    sort: str = Query("name", pattern="^(name|path|detector)$"),
):
    try:
        return await catalog_service.search(
            path=path, query=query, detector=detector,
            planning_period=planning_period, date=date, band=band,
            page=page, page_size=page_size, sort=sort,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CatalogError as exc:
        logger.warning("IRSA catalog unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="El directorio oficial de SPHEREx en IRSA no está disponible.") from exc


@app.post("/api/fits/import-directory")
async def import_fits_directory(payload: dict = Body(...)):
    """Download selected FITS files server-side from one official, browsable IRSA directory."""
    directory = payload.get("directory_path")
    files = payload.get("files")
    if not isinstance(directory, str) or not isinstance(files, list) or not files:
        raise HTTPException(status_code=422, detail="Indica un directorio IRSA y una lista de archivos FITS.")
    if len(files) > 16:
        raise HTTPException(status_code=413, detail="Importa como máximo 16 FITS por lote.")
    try:
        normalized_directory = catalog_service.normalize_path(directory)
        listed = await catalog_service.list_directory(normalized_directory)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CatalogError as exc:
        raise HTTPException(status_code=503, detail="No se pudo consultar el directorio oficial de IRSA.") from exc

    allowed = {entry.path: entry for entry in listed if entry.kind == "fits"}
    requested = []
    for item in files:
        if not isinstance(item, str) or item not in allowed:
            raise HTTPException(status_code=400, detail="La selección contiene un archivo que no pertenece a ese directorio IRSA.")
        if item in requested:
            continue
        requested.append(item)

    results, errors = [], []
    total_bytes = 0
    for relative_path in requested:
        entry = allowed[relative_path]
        filename = Path(entry.name).name
        if entry.size is not None and entry.size > MAX_UPLOAD_BYTES:
            errors.append({"filename": filename, "error": "Supera el límite de 120 MB por FITS."})
            continue
        try:
            upstream, chunks = await catalog_service.stream_fits(relative_path)
            content = bytearray()
            too_large = False
            async for chunk in chunks:
                if len(content) + len(chunk) > MAX_UPLOAD_BYTES or total_bytes + len(content) + len(chunk) > 600 * 1024 * 1024:
                    too_large = True
                    break
                content.extend(chunk)
            if too_large:
                close_chunks = getattr(chunks, "aclose", None)
                if close_chunks:
                    await close_chunks()
                errors.append({"filename": filename, "error": "Se ha superado el límite de 120 MB por archivo o 600 MB por lote."})
                continue
            total_bytes += len(content)
            fits_content = bytes(content)
            processing_filename = filename
            if filename.lower().endswith(".gz"):
                try:
                    with gzip.GzipFile(fileobj=io.BytesIO(fits_content), mode="rb") as compressed:
                        fits_content = compressed.read(MAX_UPLOAD_BYTES + 1)
                except (OSError, EOFError) as exc:
                    raise FITSProcessingError("El FITS comprimido no es un archivo GZIP válido.") from exc
                if len(fits_content) > MAX_UPLOAD_BYTES:
                    raise FITSProcessingError("El FITS descomprimido supera el límite de 120 MB.")
                processing_filename = filename[:-3]
            processed = process_fits_upload(processing_filename, fits_content)
            processed["filename"] = filename[:180]
            processed.pop("display_path", None)
            processed.pop("preview_path", None)
            processed["display_url"] = f"/api/fits/local/{processed['id']}"
            processed["preview_url"] = f"/api/fits/preview/{processed['id']}"
            results.append(processed)
            logger.info("IRSA directory FITS imported: path=%s id=%s size=%s", relative_path, processed["id"], len(content))
        except (CatalogError, FITSProcessingError, ValueError) as exc:
            logger.warning("IRSA directory FITS import failed: path=%s error=%s", relative_path, exc)
            errors.append({"filename": filename, "error": str(exc)})
        except Exception as exc:
            logger.exception("Unexpected IRSA directory FITS import failure: %s", relative_path)
            errors.append({"filename": filename, "error": "Error inesperado al descargar o procesar este FITS."})
    return {"directory": normalized_directory, "requested": len(requested), "imported": len(results),
            "results": results, "errors": errors, "bytes_downloaded": total_bytes}


@app.post("/api/fits/upload")
async def upload_local_fits(file: UploadFile = File(...)):
    """Inspect a local FITS, select the best 2D image HDU and extract its celestial WCS."""
    filename = Path(file.filename or "observation.fits").name
    logger.info("FITS upload received: filename=%s content_type=%s", filename, file.content_type)
    if not filename.lower().endswith((".fits", ".fit", ".fts")):
        await file.close()
        raise HTTPException(status_code=415, detail="Formato no admitido. Sube un FITS sin comprimir.")
    try:
        content = await file.read(MAX_UPLOAD_BYTES + 1)
    finally:
        await file.close()
    if len(content) > MAX_UPLOAD_BYTES:
        logger.warning("FITS upload rejected: filename=%s size_bytes=%s", filename, len(content))
        raise HTTPException(status_code=413, detail="El archivo supera el límite de 120 MB.")
    try:
        result = process_fits_upload(filename, content)
        result.pop("display_path", None)
        result.pop("preview_path", None)
        result["display_url"] = f"/api/fits/local/{result['id']}"
        result["preview_url"] = f"/api/fits/preview/{result['id']}"
        logger.info(
            "FITS upload processed: id=%s filename=%s dimensions=%sx%s hdu=%s ra=%s dec=%s",
            result["id"], filename, result["width"], result["height"],
            result["hdu_index"], result["ra"], result["dec"],
        )
        return result
    except FITSProcessingError as exc:
        logger.warning("FITS upload processing failed: filename=%s error=%s", filename, exc)
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/fits/preview/{upload_id}")
def get_local_fits_preview(upload_id: str):
    try:
        path = get_preview_path(upload_id)
    except FITSProcessingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, media_type="image/png", filename=f"{upload_id}-preview.png")


@app.get("/api/fits/local/{upload_id}")
def get_local_fits(upload_id: str):
    try:
        path = get_display_path(upload_id)
    except FITSProcessingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return FileResponse(path, media_type="application/fits", filename=f"{upload_id}.fits")


@app.get("/api/product")
async def get_sia2_product(request: Request, url: str = Query(..., min_length=1, max_length=2048)):
    """Proxy a FITS access_url returned by IRSA SIA2, preserving byte-range support."""
    try:
        range_header = request.headers.get("range") if request else None
        upstream, chunks = await catalog_service.stream_access_url(url, range_header)
        headers = {}
        for key in ("content-length", "content-range", "accept-ranges", "last-modified", "etag"):
            if key in upstream.headers:
                headers[key] = upstream.headers[key]
        headers["Cache-Control"] = "public, max-age=300"
        return StreamingResponse(
            chunks, status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type", "application/fits"),
            headers=headers,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CatalogError as exc:
        logger.warning("IRSA SIA2 FITS product unavailable: %s", exc)
        raise HTTPException(status_code=502, detail="No se pudo recuperar el producto FITS desde IRSA.") from exc


@app.get("/api/fits")
async def get_fits(request: Request, path: str = Query(..., min_length=1, max_length=1024)):
    try:
        range_header = request.headers.get("range") if request else None
        upstream, chunks = await catalog_service.stream_fits(path, range_header)
        headers = {}
        for key in ("content-length", "content-range", "accept-ranges", "last-modified", "etag"):
            if key in upstream.headers:
                headers[key] = upstream.headers[key]
        headers["Cache-Control"] = "public, max-age=300"
        media_type = upstream.headers.get("content-type", "application/fits")
        return StreamingResponse(chunks, status_code=upstream.status_code, media_type=media_type, headers=headers)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except CatalogProductNotFoundError as exc:
        raise HTTPException(status_code=404, detail="El producto FITS no aparece en el catálogo oficial de IRSA.") from exc
    except CatalogError as exc:
        logger.warning("IRSA FITS unavailable: %s", exc)
        raise HTTPException(status_code=503, detail="El producto FITS solicitado no está disponible en IRSA.") from exc


@app.get("/api/questions")
def get_questions():
    return questions_service.load_questions()

@app.post("/api/user", response_model=UserResponse)
def create_or_get_user(payload: UserCreate, db: Session = Depends(get_db)):
    user_id = payload.user_id or f"YLMA-USER-{uuid.uuid4().hex[:12].upper()}"
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        user = User(id=user_id, score=100, accuracy=0.0, questions_answered=0,
                    correct_answers=0, incorrect_answers=0, streak=0)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user

@app.get("/api/user/{user_id}/progress", response_model=UserResponse)
def get_user_progress(user_id: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@app.post("/api/answers", response_model=AnswerResponse)
def submit_answer(payload: AnswerSubmit, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == payload.user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    question = questions_service.get_question(payload.question_id)
    if question is None:
        raise HTTPException(status_code=404, detail="Question not found")
    if payload.selected_option < 0 or payload.selected_option >= len(question["options"]):
        raise HTTPException(status_code=422, detail="Selected option is out of range")
    is_correct = payload.selected_option == question["correct"]
    user.questions_answered += 1
    if is_correct:
        user.correct_answers += 1
        user.score += 150
        user.streak += 1
    else:
        user.incorrect_answers += 1
        user.streak = 0
    user.accuracy = round(user.correct_answers / user.questions_answered * 100.0, 1)
    db.add(AnswerLog(user_id=user.id, question_id=question["id"],
                     selected_option=payload.selected_option, is_correct=int(is_correct)))
    db.commit()
    db.refresh(user)
    return {"correct": is_correct, "explanation": question["explanation"],
            "new_score": user.score, "new_accuracy": user.accuracy, "streak": user.streak}

@app.get("/api/stats", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)):
    return StatisticsService.get_aggregate_stats(db)

# The same-origin frontend avoids hard-coded localhost URLs and production CORS requirements.
FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
