from __future__ import annotations

import math
import os
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from model_routing import route, MODEL_MAP

try:
    import snowflake.connector
except Exception:  # pragma: no cover - optional local dependency
    snowflake = None

app = FastAPI(title="EcoToken Gemini Proxy", version="0.2.0")

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
    tier: str
    complexity_score: int
    memory_context: str
    pct_saved: float
    baseline_cost: float
    actual_cost: float
    estimated_co2_saved_g: float


# --- per-token rates. Baseline is always the top model. EDIT to real prices. -
MODEL_RATES = {
    "gemini-3.5-flash-lite": 0.000002,
    "gemini-3.6-flash": 0.000005,
    "gemini-3.1-pro": 0.000015,
}
BASELINE_MODEL = MODEL_MAP["heavy"]           # what you'd pay if you always used Pro
TIER_OVERHEAD = {"light": 60, "mid": 90, "heavy": 120}   # est. output tokens per tier


def retrieve_memory_context(prompt: str) -> str:
    prompt_lower = prompt.lower()
    snippets: list[str] = []
    if any(k in prompt_lower for k in ["token", "cost", "pricing", "savings"]):
        snippets.append("Relevant memory: previous optimization runs focused on reducing token overhead and measuring cost savings.")
    if any(k in prompt_lower for k in ["finance", "billing", "invoice"]):
        snippets.append("Relevant memory: finance workflows prefer concise structured outputs and tighter context pruning.")
    if any(k in prompt_lower for k in ["code", "api", "bug", "debug"]):
        snippets.append("Relevant memory: technical tasks benefit from routing to the higher-reasoning model when complexity is elevated.")
    if not snippets:
        snippets.append("Relevant memory: preserve only the minimum useful context and keep the response execution-focused.")
    return "\n".join(snippets)


def estimate_tokens(text: str) -> int:
    return max(1, math.ceil(len(text.split()) * 1.35))


def calculate_costs(prompt: str, memory_context: str, tier: str, routed_model: str) -> dict[str, Any]:
    prompt_tokens = estimate_tokens(prompt)
    memory_tokens = estimate_tokens(memory_context)
    baseline_tokens = prompt_tokens + 250
    actual_tokens = prompt_tokens + memory_tokens + TIER_OVERHEAD.get(tier, 120)

    baseline_rate = MODEL_RATES[BASELINE_MODEL]
    actual_rate = MODEL_RATES.get(routed_model, baseline_rate)

    baseline_cost = baseline_tokens * baseline_rate
    actual_cost = actual_tokens * actual_rate
    pct_saved = 0.0 if baseline_cost <= 0 else max(0.0, min(100.0, ((baseline_cost - actual_cost) / baseline_cost) * 100.0))

    # Illustrative inference-energy assumptions until measured model telemetry is available.
    energy_wh_per_1k_tokens = {
        "gemini-3.5-flash-lite": 0.3,
        "gemini-3.6-flash": 0.6,
        "gemini-3.1-pro": 1.2,
    }
    grid_carbon_g_per_kwh = 400.0
    baseline_energy_wh = (baseline_tokens / 1000) * energy_wh_per_1k_tokens[BASELINE_MODEL]
    actual_energy_wh = (actual_tokens / 1000) * energy_wh_per_1k_tokens.get(routed_model, energy_wh_per_1k_tokens[BASELINE_MODEL])
    energy_saved_wh = max(0.0, baseline_energy_wh - actual_energy_wh)
    estimated_co2_saved_g = (energy_saved_wh / 1000) * grid_carbon_g_per_kwh

    return {
        "model_used": routed_model,
        "baseline_cost": round(baseline_cost, 6),
        "actual_cost": round(actual_cost, 6),
        "pct_saved": round(pct_saved, 2),
        "estimated_co2_saved_g": round(estimated_co2_saved_g, 6),
    }


def log_to_snowflake(payload: dict[str, Any]) -> None:
    if snowflake is None:
        return
    account = os.getenv("SNOWFLAKE_ACCOUNT"); user = os.getenv("SNOWFLAKE_USER")
    password = os.getenv("SNOWFLAKE_PASSWORD"); warehouse = os.getenv("SNOWFLAKE_WAREHOUSE")
    database = os.getenv("SNOWFLAKE_DATABASE"); schema = os.getenv("SNOWFLAKE_SCHEMA")
    role = os.getenv("SNOWFLAKE_ROLE"); table_name = os.getenv("SNOWFLAKE_TABLE", "TOKEN_SAVINGS_LOG")
    if not all([account, user, password, warehouse, database, schema]):
        return
    try:
        connection = snowflake.connector.connect(
            account=account, user=user, password=password, warehouse=warehouse,
            database=database, schema=schema, role=role,
        )
    except Exception:
        return
    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"""
                INSERT INTO {table_name} (
                    event_ts, prompt, model_used, memory_context,
                    pct_saved, baseline_cost, actual_cost, complexity
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    datetime.now(timezone.utc), payload["prompt"], payload["model_used"],
                    payload["memory_context"], payload["pct_saved"], payload["baseline_cost"],
                    payload["actual_cost"], payload["complexity"],
                ),
            )
        connection.commit()
    except Exception:
        pass
    finally:
        connection.close()


@app.post("/api/optimize-gemini", response_model=OptimizeGeminiResponse)
def optimize_gemini(request: OptimizeGeminiRequest) -> OptimizeGeminiResponse:
    memory_context = retrieve_memory_context(request.prompt)

    # --- tuned classifier: score -> tier -> model ---
    routing = route(request.prompt)
    tier = routing["tier"]
    recommended_model = routing["model"]
    score = routing["score"]

    cost_data = calculate_costs(request.prompt, memory_context, tier, recommended_model)

    response_text = (
        f"Processed as {tier} query (score {score}) with {recommended_model}. "
        "This is a scaffold response from the local proxy."
    )

    payload = {
        "prompt": request.prompt,
        "memory_context": memory_context,
        "complexity": tier,
        **cost_data,
    }
    log_to_snowflake(payload)

    return OptimizeGeminiResponse(
        response=response_text,
        recommended_model=recommended_model,
        model_used=cost_data["model_used"],
        tier=tier,
        complexity_score=score,
        memory_context=memory_context,
        pct_saved=cost_data["pct_saved"],
        baseline_cost=cost_data["baseline_cost"],
        actual_cost=cost_data["actual_cost"],
        estimated_co2_saved_g=cost_data["estimated_co2_saved_g"],
    )
