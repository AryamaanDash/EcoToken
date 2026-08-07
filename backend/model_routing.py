from __future__ import annotations

from typing import Literal


GeminiModel = Literal["gemini-2.5-flash", "gemini-2.5-pro"]


def choose_gemini_model(prompt: str, memory_context: str, complexity: Literal["simple", "complex"]) -> GeminiModel:
    """
    Stub routing rules for the team to refine.

    Current default:
    - simple prompts -> gemini-2.5-flash
    - complex prompts -> gemini-2.5-pro
    """

    _ = (prompt, memory_context)
    return "gemini-2.5-flash" if complexity == "simple" else "gemini-2.5-pro"
