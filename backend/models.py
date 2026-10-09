import uuid
from datetime import datetime
from sqlalchemy import Column, String, Integer, Float, DateTime, Text
from backend.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    score = Column(Integer, default=0)
    accuracy = Column(Float, default=0.0)
    questions_answered = Column(Integer, default=0)
    correct_answers = Column(Integer, default=0)
    incorrect_answers = Column(Integer, default=0)
    streak = Column(Integer, default=0)

class QuestionModel(Base):
    __tablename__ = "questions"

    id = Column(String, primary_key=True, index=True)
    question_text = Column(Text, nullable=False)
    options_json = Column(Text, nullable=False) # Stored as JSON string
    correct_index = Column(Integer, nullable=False)
    explanation = Column(Text, nullable=False)

class AnswerLog(Base):
    __tablename__ = "answers"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)
    user_id = Column(String, index=True, nullable=False)
    question_id = Column(String, index=True, nullable=False)
    selected_option = Column(Integer, nullable=False)
    is_correct = Column(Integer, nullable=False) # 1 or 0
    answered_at = Column(DateTime, default=datetime.utcnow)

class SessionLog(Base):
    __tablename__ = "sessions"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = Column(String, index=True, nullable=False)
    action = Column(String, nullable=False)
    details = Column(Text, nullable=True)
    timestamp = Column(DateTime, default=datetime.utcnow)