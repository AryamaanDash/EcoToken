# EcoToken

## Quick Start

1. Start the local proxy backend:

```powershell
.\run-backend.ps1
```

2. In Chrome, open `chrome://extensions`.
3. Enable Developer mode.
4. Click Load unpacked and select the `extension` folder.
5. Visit `https://gemini.google.com/*` and the overlay badge should appear.

## What is working now

- Manifest V3 extension scaffold for Gemini.
- Floating overlay badge injected by the content script.
- Prompt interception hook for Enter and send-button clicks.
- Local FastAPI proxy endpoint at `http://localhost:8000/api/optimize-gemini`.
- Stubbed memory retrieval, routing, and Snowflake logging.

## Notes

- The backend is optional for Chrome loading, but the overlay will show an offline state unless it is running.
- Snowflake logging is disabled unless the required environment variables are set.
