import uuid
from fastapi import FastAPI, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from backend.database import engine, Base, get_db
from backend.models import User, AnswerLog, SessionLog
from backend.schemas import (
    UserCreate, UserResponse, AnswerSubmit, AnswerResponse,
    ObservationQuery, StatsResponse
)
from backend.services.spherex import SPHERExService
from backend.services.questions import QuestionsService
from backend.services.statistics import StatisticsService

# Create database tables
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="YLMA SPHEREx Explorer API",
    description="Official backend API for YLMA SPHEREx Explorer - NASA Space Apps Challenge 2026",
    version="1.0.0"
)

# Enable CORS for frontend integration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

spherex_service = SPHERExService()
questions_service = QuestionsService()

@app.get("/api/health")
def health_check():
    return {"status": "healthy", "mission": "NASA Space Apps 2026", "project": "YLMA SPHEREx Explorer"}

@app.get("/api/config")
def get_config():
    return {
        "appName": "YLMA SPHEREx Explorer",
        "brand": "YLMA SPACE",
        "subtitle": "Explore how the sky changes over time.",
        "version": "1.0.0",
        "demoModeActive": True,
        "irsaEndpoint": "https://irsa.ipac.caltech.edu/Missions/spherex.html"
    }

@app.get("/api/observations")
async def get_observations(ra: float = 150.1, dec: float = 2.2, radius: float = 0.5):
    try:
        data = await spherex_service.search_sky(ra, dec, radius)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch observations: {str(e)}")

@app.get("/api/observation/{obs_id}")
async def get_observation_detail(obs_id: str):
    try:
        detail = await spherex_service.get_observation(obs_id)
        return detail
    except Exception as e:
        raise HTTPException(status_code=404, detail=f"Observation not found: {str(e)}")

@app.get("/api/questions")
def get_questions():
    return questions_service.load_questions()

@app.post("/api/user", response_model=UserResponse)
def create_or_get_user(payload: UserCreate, db: Session = Depends(get_db)):
    user_id = payload.user_id
    if not user_id:
        user_id = f"YLMA-USER-{uuid.uuid4().hex[:6].upper()}"
    
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        user = User(
            id=user_id,
            score=100, # Initial welcome bonus XP
            accuracy=100.0,
            questions_answered=0,
            correct_answers=0,
            incorrect_answers=0,
            streak=1
        )
        db.add(user)
        db.commit()
        db.refresh(user)

    return user

@app.get("/api/user/{user_id}/progress", response_model=UserResponse)
def get_user_progress(user_id: str, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return user

@app.post("/api/answers", response_model=AnswerResponse)
def submit_answer(payload: AnswerSubmit, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.id == payload.user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    question = questions_service.get_question(payload.question_id)
    is_correct = (payload.selected_option == question["correct"])

    # Update user statistics
    user.questions_answered += 1
    if is_correct:
        user.correct_answers += 1
        user.score += 150
        user.streak += 1
    else:
        user.incorrect_answers += 1
        user.streak = 0

    if user.questions_answered > 0:
        user.accuracy = round((user.correct_answers / user.questions_answered) * 100.0, 1)

    # Log answer
    answer_log = AnswerLog(
        user_id=user.id,
        question_id=question["id"],
        selected_option=payload.selected_option,
        is_correct=1 if is_correct else 0
    )
    db.add(answer_log)
    db.commit()
    db.refresh(user)

    return {
        "correct": is_correct,
        "explanation": question["explanation"],
        "new_score": user.score,
        "new_accuracy": user.accuracy,
        "streak": user.streak
    }

@app.get("/api/stats", response_model=StatsResponse)
def get_stats(db: Session = Depends(get_db)):
    stats = StatisticsService.get_aggregate_stats(db)
    return stats