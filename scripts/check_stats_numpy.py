"""Independent Python/numpy check of the dashboard statistics (app/stats.ts) on the Greece country series.

Run from the repository root:  python scripts/check_stats_numpy.py
Compare with:                   node scripts/test_stats.mjs --greece
Only numpy is needed (np.quantile method="median_unbiased" = Hyndman-Fan type 8).
"""
import json
import math
from math import comb

import numpy as np

ix = json.load(open("public/data/index.json", encoding="utf8"))
gr = json.load(open("public/data/pays.json", encoding="utf8"))["Greece"]
y0, m0 = map(int, gr["premier_mois"].split("-"))
last = ix["mois"][-1]
partial = ix.get("mois_partiel", last if ix["genere_le"][:7] == last else None)


def series(key):
    out = {}
    for j, v in enumerate(gr[key]):
        if v is None:
            continue
        k = y0 * 12 + (m0 - 1) + j
        y, m = divmod(k, 12)
        if f"{y}-{m + 1:02d}" == partial:
            continue  # partial month: never in a statistic
        out[(y, m)] = v
    return out


hot, frp = series("hotspots"), series("frp_MW")
q = lambda x, p: float(np.quantile(np.asarray(x, float), p, method="median_unbiased"))
base = lambda s, m, excl=None: [s[(y, m)] for y in range(2003, 2026) if y != excl and (y, m) in s]


def median_ci(x, conf=0.95):
    s, n = sorted(x), len(x)
    cdf = lambda k: sum(comb(n, i) for i in range(k + 1)) / 2 ** n
    k = max(k for k in range(1, n // 2 + 1) if cdf(k - 1) <= (1 - conf) / 2)
    return s[k - 1], s[n - k]


def pr(b, x):
    return 100 * (sum(v < x for v in b) + 0.5 * sum(v == x for v in b)) / len(b)


res = {}
for name, m in (("Aug", 7), ("Oct", 9)):
    b = base(hot, m)
    res[name] = dict(n=len(b), median=q(b, .5), p10=q(b, .1), p90=q(b, .9), mean=float(np.mean(b)),
                     sd=float(np.std(b, ddof=1)), ci=median_ci(b), frpMedian=q(base(frp, m), .5))
b = base(hot, 9, 2026)
res["oct2026"] = dict(value=hot[(2026, 9)], median=q(b, .5), n=len(b), pr=pr(b, hot[(2026, 9)]))
b = base(hot, 7, 2023)
res["aug2023_loo"] = dict(value=hot[(2023, 7)], median=q(b, .5), n=len(b), pr=pr(b, hot[(2023, 7)]))

years = [y for y in range(2003, 2026) if all((y, m) in hot for m in range(12))]
tot = [sum(hot[(y, m)] for m in range(12)) for y in years]
n = len(tot)
S = sum(np.sign(tot[j] - tot[i]) for i in range(n) for j in range(i + 1, n))
_, cnt = np.unique(tot, return_counts=True)
var = (n * (n - 1) * (2 * n + 5) - sum(t * (t - 1) * (2 * t + 5) for t in cnt if t > 1)) / 18
z = (S - np.sign(S)) / math.sqrt(var)
p = 2 * (1 - 0.5 * (1 + math.erf(abs(z) / math.sqrt(2))))
slopes = np.sort([(tot[j] - tot[i]) / (years[j] - years[i]) for i in range(n) for j in range(i + 1, n)])
N, sig = len(slopes), math.sqrt(var)  # years have no ties
C = 1.959963984540054 * sig
lo, hi = slopes[max(int(np.round((N - C) / 2)) - 1, 0)], slopes[min(int(np.round((N + C) / 2)), N - 1)]
med_tot = q(tot, .5)
res["trend"] = dict(slope=float(np.median(slopes)), lo=float(lo), hi=float(hi), pct=100 * float(np.median(slopes)) / med_tot,
                    S=int(S), z=float(z), p=p, n=n)
means = [np.mean(base(hot, m)) for m in range(12)]
meds = [q(base(hot, m), .5) for m in range(12)]
res["season"] = dict(peak=int(np.argmax(meds)), months=[m for m in range(12) if means[m] >= 0.1 * sum(means)])
ytd = sum(hot[(2026, m)] for m in range(10))
yb = [sum(hot[(y, m)] for m in range(10)) for y in range(2003, 2026)]
res["ytd2026_oct"] = dict(value=ytd, median=q(yb, .5), pr=pr(yb, ytd))
w = lambda y: sum(hot[(y - 1, m)] for m in range(10, 12)) + sum(hot[(y, m)] for m in range(10))
lb = [w(y) for y in range(2004, 2026)]
res["last12_2026_oct"] = dict(value=w(2026), median=q(lb, .5), pr=pr(lb, w(2026)), n=len(lb))
print(json.dumps(res, indent=1, default=float))
