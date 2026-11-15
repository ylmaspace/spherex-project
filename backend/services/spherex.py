from typing import Any

from backend.services.irsa import IRSAService


class SPHERExService:
    def __init__(self) -> None:
        self.irsa = IRSAService()

    async def search_sky(self, ra: float, dec: float, radius: float, limit: int | None = None) -> dict[str, Any]:
        return await self.irsa.query_observations(ra, dec, radius, limit)

    async def get_observation(self, obs_id: str) -> dict[str, Any]:
        return await self.irsa.get_observation_detail(obs_id)
