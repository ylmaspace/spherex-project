import json
import os
from typing import List, Dict, Any

class QuestionsService:
    def __init__(self):
        self.questions_path = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "../../data/questions.json")
        )

    def load_questions(self) -> List[Dict[str, Any]]:
        try:
            if os.path.exists(self.questions_path):
                with open(self.questions_path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except Exception:
            pass
        return [
            {
                "id": "q001",
                "question": "What changed between these two observations?",
                "options": [
                    "The object moved",
                    "The star disappeared",
                    "Nothing changed",
                    "The image was taken from Earth"
                ],
                "correct": 0,
                "explanation": "Objects with apparent motion can shift position between observations."
            }
        ]

    def get_question(self, q_id: str) -> Dict[str, Any]:
        questions = self.load_questions()
        for q in questions:
            if q["id"] == q_id:
                return q
        return questions[0]