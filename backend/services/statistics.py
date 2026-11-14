from sqlalchemy.orm import Session
from backend.models import User, AnswerLog


class StatisticsService:
    @staticmethod
    def get_aggregate_stats(db: Session) -> dict:
        users_count = db.query(User).count()
        total_answers = db.query(AnswerLog).count()
        correct_answers = db.query(AnswerLog).filter(AnswerLog.is_correct == 1).count()
        accuracy = round((correct_answers / total_answers) * 100.0, 1) if total_answers else 0.0
        return {
            "explorers_count": users_count,
            "total_questions_answered": total_answers,
            "total_discoveries": correct_answers,
            "average_accuracy": accuracy,
            "is_demo": False,
        }
