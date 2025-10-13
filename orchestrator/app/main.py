from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from .config import settings
from .schemas import ChatRequest, ChatResponse
from .llm import chat_with_tools


app = FastAPI(title="Poker Orchestrator", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/")
async def index():
    return {"message": "Poker Orchestrator API"}


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        result = await chat_with_tools(req.messages)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


