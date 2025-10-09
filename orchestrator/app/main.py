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


@app.get("/", response_class=HTMLResponse)
async def index():
    return """
<!doctype html>
<html>
  <head>
    <meta charset='utf-8'>
    <meta name='viewport' content='width=device-width, initial-scale=1'>
    <title>Poker Assistant (POC)</title>
    <style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 16px}</style>
  </head>
  <body>
    <h1>Poker Assistant (POC)</h1>
    <div id=\"messages\" style=\"border:1px solid #ddd;border-radius:8px;padding:12px;min-height:200px\"></div>
    <div style=\"display:flex;gap:8px;margin-top:12px\">
      <textarea id=\"input\" rows=\"4\" style=\"flex:1;padding:8px\" placeholder=\"e.g. Td9d6hQc, pot 200, eff 900, sizes 60%; OOP=..., IP=...\\n\"></textarea>
      <button id=\"send\">Send</button>
    </div>
    <script>
      const messagesEl = document.getElementById('messages');
      const inputEl = document.getElementById('input');
      const sendEl = document.getElementById('send');
      const state = [];
      function render(){
        messagesEl.innerHTML = state.map(m => `<div style='margin:8px 0'><strong>${m.role}:</strong> ${m.content}</div>`).join('');
      }
      async function send(){
        const text = inputEl.value.trim();
        if(!text) return;
        state.push({role:'user', content:text});
        render();
        inputEl.value='';
        const res = await fetch('/chat', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({messages: state})});
        const data = await res.json();
        state.push(data.message);
        render();
        if (data.solver) {
          state.push({role:'assistant', content: 'Solver JSON: '+JSON.stringify(data.solver)});
          render();
        }
      }
      sendEl.onclick = send;
    </script>
  </body>
</html>
"""


@app.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    try:
        result = await chat_with_tools(req.messages)
        return result
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


