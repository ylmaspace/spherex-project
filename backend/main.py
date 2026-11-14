import logging
import os
import time
import uuid
from collections import defaultdict, deque
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from backend.database import Base, engine, get_db
from backend.models import AnswerLog, User
from backend.schemas import AnswerResponse, AnswerSubmit, StatsResponse, UserCreate, UserResponse
from backend.services.irsa import IRSAError, IRSAUnavailableError, ObservationNotFoundError
from backend.services.catalog import CatalogError, IRSAFileCatalog
from backend.services.questions import QuestionsService
from backend.services.spherex import SPHERExService
from backend.services.statistics import StatisticsService

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
        raise HTTPException(status_code=503, detail="El archivo IRSA no está disponible o no tiene un esquema compatible. Inténtalo más tarde.") from exc

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
        raise HTTPException(status_code=503, detail="El catálogo QR2 Level 2 de IRSA no está disponible.") from exc


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
