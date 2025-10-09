# Orchestrator (FastAPI)

Local dev:

```
# in repo root
setx OPENAI_API_KEY your_key_here
setx SOLVER_URL http://localhost:8080

# run Rust solver in another shell
cargo run -p solver-service

# run orchestrator
uvicorn orchestrator.app.main:app --reload --port 8000
```

POC UI: visit http://localhost:8000 and use the textbox.

Chat request example:

```
curl -s -X POST http://localhost:8000/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      {"role":"user","content":"Solve Td9d6hQc, pot 200, eff 900, 60% sizes. OOP=66+,A8s+,A5s-A4s,AJo+,K9s+,KQo,QTs+,JTs,96s+,85s+,75s+,65s,54s; IP=QQ-22,AQs-A2s,ATo+,K5s+,KJo+,Q8s+,J8s+,T7s+,96s+,86s+,75s+,64s+,53s+"}
    ]
  }'
```

