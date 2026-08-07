import json, random
from collections import defaultdict
import ecotoken_classifier as v1
import ecotoken_classifier_v2 as v2
import ecotoken_classifier_v3 as v3

random.seed(42)
ORD = {"light": 0, "mid": 1, "heavy": 2}

def load_internal():
    rows = []
    for r in json.load(open("dataset_1000.json")):
        rows.append((r["q"], r["tier"], "tuned807"))
    for r in json.load(open("unbiased_eval.json"))["data"]:
        rows.append((r["q"], r["tier"], "unbiased180"))
    return rows

INTERNAL = load_internal()
MODELS = {"v1": v1, "v2": v2, "v3": v3}
SCORES = {name: {q: mod.classify(q)["score"] for q, y, s in INTERNAL} for name, mod in MODELS.items()}

def tier_from(score, lo, hi):
    return "light" if score <= lo else "mid" if score <= hi else "heavy"

def acc_for(name, rows, lo, hi):
    ok = sum(1 for q, y, s in rows if tier_from(SCORES[name][q], lo, hi) == y)
    return ok / len(rows)

def best_thresholds(name, rows):
    best, blo, bhi = -1, 11, 33
    for lo in range(2, 30):
        for hi in range(lo+1, 70):
            a = acc_for(name, rows, lo, hi)
            if a > best:
                best, blo, bhi = a, lo, hi
    return blo, bhi, best

def stratified_folds(rows, k=5):
    by = defaultdict(list)
    for r in rows: by[r[1]].append(r)
    folds = [[] for _ in range(k)]
    for y, lst in by.items():
        random.shuffle(lst)
        for i, r in enumerate(lst): folds[i % k].append(r)
    return folds

def cv(name, rows, k=5):
    folds = stratified_folds(rows, k)
    accs = []
    for i in range(k):
        test = folds[i]
        train = [r for j in range(k) if j != i for r in folds[j]]
        lo, hi, _ = best_thresholds(name, train)
        accs.append(acc_for(name, test, lo, hi))
    return sum(accs)/len(accs), accs

print("=" * 62)
print("HONEST 5-FOLD CV ON INTERNAL DATA (807+180) — v1 vs v2 vs v3")
print("=" * 62)
for name in ["v1", "v2", "v3"]:
    mean, accs = cv(name, INTERNAL)
    print(f"{name}: mean CV accuracy = {mean*100:.1f}%   folds = {[round(a*100,1) for a in accs]}")

print("\nBest single thresholds fit on ALL internal data (807+180):")
best_lo_hi = {}
for name in ["v1", "v2", "v3"]:
    lo, hi, acc = best_thresholds(name, INTERNAL)
    best_lo_hi[name] = (lo, hi)
    print(f"  {name}: LIGHT_MAX={lo} MID_MAX={hi}  acc_on_internal={acc*100:.1f}%")

PUBLIC = json.load(open("public_bench.json"))
print("\n" + "=" * 62)
print("PUBLIC BENCH (550 examples, GSM8K/HumanEval/SQuAD/LeetCode) — held out")
print("=" * 62)
for name, mod in MODELS.items():
    ok = sum(1 for r in PUBLIC if mod.classify(r["q"])["tier"] == r["tier"])
    sev = sum(1 for r in PUBLIC if abs(ORD[mod.classify(r["q"])["tier"]]-ORD[r["tier"]])==2)
    print(f"\n{name} — AS-SHIPPED thresholds: acc={ok}/{len(PUBLIC)}={ok/len(PUBLIC)*100:.1f}%  severe_flips={sev}")
    for src in ["gsm8k","humaneval","squad","leetcode_hard","leetcode_easy"]:
        rows = [r for r in PUBLIC if r["src"]==src]
        c = sum(1 for r in rows if mod.classify(r["q"])["tier"]==r["tier"])
        print(f"    {src:<14} {c}/{len(rows)} = {c/len(rows)*100:.1f}%")

    lo, hi = best_lo_hi[name]
    def tier2(q): return tier_from(mod.classify(q)["score"], lo, hi)
    ok2 = sum(1 for r in PUBLIC if tier2(r["q"]) == r["tier"])
    print(f"  — INTERNAL-refit thresholds (LIGHT_MAX={lo},MID_MAX={hi}) on PUBLIC: {ok2}/{len(PUBLIC)}={ok2/len(PUBLIC)*100:.1f}%")
