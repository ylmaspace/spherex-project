from typing import Dict, Any, List
from backend.services.irsa import IRSAService

class SPHERExService:
    def __init__(self):
        self.irsa = IRSAService()

    async def search_sky(self, ra: float, dec: float, radius: float) -> Dict[str, Any]:
        observations = await self.irsa.query_observations(ra, dec, radius)
        return {
            "query_parameters": {
                "ra": ra,
                "dec": dec,
                "radius": radius
            },
            "count": len(observations),
            "source": "NASA IRSA SPHEREx Public Archive (with DEMO fallback)",
            "observations": observations
        }

    async def get_observation(self, obs_id: str) -> Dict[str, Any]:
        return await self.irsa.get_observation_detail(obs_id)