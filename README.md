# EcoToken

Routes each Gemini prompt to the cheapest model tier that can actually handle it (Flash-Lite / Flash / Pro), instead of always paying for Pro. A Chrome extension intercepts the prompt, a local FastAPI backend classifies its complexity and picks a model, and the extension auto-selects that model in Gemini's UI before sending.

## How it fits together

- **`backend/`** — FastAPI proxy (`main.py`). Classifies the prompt via `model_routing.py`, estimates token cost and CO2 saved vs. always using Pro, optionally logs to Snowflake, and appends every request to `requests_log.json` at the project root.
- **`model_routing.py`** — tuned rule-based complexity classifier (~96% accuracy on the 807-prompt set in `dataset_1000.json`). No ML, no network call. Scores a prompt 0–100 and maps it to `light` / `mid` / `heavy` → `gemini-3.5-flash-lite` / `gemini-3.6-flash` / `gemini-3.1-pro`.
- **`classifier.py` / `classifier.js`** — an earlier, standalone mirrored (Python + JS) version of the same idea, evaluated against `dataset.json` (40 prompts) via `evaluate.mjs`. Kept for reference/experimentation; the backend runs on `model_routing.py`, not this pair.
- **`backend/hybrid_router.py`** — optional escalation path: trusts the rule-based score except near tier boundaries, where it can call a cheap LLM to break the tie. Not currently wired into `main.py`'s endpoint.
- **`extension/`** — Manifest V3 Chrome extension for `gemini.google.com`.
  - `content.js` — intercepts Enter/Send, posts the prompt to the backend, auto-selects the recommended model in Gemini's picker, re-triggers the send, and shows a floating live-metrics badge. Has a global on/off toggle synced via `chrome.storage`.
  - `popup.html`/`popup.js` — toolbar popup with the enable/disable switch and all-time cost/CO2-saved totals.
  - `extension/analytics/` — a fuller in-extension analytics dashboard (opened from the popup) reading live from `chrome.storage.local`, with daily breakdowns.
- **`index.html` / `analytics.html` / `app.js` / `styles.css`** (project root) — a standalone marketing/landing page and a separate savings dashboard. `analytics.html` can load `requests_log.json` (via file picker, or automatically if served over HTTP — see below) to visualize real backend traffic outside the extension.

## Quick start

1. Install backend dependencies and run the proxy:

   ```bash
   cd backend
   pip install -r requirements.txt
   uvicorn main:app --host 127.0.0.1 --port 8000 --reload
   ```

   On Windows you can instead run `.\run-backend.ps1` from the project root (uses `.venv\Scripts\python.exe` if present, falls back to `python`).

2. In Chrome, open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked** and select the `extension` folder.
5. Visit `https://gemini.google.com/*` — the overlay badge should appear. Use the extension's toolbar popup to enable/disable it and see running totals.

To view the standalone dashboard with live-updating data instead of the extension's own analytics page:

```bash
cd EcoToken   # project root
python3 -m http.server 8080
```

Then open `http://localhost:8080/analytics.html` (not `file://` — the live-poll fetch needs a real server to avoid CORS issues). It re-fetches `requests_log.json` every 3 seconds, so prompts routed through the extension show up automatically.

## What is working now

- Manifest V3 extension scaffold for Gemini, with an enable/disable toggle.
- Tuned 3-tier rule-based classifier (~96% on 807 labeled prompts), routing to Flash-Lite / Flash / Pro.
- Auto-selects the recommended model in Gemini's model picker and re-sends the prompt.
- Floating overlay badge with live savings metrics; toolbar popup with all-time totals; full in-extension analytics dashboard with daily breakdowns.
- Local FastAPI proxy at `http://localhost:8000/api/optimize-gemini` returning cost, tier, and estimated CO2 saved per request.
- Requests logged to `requests_log.json` (for the standalone dashboard) and, if configured, to Snowflake.
- Memory-context retrieval is a keyword-based stub, not a real memory system yet.

## Notes

- The backend is optional for loading the extension in Chrome, but the overlay shows an offline state and no auto-routing happens unless it's running.
- Snowflake logging is disabled unless all `SNOWFLAKE_*` environment variables are set.
- Model ids (`gemini-3.5-flash-lite`, `gemini-3.6-flash`, `gemini-3.1-pro`) and their per-token/energy rates in `backend/main.py` are placeholders — swap in real pricing/model ids before this leaves hackathon-land.
- CO2/energy figures are illustrative estimates, not measured telemetry.
- The model-picker auto-click in `content.js` depends on Gemini's current DOM structure and may need adjusting if Gemini's UI changes.
