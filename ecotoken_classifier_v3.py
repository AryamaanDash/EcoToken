"""
EcoToken complexity classifier v2 — standalone, zero-dependency (stdlib only).

Same drop-in interface as v1 (classify / route / classify_many / MODEL_MAP),
so it replaces the old file with no other code changes.

What changed vs v1
------------------
v1 was a keyword detector: it only recognized difficulty when exact trigger
words ("prove", "design", "architect", "analyze the tradeoffs") were present.
On naturally phrased prompts, heavy-tier recall collapsed to ~33%.

v2 adds INTENT features that catch the same ideas in plain language:
  - proof / formal-argument intent ("convince me", "show why", "walk through why")
  - complexity intent ("worst-case running time", "how long does it take")
  - scale + reliability intent ("millions of users", "even if a server dies")
  - system-design intent phrased casually ("map out a backend that...")
  - diagnosis intent ("why does my program get slower and slower")
  - an ADVICE/TASK floor so ordinary everyday requests clear the light tier

Thresholds were recalibrated on ~1,000 labeled prompts using cross-validation
(see calibrate_v2.py). The score->tier cutoffs live in LIGHT_MAX / MID_MAX.

QUICK USE
---------
    from ecotoken_classifier_v2 import route
    route("how do i center a div in css")
"""
from __future__ import annotations
import re, math, sys, csv
from collections import Counter

# ---- tier -> model. EDIT to your real model ids. --------------------------
MODEL_MAP = {"light": "gemini-3.5-flash-lite",
             "mid":   "gemini-3.6-flash",
             "heavy": "gemini-3.1-pro"}
# Recalibrated by cross-validation on the combined labeled set.
LIGHT_MAX, MID_MAX = 11, 33

# ---- signal dictionaries (v1 kept, extended) ------------------------------
REASONING_WORDS = ["why","how","explain","analyze","analyse","compare","contrast","evaluate","assess","justify","prove","derive","design","architect","optimize","optimise","refactor","debug","troubleshoot","diagnose","trade-off","tradeoff","implications","strategy","reason","cause","critique","synthesize","synthesise","implement","algorithm","calculate","compute"]
SIMPLE_WORDS = ["define","definition","what is","what's","who is","who's","when is","where is","capital of","translate","spell","meaning of","convert","how many","how much","list ","name a","abbreviation","synonym","antonym","yes or no","how do you say","how do i say","what currency","what continent","is ","population of"]
HARD_DOMAINS = ["legal","lawsuit","contract","regulation","medical","diagnosis","clinical","quantum","cryptograph","differential equation","tensor","distributed system","concurrency","kubernetes","compiler","machine learning","neural network","financial model","tax","actuarial","microservice","event-driven","kafka","rabbitmq","consensus","raft","multi-tenant","database schema","row-level","backpropagation","undecidable","halting problem","race condition","deadlock","fault-tolerant","theorem","diagonalization","tls","oauth","cap theorem","replica","failover","load balancer","sharding","pharmacokinetic","pharmacolog","metaboliz","biochemical"]
TASK_WORDS = ["write","rewrite","draft","compose","generate","summarize","summarise","plan","outline","rephrase","paraphrase","brainstorm","make a","build a","give me a","recommend","suggest","tips for","tips to"]
CODE_KEYWORDS = ["function","def ","async","await","const ","for (","while (","=>","null","undefined","stack trace","exception","error:","npm ","){","();"]
WEAK_CODE = ["python","javascript","typescript","java","c++","rust","sql","regex","api","return","git ","class "]
HEAVY_WORDS = ["prove","proof","derive","theorem","irrational","by induction","big o","o(log","o(n","o(1)","np-hard","np-complete","asymptotic","idempotent","black-scholes","option pricing","quadratic formula","root cause","amortized","recurrence","complexity of","closed form","worst case"]
# v3: algorithmic-difficulty cues that separate a genuinely hard coding/algorithm
# problem from a plain "write a function that does X" request (see ALGO_HARD_WORDS below)
ALGO_HARD_WORDS = ["dynamic programming","backtracking","memoiz","recursion","recursive","time complexity","space complexity","in-place","optimal substructure","greedy algorithm","binary search","two pointers","sliding window","topological sort","dijkstra","depth-first","breadth-first","union-find","trie","segment tree","dynamic-programming","shortest path","minimum spanning","divide and conquer","subsequence","permutations of","combinations of","backtrack","pruning","heap","priority queue","adjacency","graph traversal","bitmask","monotonic stack"]
DESIGN_WORDS = ["design","architect","build a","implement"]
SYSTEM_WORDS = ["system","pipeline","backend","schema","service","scalable","scales","architecture","infrastructure","distributed","real-time","concurrent","recommendation","shortener","rate limiter","microservice","chat backend","replica","failover","throughput","latency","load balanc","consistency","partition","stream processing","key-value","crawler","matching engine","scoreboard","leaderboard"]

# ---- v2: natural-language intent cues -------------------------------------
# formal reasoning / proof intent expressed casually
PROOF_INTENT = ["prove","proof","derive","by induction","convince me","show me why","show why","show that","demonstrate that","justify","rigorous","rigorously","from first principles","closed form","closed-form","work out the","figure out the fair","without bound","grows without bound"]
# complexity / analysis intent
COMPLEXITY_INTENT = ["worst case","worst-case","best case","time complexity","space complexity","running time","how long does it take","how many comparisons","big o","asymptotic","amortized","amortised","recurrence","expected number","complexity of","proportional to","n log n","order of growth"]
# scale cues -> almost always heavy system work
SCALE_INTENT = ["millions of","million users","million phones","million people","billions of","billion urls","at scale","under load","under heavy load","heavy load","high load","high throughput","low latency","sub-second","real time","real-time","concurrent","concurrently","thousands of separate","huge audience","tens of millions","hundreds of","live","in real time"]
# reliability / correctness-under-failure cues
RELIABILITY_INTENT = ["even if","goes down","goes dark","randomly dies","one dies","server dies","server crashes","crashes overnight","without losing","without dropping","never see","never lose","exactly once","exactly-once","at-least-once","fault","failover","fail over","survive","survives","stays available","stays consistent","out of sync","idempoten","deadlock","race","double-charge","double charge","duplicate message","duplicate","mid-way","data center"]
# system-design intent phrased casually
DESIGN_INTENT = ["design a","design something","design me","architect","build a system","build me a","build something that","lay out a plan","map out","plan a system","plan out how","plan a storage","how would you build","how would you keep","how do i build","how do people","break our","break the","split the data","move money between","reconcile","spread across","spread writes","across many servers","across many machines","across servers","structure this safely"]
# debugging / diagnosis intent phrased casually
DIAGNOSE_INTENT = ["why does my","why is my","comes out wrong","gives wrong","gets slower","slower and slower","what's going wrong","whats going wrong","what's happening","whats happening","figure out what","terribly in production","in testing but","drift out of sync","drift","can't reproduce","cant reproduce","skips records","leaks memory","memory leak","slow to a crawl"]
# casual "walk me through the reasoning" verbs
REASON_VERBS = ["walk me through","walk through","reason through","reason about","think through","talk me through","work through","step by step","step-by-step","down to how"]
# advice / everyday task intent -> should reach at least mid
ADVICE_INTENT = ["how do i","how do you","how can i","what's a good","whats a good","what's the best","whats the best","best way to","good way to","help me","give me","suggest","recommend","tips for","tips to","ideas for","what should i","some good","how to","word a","phrase a","come up with","turn this into","make this","polite way","gentle way"]

W = {"lpw":0.7,"lcap":24,"rw":9,"rcap":28,"q":6,"qcap":18,"code":24,"math":13,"dom":26,"ms":11,"task":12,
     "con":4,"ccap":12,"hw":14,"hcap":38,"ds":24,"pc":11,"combo":8,"sw":-14,"scap":-28,"short":-11,
     "tradeoff":18,"diagfix":15,
     # v2 intent weights
     "proof":26,"cx":22,"cxcap":30,"scale":10,"scalecap":22,"rely":9,"relycap":22,
     "design2":20,"diag2":18,"reason2":8,"reason2cap":16,"advice":13,
     # v3: plain code (no algorithmic-difficulty cue) gets half credit — a bare
     # "write a function that..." shouldn't auto-cross into heavy on code+task alone
     "code_plain":12, "algo_hard":16,
     # v3: narrative math word problem (multiple numbers + longer prose) — pushes
     # to mid, and gates off the simple_words penalty that used to zero these out
     "narr_math":12, "narr_math_cap":12}

import functools
@functools.lru_cache(maxsize=4096)
def _pat(w):
    # word-boundary-aware match, but ONLY for keywords that are pure alphabetic
    # tokens (no spaces/punctuation). Bare substring containment let short words
    # false-fire inside unrelated words: "raft" inside "draft", "api" inside
    # "capital", "is" inside all sorts of words. Phrase/punctuation entries (e.g.
    # "for (", "o(n", "class ") already carry their own hand-built boundary via
    # embedded spaces/symbols -- leave those as plain substring checks so we don't
    # break intentional code-syntax matching.
    if re.fullmatch(r"[a-z]+", w):
        return re.compile(r"(?<![a-z0-9])" + re.escape(w) + r"(?![a-z0-9])")
    return None  # signals: use plain substring containment

def _c(t, ns):
    n = 0
    for w in ns:
        p = _pat(w)
        n += 1 if (p.search(t) if p else w in t) else 0
    return n

def _cl(v, lo, hi): return max(lo, min(hi, v))

def classify(prompt: str = "") -> dict:
    """Return {score, tier, model, features} for one prompt."""
    raw = str(prompt); text = raw.lower()
    wc = len([w for w in text.split() if w])
    feats = {}; score = 0.0
    def add(k, v, p):
        nonlocal score; feats[k] = {"value": v, "points": round(p, 1)}; score += p

    lookup = bool(re.search(r"how many|how much|how do you say|how do i say", text))
    rh = _c(text, REASONING_WORDS)
    if lookup: rh = max(0, rh - 1)

    add("word_count", wc, _cl(wc*W["lpw"], 0, W["lcap"]))
    add("reasoning_words", rh, _cl(rh*W["rw"], 0, W["rcap"]))
    qm = raw.count("?"); add("question_marks", qm, _cl(max(0, qm-1)*W["q"], 0, W["qcap"]))
    hc = "```" in raw or _c(text, CODE_KEYWORDS) > 0; wk = _c(text, WEAK_CODE) > 0
    algo_hard = _c(text, ALGO_HARD_WORDS) > 0
    # v3: full code weight only when an algorithmic-difficulty cue is also present;
    # a bare "write a function that reverses a string" gets half credit, not full
    if hc:
        code_pts = W["code"] if algo_hard else W["code_plain"]
    else:
        code_pts = 10 if wk else 0
    add("code", hc, code_pts)
    add("algo_hard", algo_hard, W["algo_hard"] if (algo_hard and hc) else 0)
    hm = bool(re.search(r"[=+\-*/^]\s*\d", raw) or re.search(r"\b(integral|derivative|equation|matrix|probability|theorem|solve for|sqrt|log|area|perimeter|average of|geometric series|harmonic series)\b", text) or "%" in raw or re.search(r"\d+\s*[+\-*/^]\s*\d+", raw))
    add("math", hm, W["math"] if hm else 0)
    hd = _c(text, HARD_DOMAINS) > 0; add("hard_domain", hd, W["dom"] if hd else 0)
    ms = bool(re.search(r"step[- ]by[- ]step|and then|first.*then|walk me through|\d+[- ]step", text)); add("multi_step", ms, W["ms"] if ms else 0)
    tw = _c(text, TASK_WORDS) > 0; add("task_word", tw, W["task"] if tw else 0)
    cn = len(re.findall(r"\b(and|also|plus|as well as|in addition|but|however|except|without)\b", text)); add("constraints", cn, _cl(cn*W["con"], 0, W["ccap"]))
    hw = _c(text, HEAVY_WORDS); add("heavy_words", hw, _cl(hw*W["hw"], 0, W["hcap"]))
    ds = _c(text, DESIGN_WORDS) > 0 and _c(text, SYSTEM_WORDS) > 0; add("design_system", ds, W["ds"] if ds else 0)
    pc = bool(re.search(r"pros and cons|advantages and disadvantages", text)); add("pros_cons", pc, W["pc"] if pc else 0)
    tr = bool(re.search(r"tradeoff|trade-off", text)) and bool(re.search(r"analyze|analyse|evaluate|vs |versus|costs of both|both at scale", text)); add("tradeoff", tr, W["tradeoff"] if tr else 0)
    df = bool(re.search(r"root cause|analyze the root|diagnose.*(fix|cause)|(fix|cause).*diagnose", text)); add("diagnose_fix", df, W["diagfix"] if df else 0)

    # ---- v2 intent features -----------------------------------------------
    pf = _c(text, PROOF_INTENT) > 0; add("proof_intent", pf, W["proof"] if pf else 0)
    cx = _c(text, COMPLEXITY_INTENT); add("complexity_intent", cx, _cl(cx*W["cx"], 0, W["cxcap"]))
    sc = _c(text, SCALE_INTENT); add("scale_intent", sc, _cl(sc*W["scale"], 0, W["scalecap"]))
    rl = _c(text, RELIABILITY_INTENT); add("reliability_intent", rl, _cl(rl*W["rely"], 0, W["relycap"]))
    de = _c(text, DESIGN_INTENT) > 0; add("design_intent", de, W["design2"] if de else 0)
    di = _c(text, DIAGNOSE_INTENT) > 0; add("diagnose_intent", di, W["diag2"] if di else 0)
    rv = _c(text, REASON_VERBS); add("reason_verbs", rv, _cl(rv*W["reason2"], 0, W["reason2cap"]))

    # advice/task floor: everyday requests that aren't pure lookups reach mid
    adv = _c(text, ADVICE_INTENT) > 0
    is_lookup_like = lookup or (rh == 0 and _c(text, SIMPLE_WORDS) > 0 and not adv)
    give_advice = adv and not is_lookup_like
    add("advice_intent", give_advice, W["advice"] if give_advice else 0)

    # v3: narrative math word problem — several numbers in a story ending in an
    # actual quantity question ("how many.../how much.../...together?"), and NOT
    # already looking like a code/algorithm problem statement (which also tends to
    # have several numbers, e.g. constraints/examples, but isn't a story problem).
    # Previously "how many/how much" at the end of any multi-step arithmetic story
    # was scored identically to a 4-word trivia lookup and collapsed to light with
    # no positive signal at all.
    num_count = len(set(re.findall(r"\$?\b\d[\d,]*(?:\.\d+)?%?\b", raw)))
    qty_cue = bool(re.search(r"how many|how much|how long does|how old|in total|altogether|left over|total number of|do they have (together|combined)", text))
    narr_math = num_count >= 2 and wc >= 12 and qty_cue and not hc and not wk
    add("narrative_math", narr_math, _cl(W["narr_math"], 0, W["narr_math_cap"]) if narr_math else 0)

    if (rh == 0 or lookup) and not narr_math:
        sh = _c(text, SIMPLE_WORDS); add("simple_words", sh, _cl(sh*W["sw"], W["scap"], 0))
    stp = 0 < wc <= 4 and rh == 0; add("short_prompt", stp, W["short"] if stp else 0)
    cb = (hd and rh > 0) or (hc and rh > 0); add("combo", cb, W["combo"] if cb else 0)

    s = int(_cl(math.floor(score + 0.5), 0, 100))
    tier = "light" if s <= LIGHT_MAX else "mid" if s <= MID_MAX else "heavy"
    return {"score": s, "tier": tier, "model": MODEL_MAP[tier], "features": feats}

def route(prompt: str) -> dict:
    return classify(prompt)

def classify_many(prompts) -> list[dict]:
    out = []
    for p in prompts:
        r = classify(p)
        out.append({"prompt": p, "score": r["score"], "tier": r["tier"], "model": r["model"]})
    return out

def _report(prompts):
    rows = classify_many(prompts)
    n = len(rows) or 1
    counts = Counter(r["tier"] for r in rows)
    print(f"\n{len(rows)} prompts:")
    for t in ["light", "mid", "heavy"]:
        c = counts[t]; print(f"  {t:<6} {c:>4} ({c/n*100:>4.0f}%)  {'#'*round(c/n*40)}")
    price = {"light": 0.10, "mid": 0.30, "heavy": 2.50}
    routed = sum(price[r["tier"]] for r in rows) / 1000
    allpro = len(rows) * price["heavy"] / 1000
    if allpro:
        print(f"\nsavings vs always-Pro: {(allpro-routed)/allpro*100:.0f}% cheaper")
    with open("results.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["prompt", "score", "tier", "model"])
        w.writeheader(); w.writerows(rows)
    print("wrote results.csv")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        prompts = [l.strip() for l in open(sys.argv[1]) if l.strip()]
    else:
        prompts = ["what is the capital of france", "how do i center a div in css",
                   "write a birthday message for my mom", "whats 20% of 60",
                   "design a scalable notification system for millions of users",
                   "prove that the square root of 2 is irrational"]
    _report(prompts)
