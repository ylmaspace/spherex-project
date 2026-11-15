from pydantic import BaseModel, ConfigDict, Field
from typing import List, Optional


class UserCreate(BaseModel):
    user_id: Optional[str] = Field(default=None, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class UserResponse(BaseModel):
    id: str
    score: int
    accuracy: float
    questions_answered: int
    correct_answers: int
    incorrect_answers: int
    streak: int
    model_config = ConfigDict(from_attributes=True)


class AnswerSubmit(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    question_id: str = Field(min_length=1, max_length=128)
    selected_option: int = Field(ge=0, le=100)


class AnswerResponse(BaseModel):
    correct: bool
    explanation: str
    new_score: int
    new_accuracy: float
    streak: int


class ObservationQuery(BaseModel):
    ra: float = Field(..., ge=0, le=360, description="Right Ascension in decimal degrees")
    dec: float = Field(..., ge=-90, le=90, description="Declination in decimal degrees")
    radius: float = Field(0.5, gt=0, le=10, description="Search radius in decimal degrees")


class QuestionSchema(BaseModel):
    id: str
    question: str
    options: List[str]
    correct: int
    explanation: str
    model_config = ConfigDict(from_attributes=True)


class StatsResponse(BaseModel):
    explorers_count: int
    total_questions_answered: int
    total_discoveries: int
    average_accuracy: float
    is_demo: bool
