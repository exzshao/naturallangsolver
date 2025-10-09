import httpx
from .config import settings
from .schemas import SolverSolveRequest, SolverSolveResponse


async def solve(req: SolverSolveRequest) -> SolverSolveResponse:
    async with httpx.AsyncClient(timeout=settings.request_timeout_seconds) as client:
        res = await client.post(f"{settings.solver_url}/solve", json=req.dict())
        res.raise_for_status()
        data = res.json()
        return SolverSolveResponse(**data)


