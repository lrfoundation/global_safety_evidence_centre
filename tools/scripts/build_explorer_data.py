#!/usr/bin/env python3
"""
Build the World Risk Poll 2025 Data Explorer dataset.

Reads the harmonised 2025 wave file (build_wrp_waves.py output: the parquet for
the data, the sibling .sav for labels) - the same source the other three waves
use, so country names, weights and demographics carry identical names, codes
and labels across the whole tool. That file also holds the corrected China
survey and projection weights, which the older wrp_25.sav does not.

Emits a compact columnar dataset the browser explorer loads once and
aggregates live:

  tools/data/wrp_explorer.json     catalogue (dimensions, questions, metrics, countries)
                                   + binary manifest (column order, dtypes, byte offsets)
  tools/data/wrp_explorer.bin      concatenated little-endian column buffers (column-major)
  tools/data/wrp_explorer.bin.gz   gzip of the .bin (browser DecompressionStream; .bin fallback)

Encoding (smallest faithful form):
  - categorical answers/dimensions -> Int8, original survey codes preserved (1,2,3,97,98,99,...),
    missing -> -1. DK(98)/Refused(99) are kept as real categories (they sit in metric denominators).
  - country -> Int16 index into `countries`.
  - 0..1 indices -> Int8 quantised to 0..100 (-1 missing).
  - PROJWT -> Float32.

Metric rule (verified against the Looker report): pct = weight(numerator codes)
/ weight(all non-missing for that variable, INCLUDING DK 98 and Refused 99).

Set WRP_CLEAN_DIR to point at the 'Datafile cleaning/output' folder if it is
not at the default location.
"""
import json, gzip, struct, os, sys
import numpy as np
import pandas as pd
import pyreadstat

from wrp_indices import experience_index_2025

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

# Harmonised, cleaned wave files (build_wrp_waves.py output). Same source as the
# other three waves now use, so the demographics carry identical names, codes
# and labels across the whole tool, and the corrected China weights come in with
# the data rather than being patched on afterwards. Override with WRP_CLEAN_DIR.
CLEAN_DIR = os.environ.get("WRP_CLEAN_DIR", r"D:\Repos\Foundation\Datafile cleaning\output")
CLEAN_2025 = os.path.join(CLEAN_DIR, "WRP_2025", "WRP_2025.parquet")
CLEAN_2025_SAV = os.path.join(CLEAN_DIR, "WRP_2025", "WRP_2025.sav")


def load_2025():
    """(df, value_labels) for the harmonised 2025 wave."""
    for path in (CLEAN_2025, CLEAN_2025_SAV):
        if not os.path.exists(path):
            raise SystemExit(
                f"Harmonised 2025 wave file not found at {path}. Point WRP_CLEAN_DIR at "
                "the 'Datafile cleaning/output' folder, or re-run build_wrp_waves.py."
            )
    df = pd.read_parquet(CLEAN_2025)
    _, meta = pyreadstat.read_sav(CLEAN_2025_SAV, metadataonly=True)
    return df, {k: dict(v) for k, v in meta.variable_value_labels.items()}


# ---- WRP data-viz palette (matches Chart/Map Studio "WRP set") ----
POS_COLOURS = ["#e3076e", "#00a7b3", "#00785c", "#f07800", "#7a50de"]  # codes 1..5
SPECIAL_COLOURS = {97: "#d8d8de", 98: "#bdbdbd", 99: "#0d2240"}        # n/a, DK, Refused

# ---- variable groups -------------------------------------------------------
WORRY = [  # (var, slug, label)  1=Very 2=Somewhat 3=Not 98=DK 99=Refused
    ("WP20719", "climate", "Climate change a threat to country (next 20 yrs)"),
    ("WP24225", "climate_other", "Most others see climate as a threat (next 20 yrs)"),
    ("WP20720", "food", "Worried food could cause serious harm"),
    ("WP20721", "water", "Worried water could cause serious harm"),
    ("WP20722", "crime", "Worried violent crime could cause serious harm"),
    ("WP20723", "weather", "Worried severe weather could cause serious harm"),
    ("WP24174", "prolonged_weather", "Worried prolonged severe weather could cause harm"),
    ("WP24173", "wildfires", "Worried wildfires could cause serious harm"),
    ("WP24175", "air", "Worried the air could cause serious harm"),
    ("WP20726", "mental_health", "Worried mental health could cause serious harm"),
    ("WP22213", "traffic", "Worried traffic could cause serious harm"),
    ("WP22214", "work", "Worried work could cause serious harm"),
]
EXPERIENCE = [  # 1=personally 2=know someone 3=both 4=No 98 99
    ("WP22442", "exp_food", "Experienced harm: eating food"),
    ("WP22443", "exp_water", "Experienced harm: drinking water"),
    ("WP22444", "exp_crime", "Experienced harm: violent crime"),
    ("WP22445", "exp_weather", "Experienced harm: severe weather"),
    ("WP24177", "exp_prolonged_weather", "Experienced harm: prolonged severe weather"),
    ("WP24176", "exp_wildfires", "Experienced harm: wildfires"),
    ("WP24178", "exp_air", "Experienced harm: the air"),
    ("WP22446", "exp_traffic", "Experienced harm: traffic"),
    ("WP22447", "exp_mental_health", "Experienced harm: mental health"),
    ("WP22448", "exp_work", "Experienced harm: work"),
]
TRUST = [  # 1=a lot 2=somewhat 3=not at all 99=DK/Refused
    # WP22231_ALL is WP22231 with Myanmar and Vietnam folded in (their versions
    # of the question sit in WP22469 and WP22525) and DK/Refused collapsed to
    # 99. Verified as an exact superset: it agrees with WP22231 on every
    # overlapping respondent once 98/99 are merged, and adds 2,003 answers the
    # hand-rolled Myanmar-only blend this script used to do never reached.
    ("WP22231_ALL", "govt_cares", "Government / authorities care about your wellbeing"),
    ("WP22232", "neighbours_care", "Neighbours care about your wellbeing"),
]
BINARY = [  # (var, slug, label, yes_codes) — 1=Yes 2=No ...
    ("WP24213", "impacted_disaster", "Impacted by a disaster (past 5 yrs)", [1]),
    ("WP24198", "govt_prepared", "National government well prepared for a disaster", [1]),
    ("WP24215", "able_action", "Able to act on an advance disaster warning", [1]),
    ("WP23345", "plan_known", "Household disaster plan known by all members 10+", [1]),
    ("WP22252", "could_protect", "Could protect self/family in a future disaster", [1]),
    ("WP22228", "fin_res", "Could cover basic needs a month or more if income lost", [2]),
]
DISC = [
    ("WP22259", "disc_skin", "Experienced discrimination: skin colour"),
    ("WP22260", "disc_religion", "Experienced discrimination: religion"),
    ("WP22261", "disc_nationality", "Experienced discrimination: nationality/ethnicity"),
    ("WP22262", "disc_gender", "Experienced discrimination: gender"),
    ("WP22263", "disc_disability", "Experienced discrimination: disability"),
]
WARN_VARS = ["WP24181", "WP24182", "WP24183", "WP24184", "WP24185", "WP24186", "WP24187", "WP24188"]
GREATEST = ("WP22331", "greatest", "Greatest source of risk to daily safety")
# Continuous 0-1 measures shown as 0-100. worry_index_published is what LRF
# printed for 2025; the *_score family is recomputed from the items asked in
# identical form in every wave, so those are the ones that trend - and they are
# the same columns the other three waves now expose. LRF published no
# experience index for 2025, so experience_score stands in for it here.
INDICES = [
    ("worry_index_published", "Worry Index"),
    ("experience_index", "Experience Index"),
    ("worry_score", "Worry score, 5 common items"),
    ("worry_score_core7", "Worry score, 7 items"),
    ("experience_score", "Experience score, self or someone known"),
    ("experience_score_self", "Experience score, personally"),
    ("experience_score_core7", "Experience score, 7 items"),
    ("resilience_index", "Resilience Index"), ("resilience_idv", "Resilience: individual"),
    ("resilience_hhl", "Resilience: household"), ("resilience_com", "Resilience: community"),
    ("resilience_soc", "Resilience: society"),
]
# Slug the browser uses -> harmonised column. Identical to the other waves, so a
# filter or breakdown chosen on one wave means the same thing on the next.
DEMOG = [
    ("gender", "Gender", "Gender"), ("age_5", "AgeGroups5", "Age (5 groups)"),
    ("education", "Education", "Education level"), ("income_quintiles", "INCOME_5", "Income quintile"),
    ("urban_rural", "Urbanicity", "Urban / rural"), ("employment", "EMP_2010", "Employment status"),
]

# Each wave's published indices are built its own way - waves 1-3 Rasch-weight
# seven items, wave 4 takes a simple mean of ten - so they belong on their own
# wave's page and must not be trended against each other. The flag rides along
# in the manifest so the browser can say so where it matters.
NOT_COMPARABLE = {"worry_index_published", "experience_index"}


def slug_color(code, pos_index):
    if code in SPECIAL_COLOURS:
        return SPECIAL_COLOURS[code]
    return POS_COLOURS[pos_index % len(POS_COLOURS)]

def main():
    cat_vars = ([v for v, *_ in WORRY] + [v for v, *_ in EXPERIENCE] + [v for v, *_ in TRUST]
                + [v for v, *_ in BINARY] + [v for v, *_ in DISC] + [GREATEST[0]]
                + [col for _, col, _ in DEMOG]
                + ["GlobalRegion", "CountryIncomeLevel"] + WARN_VARS)
    idx_vars = [k for k, _ in INDICES]
    print("Reading the harmonised 2025 wave ...")
    df, vl = load_2025()
    need = list(dict.fromkeys(["Country", "COUNTRY_ISO3", "PROJWT"] + cat_vars
                              + [v for v in idx_vars if v != "experience_index"]))
    missing = [c for c in need if c not in df.columns]
    if missing:
        raise SystemExit(f"WRP_2025.parquet is missing {missing}")
    # LRF published no Experience Index for 2025, so the harmonised file leaves
    # the column empty. Rebuild it from the ten experience items - see
    # wrp_indices.py, which reproduces the wave-4 release's own column exactly.
    df["experience_index"] = experience_index_2025(df)
    n = len(df)
    print(f"  {n:,} respondents | {df['Country'].nunique()} countries | "
          f"education coverage {df['Education'].notna().mean()*100:.0f}% | "
          f"experience index coverage {df['experience_index'].notna().mean()*100:.0f}%")

    # ---- country index + iso ----
    cdf = df[["Country", "COUNTRY_ISO3"]].dropna(subset=["Country"]).drop_duplicates("Country")
    cdf = cdf.sort_values("Country")
    countries = [{"name": r.Country, "iso3": (r.COUNTRY_ISO3 if isinstance(r.COUNTRY_ISO3, str) else "")}
                 for r in cdf.itertuples()]
    if any(not c["iso3"] for c in countries):
        raise SystemExit("some 2025 countries have no ISO3 - the map would drop them")
    cindex = {c["name"]: i for i, c in enumerate(countries)}
    country_col = df["Country"].map(cindex).fillna(-1).to_numpy(np.int16)

    # ---- derived dimensions ----
    def derive_any(vars_):
        # float64, not the parquet's nullable Int64: a multi-column .to_numpy()
        # on nullable columns yields an object array of ints and pd.NA, and
        # every comparison below then raises on the NAs.
        sub = df[vars_].astype("float64").to_numpy()
        yes = np.any(sub == 1, axis=1)
        answered = np.any(np.isin(sub, [1, 2]), axis=1)
        out = np.full(n, -1, np.int8)
        out[answered] = 2  # no
        out[yes] = 1       # yes overrides
        return out
    any_warning = derive_any(WARN_VARS)
    any_disc = derive_any([v for v, *_ in DISC])
    YESNO = {1: "Yes", 2: "No"}

    # ---- encode columns ----
    columns = []     # (key, np.array, dtype_tag)
    def add_i8(key, arr):
        columns.append((key, np.asarray(arr, np.int8), "i8"))
    def enc_cat(var):
        a = df[var].astype("float64").to_numpy()
        out = np.full(n, -1, np.int8)
        m = ~np.isnan(a)
        out[m] = a[m].astype(np.int8)
        return out

    add_i8("any_warning", any_warning)
    add_i8("any_form_discrimination", any_disc)
    for var in cat_vars:
        add_i8(var, enc_cat(var))
    # indices -> 0..100 int8
    for k, _ in INDICES:
        a = df[k].to_numpy(dtype=float)
        out = np.full(n, -1, np.int8)
        m = ~np.isnan(a)
        vals = a[m]
        if len(vals) and np.nanmax(vals) <= 1.5:
            vals = vals * 100
        out[m] = np.clip(np.rint(vals), 0, 100).astype(np.int8)
        columns.append((k, out, "i8"))

    # ---- build catalogues ----
    def answers_for(var):
        d = vl.get(var, {})
        codes = sorted(int(c) for c in d.keys())
        subs = [c for c in codes if c < 97]
        out = []
        for c in codes:
            pos = subs.index(c) if c in subs else 0
            out.append({"code": c, "label": d[float(c)] if float(c) in d else d.get(c, str(c)),
                        "color": slug_color(c, pos)})
        return out

    questions, metrics, dimensions = [], [], []

    def add_question(key, var, label):
        questions.append({"key": key, "col": var, "label": label, "answers": answers_for(var)})

    # worry / threat — Very, Very + Somewhat, Not at all
    for var, slug, label in WORRY:
        add_question(slug, var, label)
        short = label.split(' could')[0].split(' a threat')[0]
        is_climate_threat = slug in ("climate", "climate_other")
        not_word = "not a threat" if is_climate_threat else "not worried"
        metrics.append({"key": f"{slug}_very", "col": var, "num": [1],
                        "label": f"{short} — very serious/worried (%)"})
        metrics.append({"key": f"{slug}_concerned", "col": var, "num": [1, 2],
                        "label": f"{short} — very or somewhat (%)"})
        metrics.append({"key": f"{slug}_not", "col": var, "num": [3],
                        "label": f"{short} — {not_word} at all (%)"})
    # experience — personally (self or both), any (self / someone / both), not experienced
    for var, slug, label in EXPERIENCE:
        add_question(slug, var, label)
        metrics.append({"key": f"{slug}_personal", "col": var, "num": [1, 3],
                        "label": f"{label} — personally (%)"})
        metrics.append({"key": slug, "col": var, "num": [1, 2, 3], "label": f"{label} — self or someone (%)"})
        metrics.append({"key": f"{slug}_not", "col": var, "num": [4], "label": f"{label} — not experienced (%)"})
    # trust / care — a lot, a lot + somewhat, not at all
    for var, slug, label in TRUST:
        add_question(slug, var, label)
        metrics.append({"key": f"{slug}_alot", "col": var, "num": [1], "label": f"{label} — a lot (%)"})
        metrics.append({"key": f"{slug}_any", "col": var, "num": [1, 2], "label": f"{label} — a lot or somewhat (%)"})
        metrics.append({"key": f"{slug}_not", "col": var, "num": [3], "label": f"{label} — not at all (%)"})
    # binary
    for var, slug, label, yes in BINARY:
        add_question(slug, var, label)
        metrics.append({"key": f"{slug}_yes", "col": var, "num": yes, "label": f"{label} (%)"})
    # discrimination
    for var, slug, label in DISC:
        add_question(slug, var, label)
        metrics.append({"key": f"{slug}_yes", "col": var, "num": [1], "label": f"{label} (%)"})
    # greatest source
    add_question(GREATEST[1], GREATEST[0], GREATEST[2])
    metrics.append({"key": "greatest_climate", "col": GREATEST[0], "num": [19],
                    "label": "Climate/severe weather named greatest daily risk (%)"})
    # derived any_* questions + metrics
    for key, arr_label in [("any_warning", "Received any disaster warning"),
                           ("any_form_discrimination", "Experienced any form of discrimination")]:
        questions.append({"key": key, "col": key, "label": arr_label,
                          "answers": [{"code": 1, "label": "Yes", "color": POS_COLOURS[0]},
                                      {"code": 2, "label": "No", "color": SPECIAL_COLOURS[98]}]})
        metrics.append({"key": f"{key}_yes", "col": key, "num": [1], "label": f"{arr_label} (%)"})
    # index metrics (continuous mean, displayed as 0–100)
    # Metric slugs match the other three waves exactly: worry_index is the
    # published index, worry_score / experience_score are the recomputed
    # common-item ones. 2025 has no published experience index, so there is no
    # experience_index metric here - experience_score is the measure to use.
    INDEX_SLUG = {"worry_index_published": "worry_index"}
    for k, label in INDICES:
        rec = {"key": INDEX_SLUG.get(k, k), "col": k, "kind": "mean",
               "label": f"{label} (0-100)"}
        if k in NOT_COMPARABLE:
            rec["comparable"] = False
        metrics.append(rec)

    # ---- dimensions (filter + breakdown) ----
    def dim_cats(var):
        return [{"code": a["code"], "label": a["label"]} for a in answers_for(var)]
    dimensions.append({"key": "countrynew", "col": "country", "label": "Country", "type": "country"})
    dimensions.append({"key": "GlobalRegion", "col": "GlobalRegion", "label": "Global region", "cats": dim_cats("GlobalRegion")})
    dimensions.append({"key": "CountryIncome", "col": "CountryIncomeLevel", "label": "Country income group", "cats": dim_cats("CountryIncomeLevel")})
    for key, var, label in DEMOG:
        dimensions.append({"key": key, "col": var, "label": label, "cats": dim_cats(var)})
    # Question-based filter dimensions — matched to the canonical 5×4 grid
    # ordering used by the legacy waves' build_explorer_wave.py.
    for var, slug, label in [
        # — climate / threat —
        ("WP20719", "climate_change_threat",     "Climate change a threat"),
        ("WP24225", "most_other_people_climate", "Most others: climate threat"),
        # — greatest source of risk —
        ("WP22331", "greatest_source",           "Greatest source of risk"),
        # — worry items as quick-look filters —
        ("WP20720", "worry_food",                "Worried about food"),
        ("WP20721", "worry_water",               "Worried about water"),
        ("WP20722", "worry_crime",               "Worried about violent crime"),
        ("WP20723", "worry_weather",             "Worried about severe weather"),
        ("WP20726", "worry_mental",              "Worried about mental health"),
        # — disaster experience / preparedness —
        ("WP24213", "impacted_disaster",         "Impacted by a disaster"),
        ("WP24198", "government_prepared",       "Government well prepared"),
        ("WP24215", "able_to_take_action",       "Able to act on warning"),
        ("WP22252", "could_protect",             "Could protect self/family"),
        ("WP22228", "fin_res",                   "Financial resilience"),
        ("WP23345", "plan_known",                "Household disaster plan"),
        # — trust / care —
        ("WP22231_ALL", "govt_cares",            "Government / authorities care"),
        ("WP22232", "neighbours_care",           "Neighbours care"),
    ][:11]:   # cap at 11 content slots so total = country + 8 demog + 11 = 20
        dimensions.append({"key": slug, "col": var, "label": label, "cats": dim_cats(var)})

    # ---- catalogue sanity ----
    for field, items in (("question", questions), ("metric", metrics),
                         ("dimension", dimensions)):
        keys = [x["key"] for x in items]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            raise SystemExit(f"duplicate {field} keys {dupes}")

    # ---- weight ----
    if df["PROJWT"].isna().any():
        raise SystemExit(f"{int(df['PROJWT'].isna().sum()):,} respondents have no PROJWT")
    weight = df["PROJWT"].to_numpy(np.float32)

    # ---- pack binary (column-major) ----
    blob = bytearray()
    manifest_cols = []
    def append(key, arr, tag):
        nonlocal blob
        off = len(blob)
        b = arr.tobytes()
        blob += b
        manifest_cols.append({"key": key, "dtype": tag, "off": off, "len": int(arr.shape[0])})
    # country first
    append("country", country_col, "i16")
    for key, arr, tag in columns:
        append(key, arr, tag)
    woff = len(blob); blob += weight.tobytes()

    manifest = {
        "n": int(n),
        "weight": {"off": woff, "len": int(n), "dtype": "f32"},
        "columns": manifest_cols,
        "countries": countries,
        "dimensions": dimensions,
        "questions": questions,
        "metrics": metrics,
    }
    with open(os.path.join(DATA, "wrp_explorer.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, separators=(",", ":"), ensure_ascii=False)
    with open(os.path.join(DATA, "wrp_explorer.bin"), "wb") as f:
        f.write(blob)
    with gzip.open(os.path.join(DATA, "wrp_explorer.bin.gz"), "wb", compresslevel=9) as f:
        f.write(blob)

    jsz = os.path.getsize(os.path.join(DATA, "wrp_explorer.json"))
    bsz = os.path.getsize(os.path.join(DATA, "wrp_explorer.bin"))
    gsz = os.path.getsize(os.path.join(DATA, "wrp_explorer.bin.gz"))
    print(f"  json {jsz/1024:.0f} KB | bin {bsz/1e6:.2f} MB | bin.gz {gsz/1e6:.2f} MB")
    print(f"  {len(questions)} questions, {len(metrics)} metrics, {len(dimensions)} dimensions, {len(countries)} countries")

    # ---- verification (metric = num / all-non-missing, weighted) ----
    def metric_pct(country, var, num):
        a = df[df["Country"] == country]
        w = a["PROJWT"].to_numpy(); v = a[var].astype("float64").to_numpy()
        den = w[~np.isnan(v)].sum()
        nu = w[np.isin(v, num)].sum()
        return nu / den * 100 if den else float("nan")
    print("  verify climate_very:", {c: round(metric_pct(c, "WP20719", [1]), 1) for c in ["Malawi", "Costa Rica", "Portugal"]},
          "(target 85.6 / 76.2 / 65.8)")
    print("  verify climate_other_very:", {c: round(metric_pct(c, "WP24225", [1]), 1) for c in ["Malawi", "Costa Rica"]},
          "(target 77.8 / 49.3)")

if __name__ == "__main__":
    main()
