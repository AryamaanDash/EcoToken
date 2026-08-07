"""
Hybrid router: rules first, cheap LLM only for the uncertain middle.

The rule-based classifier is right ~96% of the time and free. Its mistakes
cluster near the tier boundaries (scores just under/over a threshold). So:

  - If the score is comfortably inside a tier  -> trust the rules (free).
  - If the score is near a boundary (uncertain) -> ask a cheap model
    (Flash-Lite) to pick the tier. One small call, only when it matters.

This keeps 85-90% of traffic free while recovering most of the boundary
misses. Plug your Gemini call into `llm_classify` below.

    from hybrid_router import route_hybrid
    r = route_hybrid(prompt)        # uses rules; escalates only if uncertain
    r["method"]  # "rules" or "llm" — so you can measure how often you paid
"""
from __future__ import annotations
import os
from model_routing import score_prompt, score_to_tier, MODEL_MAP, LIGHT_MAX, MID_MAX

# How close to a boundary counts as "uncertain". Wider band = more LLM calls,
# higher accuracy, higher cost. +/-4 escalates roughly 10-15% of prompts.
BAND = 4
BOUNDARIES = (LIGHT_MAX, MID_MAX)

def is_uncertain(score: int) -> bool:
    return any(abs(score - b) <= BAND for b in BOUNDARIES)


def llm_classify(prompt: str) -> str:
    """
    Ask the cheapest model to label complexity as light | mid | heavy.
    Returns a tier string. Falls back to None if no key / any error, so the
    caller can keep the rule-based answer.

    Wire in your real Gemini call where marked. Kept dependency-free by default.
    """
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None  # no key -> caller keeps the rule-based tier
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        model = genai.GenerativeModel(MODEL_MAP["light"])  # cheapest model classifies
        instruction = (
            "Classify the COMPLEXITY of the user's request as exactly one word: "
            "light (simple lookup/fact), mid (explanation/how-to/short writing), "
            "or heavy (multi-step reasoning, proofs, system design, real debugging). "
            "Answer with only that one word.\n\nRequest: " + prompt
        )
        out = model.generate_content(instruction).text.strip().lower()
        for t in ("light", "mid", "heavy"):
            if t in out:
                return t
    except Exception:
        return None
    return None


def route_hybrid(prompt: str) -> dict:
    score, feats = score_prompt(prompt)
    tier = score_to_tier(score)
    method = "rules"

    if is_uncertain(score):
        llm_tier = llm_classify(prompt)
        if llm_tier:
            tier = llm_tier
            method = "llm"

    return {
        "score": score,
        "tier": tier,
        "model": MODEL_MAP[tier],
        "method": method,      # track this to report how often you paid for a call
        "features": feats,
    }


if __name__ == "__main__":
    # Demo without an API key: shows which prompts WOULD escalate.
    for q in ["capital of France?",
              "how do I sort a list by a key?",
              "analyze the tradeoffs of batch vs stream processing",
              "design a URL shortener that scales to a billion links"]:
        s, _ = score_prompt(q)
        print(f"score {s:>3}  uncertain={is_uncertain(s)!s:<5} | {q}")
