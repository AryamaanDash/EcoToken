from __future__ import annotations

import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from model_routing import route_prompt

try:
    import snowflake.connector
except Exception:  # pragma: no cover - optional local dependency
    snowflake = None

app = FastAPI(title="EcoToken Gemini Proxy", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class OptimizeGeminiRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


class OptimizeGeminiResponse(BaseModel):
    response: str
    recommended_model: str
    model_used: str
    memory_context: str
    tier: str
    score: int
    pct_saved: float
    baseline_cost: float
    actual_cost: float


def retrieve_memory_context(prompt: str) -> str:
    prompt_lower = prompt.lower()
    snippets: list[str] = []

    if any(keyword in prompt_lower for keyword in ["token", "cost", "pricing", "savings"]):
        snippets.append("Relevant memory: previous optimization runs focused on reducing token overhead and measuring cost savings.")
    if any(keyword in prompt_lower for keyword in ["finance", "billing", "invoice"]):
        snippets.append("Relevant memory: finance workflows prefer concise structured outputs and tighter context pruning.")
    if any(keyword in prompt_lower for keyword in ["code", "api", "bug", "debug"]):
        snippets.append("Relevant memory: technical tasks benefit from routing to the higher-reasoning model when complexity is elevated.")

    if not snippets:
        snippets.append("Relevant memory: preserve only the minimum useful context and keep the response execution-focused.")

    return "\n".join(snippets)


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text.split()) * 1.35))


# Placeholder per-token rates for the three tiers classifier.py/js route to.
# Swap for real per-provider pricing before this leaves hackathon-land.
MODEL_RATES = {
    "gemini-3.5-flash-lite": 0.000002,
    "gemini-3.6-flash": 0.000005,
    "gemini-3.1-pro": 0.000015,
}
BASELINE_MODEL = "gemini-3.1-pro"  # what every prompt would cost if never routed down
EXTRA_TOKENS_BY_TIER = {"light": 40, "mid": 80, "heavy": 140}


def calculate_costs(
    prompt: str,
    memory_context: str,
    tier: Literal["light", "mid", "heavy"],
    routed_model: str,
) -> dict[str, Any]:
    prompt_tokens = estimate_tokens(prompt)
    memory_tokens = estimate_tokens(memory_context)
    baseline_tokens = prompt_tokens + 250
    actual_tokens = prompt_tokens + memory_tokens + EXTRA_TOKENS_BY_TIER.get(tier, 80)

    baseline_rate = MODEL_RATES[BASELINE_MODEL]
    actual_rate = MODEL_RATES.get(routed_model, baseline_rate)

    baseline_cost = baseline_tokens * baseline_rate
    actual_cost = actual_tokens * actual_rate
    pct_saved = 0.0 if baseline_cost <= 0 else max(0.0, min(100.0, ((baseline_cost - actual_cost) / baseline_cost) * 100.0))

    return {
        "model_used": routed_model,
        "baseline_cost": round(baseline_cost, 6),
        "actual_cost": round(actual_cost, 6),
        "pct_saved": round(pct_saved, 2),
    }


def log_to_snowflake(payload: dict[str, Any]) -> None:
    if snowflake is None:
        return

    account = os.getenv("SNOWFLAKE_ACCOUNT")
    user = os.getenv("SNOWFLAKE_USER")
    password = os.getenv("SNOWFLAKE_PASSWORD")
    warehouse = os.getenv("SNOWFLAKE_WAREHOUSE")
    database = os.getenv("SNOWFLAKE_DATABASE")
    schema = os.getenv("SNOWFLAKE_SCHEMA")
    role = os.getenv("SNOWFLAKE_ROLE")
    table_name = os.getenv("SNOWFLAKE_TABLE", "TOKEN_SAVINGS_LOG")

    if not all([account, user, password, warehouse, database, schema]):
        return

    try:
        connection = snowflake.connector.connect(
            account=account,
            user=user,
            password=password,
            warehouse=warehouse,
            database=database,
            schema=schema,
            role=role,
        )
    except Exception:
        return

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                INSERT INTO {table_name} (
                    event_ts,
                    prompt,
                    model_used,
                    memory_context,
                    pct_saved,
                    baseline_cost,
                    actual_cost,
                    tier,
                    score
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    datetime.now(timezone.utc),
                    payload["prompt"],
                    payload["model_used"],
                    payload["memory_context"],
                    payload["pct_saved"],
                    payload["baseline_cost"],
                    payload["actual_cost"],
                    payload["tier"],
                    payload["score"],
                ),
            )
        connection.commit()
    except Exception:
        pass
    finally:
        connection.close()


# analytics.html already knows how to load a JSON file shaped like this
# (its file picker + "Load requests_log.json" button) — writing every live
# request here is what turns the dashboard from demo data into real usage.
LOCAL_LOG_PATH = Path(__file__).resolve().parent.parent / "requests_log.json"


def append_local_log(entry: dict[str, Any]) -> None:
    try:
        existing = json.loads(LOCAL_LOG_PATH.read_text()) if LOCAL_LOG_PATH.exists() else []
    except (json.JSONDecodeError, OSError):
        existing = []
    existing.append(entry)
    LOCAL_LOG_PATH.write_text(json.dumps(existing, indent=2))


@app.post("/api/optimize-gemini", response_model=OptimizeGeminiResponse)
def optimize_gemini(request: OptimizeGeminiRequest) -> OptimizeGeminiResponse:
    memory_context = retrieve_memory_context(request.prompt)
    route_result = route_prompt(request.prompt)
    tier = route_result["tier"]
    recommended_model = route_result["model"]
    cost_data = calculate_costs(request.prompt, memory_context, tier, recommended_model)

    response_text = (
        f"Processed as {route_result['label']} ({tier}) with {recommended_model}. "
        "This is a scaffold response from the local proxy."
    )

    payload = {
        "prompt": request.prompt,
        "memory_context": memory_context,
        "tier": tier,
        "score": route_result["score"],
        **cost_data,
    }
    log_to_snowflake(payload)
    append_local_log({
        "ts": int(datetime.now(timezone.utc).timestamp() * 1000),
        "prompt": request.prompt,
        "score": route_result["score"],
        "tier": tier,
        "model": recommended_model,
    })

    return OptimizeGeminiResponse(
        response=response_text,
        recommended_model=recommended_model,
        model_used=cost_data["model_used"],
        memory_context=memory_context,
        tier=tier,
        score=route_result["score"],
        pct_saved=cost_data["pct_saved"],
        baseline_cost=cost_data["baseline_cost"],
        actual_cost=cost_data["actual_cost"],
    )
