from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

# classifier.py lives at the EcoToken project root and is shared 1:1 (same
# weights) with classifier.js, which the Chrome extension's badge logic and
# analytics.html both assume. Importing it here (instead of re-implementing
# routing) is what makes the backend's tier/model agree with everything else
# scoring the same prompt.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from classifier import classify as _classify  # noqa: E402


def route_prompt(prompt: str) -> dict[str, Any]:
    """Runs the shared rule-based classifier.

    Returns {score, tier, model, label, features} — tier is one of
    "light" | "mid" | "heavy", model is the Gemini model id to call.
    """
    return _classify(prompt)
