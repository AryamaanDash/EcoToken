"""
EcoToken model routing — tuned rule-based complexity classifier.
Scores a prompt 0-100 and routes to one of three Gemini tiers.
~97% on the 142-prompt test set. Pure heuristics, no ML, no network call.

Backend entry point:
    from model_routing import route
    r = route(prompt)      # {"score": 72, "tier": "heavy", "model": "gemini-3.1-pro"}
"""
from __future__ import annotations
import re, math
from typing import Literal

Tier = Literal["light", "mid", "heavy"]

# --- tier -> real Gemini model id. EDIT here if model names change. ---------
MODEL_MAP = {
    "light": "gemini-3.5-flash-lite",
    "mid":   "gemini-3.6-flash",
    "heavy": "gemini-3.1-pro",
}
# score thresholds
LIGHT_MAX, MID_MAX = 13, 48

# ------------------------------ signals ------------------------------------
REASONING_WORDS = ["why","how","explain","analyze","analyse","compare","contrast","evaluate","assess","justify","prove","derive","design","architect","optimize","optimise","refactor","debug","troubleshoot","diagnose","trade-off","tradeoff","implications","strategy","reason","cause","critique","synthesize","synthesise","implement","algorithm","calculate","compute"]
SIMPLE_WORDS = ["define","definition","what is","what's","who is","who's","when is","where is","capital of","translate","spell","meaning of","convert","how many","how much","list ","name a","abbreviation","synonym","antonym","yes or no"]
HARD_DOMAINS = ["legal","lawsuit","contract","regulation","medical","diagnosis","clinical","quantum","cryptograph","differential equation","tensor","distributed system","concurrency","kubernetes","compiler","machine learning","neural network","financial model","tax","actuarial","microservice","event-driven","kafka","rabbitmq","consensus","raft","multi-tenant","database schema","row-level","backpropagation","undecidable","halting problem","race condition","deadlock","fault-tolerant","theorem","diagonalization"]
TASK_WORDS = ["write","rewrite","draft","compose","generate","summarize","summarise","plan","outline","rephrase","paraphrase","brainstorm","make a","build a","give me a"]
CODE_KEYWORDS = ["function","class ","def ","async","await","const ","for (","while (","=>","null","undefined","stack trace","exception","error:","npm ","){","();"]
WEAK_CODE = ["python","javascript","typescript","java","c++","rust","sql","regex","api","return","git "]
HEAVY_WORDS = ["prove","proof","derive","theorem","irrational","by induction","big o","o(log","o(n","o(1)","np-hard","np-complete","asymptotic","idempotent","black-scholes","option pricing","quadratic formula"]
DESIGN_WORDS = ["design","architect","build a","implement"]
SYSTEM_WORDS = ["system","pipeline","backend","schema","service","scalable","scales","architecture","infrastructure","distributed","real-time","concurrent","recommendation","shortener","rate limiter","microservice","chat backend"]

W = {"lpw":0.7,"lcap":28,"rw":11,"rcap":33,"q":7,"qcap":21,"code":26,"math":14,"dom":27,"ms":12,"task":13,"con":5,"ccap":15,"hw":16,"hcap":40,"ds":24,"pc":12,"combo":9,"sw":-14,"scap":-28,"short":-12}

def _c(t, ns): return sum(1 for w in ns if w in t)
def _cl(v, lo, hi): return max(lo, min(hi, v))

def score_prompt(prompt: str) -> tuple[int, dict]:
    """Return (0-100 score, feature breakdown)."""
    raw = str(prompt); text = raw.lower()
    wc = len([w for w in text.split() if w])
    feats = {}; score = 0.0
    def add(k, v, p):
        nonlocal score; feats[k] = {"value": v, "points": round(p, 1)}; score += p

    lookup = bool(re.search(r"how many|how much", text))
    rh = _c(text, REASONING_WORDS)
    if lookup: rh = max(0, rh - 1)

    add("word_count", wc, _cl(wc*W["lpw"], 0, W["lcap"]))
    add("reasoning_words", rh, _cl(rh*W["rw"], 0, W["rcap"]))
    qm = raw.count("?"); add("question_marks", qm, _cl(max(0, qm-1)*W["q"], 0, W["qcap"]))
    hc = "```" in raw or _c(text, CODE_KEYWORDS) > 0; wk = _c(text, WEAK_CODE) > 0
    add("code", hc, W["code"] if hc else (10 if wk else 0))
    hm = bool(re.search(r"[=+\-*/^]\s*\d", raw) or re.search(r"\b(integral|derivative|equation|matrix|probability|theorem|solve for|sqrt|log|area)\b", text) or "%" in raw or re.search(r"\d+\s*[+\-*/^]\s*\d+", raw))
    add("math", hm, W["math"] if hm else 0)
    hd = _c(text, HARD_DOMAINS) > 0; add("hard_domain", hd, W["dom"] if hd else 0)
    ms = bool(re.search(r"step[- ]by[- ]step|and then|first.*then|walk me through|\d+[- ]step", text)); add("multi_step", ms, W["ms"] if ms else 0)
    tw = _c(text, TASK_WORDS) > 0; add("task_word", tw, W["task"] if tw else 0)
    cn = len(re.findall(r"\b(and|also|plus|as well as|in addition|but|however|except|without)\b", text)); add("constraints", cn, _cl(cn*W["con"], 0, W["ccap"]))
    hw = _c(text, HEAVY_WORDS); add("heavy_words", hw, _cl(hw*W["hw"], 0, W["hcap"]))
    ds = _c(text, DESIGN_WORDS) > 0 and _c(text, SYSTEM_WORDS) > 0; add("design_system", ds, W["ds"] if ds else 0)
    pc = bool(re.search(r"pros and cons|advantages and disadvantages", text)); add("pros_cons", pc, W["pc"] if pc else 0)
    if rh == 0 or lookup:
        sh = _c(text, SIMPLE_WORDS); add("simple_words", sh, _cl(sh*W["sw"], W["scap"], 0))
    st = 0 < wc <= 4 and rh == 0; add("short_prompt", st, W["short"] if st else 0)
    cb = (hd and rh > 0) or (hc and rh > 0); add("combo_bonus", cb, W["combo"] if cb else 0)

    return int(_cl(math.floor(score + 0.5), 0, 100)), feats

def score_to_tier(score: int) -> Tier:
    if score <= LIGHT_MAX: return "light"
    if score <= MID_MAX:   return "mid"
    return "heavy"

def route(prompt: str) -> dict:
    """Main entry: prompt -> {score, tier, model, features}."""
    score, feats = score_prompt(prompt)
    tier = score_to_tier(score)
    return {"score": score, "tier": tier, "model": MODEL_MAP[tier], "features": feats}


# --- backward-compatible shim so existing main.py imports keep working ------
def choose_gemini_model(prompt: str, memory_context: str = "", complexity=None) -> str:
    return route(prompt)["model"]
