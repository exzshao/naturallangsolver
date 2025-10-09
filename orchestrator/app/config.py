import os
from typing import List
from dotenv import load_dotenv

load_dotenv()

class Settings:
    def __init__(self) -> None:
        self.openai_api_key: str | None = os.getenv("OPENAI_API_KEY")
        self.solver_url: str = os.getenv("SOLVER_URL", "http://localhost:8080")
        self.request_timeout_seconds: float = float(os.getenv("REQUEST_TIMEOUT_SECONDS", "30"))
        self.max_llm_tokens: int = int(os.getenv("MAX_LLM_TOKENS", "800"))
        self.model: str = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
        self.cors_allow_origins: List[str] = (
            os.getenv("CORS_ALLOW_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
            .split(",")
        )


settings = Settings()


