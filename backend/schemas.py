from typing import List, Optional, Any
from pydantic import BaseModel, Field

class UserCreate(BaseModel):
    user_id: Optional[str] = None

class UserResponse(BaseModel):
    id: str
    score: int
    accuracy: float
    questions_answered: int
    correct_answers: int
    incorrect_answers: int
    streak: int

    class Config:
        from_attributes = True

class AnswerSubmit(BaseModel):
    user_id: str
    question_id: str
    selected_option: int

class AnswerResponse(BaseModel):
    correct: bool
    explanation: str
    new_score: int
    new_accuracy: float
    streak: int

class ObservationQuery(BaseModel):
    ra: float = Field(..., description="Right Ascension in decimal degrees")
    dec: float = Field(..., description="Declination in decimal degrees")
    radius: float = Field(0.5, description="Search radius in decimal degrees")

class QuestionSchema(BaseModel):
    id: str
    question: str
    options: List[str]
    correct: int
    explanation: str

    class Config:
        from_attributes = True

class StatsResponse(BaseModel):
    explorers_count: int
    total_questions_answered: int
    total_discoveries: int
    average_accuracy: float
    is_demo: bool