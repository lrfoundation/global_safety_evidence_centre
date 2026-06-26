#!/usr/bin/env python3
"""
Build per-wave World Risk Poll explorer datasets from the harmonised
trended file. Mirrors build_explorer_data.py's output shape so the
browser engine can load any wave without code changes.

Source for every legacy wave + the cross-wave view:
    data/trended_wrp.sav  (Gallup's harmonised file, Year ∈ {2019,2021,2023})

Run:
    python scripts/build_explorer_wave.py --wave 2019
    python scripts/build_explorer_wave.py --wave 2021
    python scripts/build_explorer_wave.py --wave 2023
    python scripts/build_explorer_wave.py --wave trended      # all years
    python scripts/build_explorer_wave.py --wave all          # all four

Writes (per wave):
    data/wrp_explorer_<wave>.json
    data/wrp_explorer_<wave>.bin
    data/wrp_explorer_<wave>.bin.gz
"""
import argparse, json, gzip, os, sys
import numpy as np
import pyreadstat

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))
SRC  = os.path.join(DATA, "trended_wrp.sav")

# ---- WRP data-viz palette (matches build_explorer_data.py / Chart Studio) ----
POS_COLOURS    = ["#e3076e", "#00a7b3", "#00785c", "#f07800", "#7a50de"]
SPECIAL_COLOURS = {97: "#d8d8de", 98: "#bdbdbd", 99: "#0d2240"}

# ---- which waves the trended file actually covers ----
WAVE_CONFIG = {
    "2019":    {"year": 2019, "out": "wrp_explorer_2019",    "include_year_dim": False},
    "2021":    {"year": 2021, "out": "wrp_explorer_2021",    "include_year_dim": False},
    "2023":    {"year": 2023, "out": "wrp_explorer_2023",    "include_year_dim": False},
    "trended": {"year": None, "out": "wrp_explorer_trended", "include_year_dim": True},
}

# ---- catalogue: slug → (trended var, kind, label) ----
# kind controls which metrics get auto-generated:
#   worry  → 1=Very, 2=Somewhat, 3=Not (very, concerned [1+2], not [3])
#   exp    → 1=personally, 2=know someone, 3=both, 4=No (personal[1+3], any[1+2+3], not[4])
#   trust  → 1=A lot, 2=Somewhat, 3=Not at all (alot, any[1+2], not[3])
#   binary → user-specified yes codes
#   single → single yes code (1)
#   greatest → categorical (no derived metrics; single climate-named metric)
#   index  → numeric 0–1 / 0–100
QUESTIONS = [
    # ---- worry / threat ----
    ("climate",             "WP20719", "worry",  "Climate change a threat to country (next 20 yrs)"),
    ("food",                "WP20720", "worry",  "Worried food could cause serious harm"),
    ("water",               "WP20721", "worry",  "Worried water could cause serious harm"),
    ("crime",               "WP20722", "worry",  "Worried violent crime could cause serious harm"),
    ("weather",             "WP20723", "worry",  "Worried severe weather could cause serious harm"),
    ("mental_health",       "WP20726", "worry",  "Worried mental health could cause serious harm"),
    ("traffic",             "WP22213", "worry",  "Worried traffic could cause serious harm"),
    ("work",                "WP22214", "worry",  "Worried work could cause serious harm"),
    # ---- experience (post-2020, 4-code: 1=personally / 2=know someone / 3=both / 4=No) ----
    ("exp_food",            "WP22442", "exp",    "Experienced harm: eating food"),
    ("exp_water",           "WP22443", "exp",    "Experienced harm: drinking water"),
    ("exp_crime",           "WP22444", "exp",    "Experienced harm: violent crime"),
    ("exp_weather",         "WP22445", "exp",    "Experienced harm: severe weather"),
    ("exp_traffic",         "WP22446", "exp",    "Experienced harm: traffic"),
    ("exp_mental_health",   "WP22447", "exp",    "Experienced harm: mental health"),
    ("exp_work",            "WP22448", "exp",    "Experienced harm: work"),
    # ---- bridge experience vars (Gallup-harmonised, binary 1=Yes / 2=No — span 2019+) ----
    ("exp_food_trended",    "harm_food_trended",          "single", "Experienced harm: eating food (trended)"),
    ("exp_water_trended",   "harm_water_trended",         "single", "Experienced harm: drinking water (trended)"),
    ("exp_crime_trended",   "harm_crime_trended",         "single", "Experienced harm: violent crime (trended)"),
    ("exp_weather_trended", "harm_weather_trended",       "single", "Experienced harm: severe weather (trended)"),
    ("exp_mental_trended",  "harm_mental_health_trended", "single", "Experienced harm: mental health (trended)"),
    # ---- trust / care ----
    ("govt_cares",          "WP22231", "trust",  "Government cares about your wellbeing"),
    ("authorities_care",    "WP22469", "trust",  "Authorities care about your wellbeing"),
    ("neighbours_care",     "WP22232", "trust",  "Neighbours care about your wellbeing"),
    # ---- disaster / resilience ----
    ("impacted_disaster_t", "disaster_experienced", "single", "Experienced a disaster in past 5 yrs (trended)"),
    ("plan_known_t",        "disaster_plan",        "single", "Household disaster plan known by all (trended)"),
    ("could_protect",       "WP22252", "single",  "Could protect self/family in a future disaster"),
    ("fin_res",             "WP22228", "binary",  "Could cover basic needs a month or more if income lost",
                            [2]),   # code 2 = "a month or more"
    # ---- discrimination ----
    ("disc_skin",           "WP22259", "single", "Experienced discrimination: skin colour"),
    ("disc_religion",       "WP22260", "single", "Experienced discrimination: religion"),
    ("disc_nationality",    "WP22261", "single", "Experienced discrimination: nationality/ethnicity"),
    ("disc_gender",         "WP22262", "single", "Experienced discrimination: gender"),
    ("disc_disability",     "WP22263", "single", "Experienced discrimination: disability"),
    # ---- greatest source (different value codes across waves) ----
    ("greatest",            "WP22331", "greatest", "Greatest source of risk to daily safety"),
    # WP20713 only exists in 2019, with its own coding (climate code = 16, not 19)
    ("greatest_2019",       "WP20713", "greatest_2019", "Greatest source of risk to daily safety (2019)"),
    # ---- a 2019-only "safer than five years ago" item ----
    ("safer_5yr",           "WP20711", "worry",   "Feel safer than five years ago"),
    # ---- indices ----
    ("worry_index",         "Worried.Index",     "index", "Worry Index (0–100)"),
    ("experience_index",    "experience_index",  "index", "Experience Index (0–100)"),
    ("resilience_index",    "resilience_index",  "index", "Resilience Index (0–100)"),
    ("resilience_idv",      "resilience_idv_0_100_scale", "index", "Resilience: individual (0–100)"),
    ("resilience_hhl",      "resilience_hhl_0_100_scale", "index", "Resilience: household (0–100)"),
    ("resilience_com",      "resilience_com_0_100_scale", "index", "Resilience: community (0–100)"),
    ("resilience_soc",      "resilience_soc_0_100_scale", "index", "Resilience: societal (0–100)"),
]

# Harmonised demographic + grouping columns (all live in trended_wrp.sav under stable names).
# (filter_key, source column, label)
DEMOG = [
    ("gender",           "Gender",                  "Gender"),
    ("age_5",            "AgeGroups5",              "Age (5 groups)"),
    ("education",        "Education",               "Education level"),
    ("income_quintiles", "INCOME_5",                "Income quintile"),
    ("urban_rural",      "Urbanicity",              "Urban / rural"),
    ("employment",       "EMP_2010",                "Employment status"),
    ("GlobalRegion",     "GlobalRegion",            "Global region"),
    ("CountryIncome",    "CountryIncomeLevel2023", "Country income group"),
]

WEIGHT_COL  = "PROJWT"
COUNTRY_COL = "Country"            # long display name
ISO3_COL    = "COUNTRY_ISO3"
YEAR_COL    = "Year"

# Which raw .sav columns we actually need to read (smaller read = faster build)
def required_columns():
    cols = {WEIGHT_COL, COUNTRY_COL, ISO3_COL, YEAR_COL, "WPID_RANDOM"}
    for _, var, _, *_ in QUESTIONS:
        cols.add(var)
    for _, src, _ in DEMOG:
        cols.add(src)
    return list(cols)


def slug_color(code, pos_index):
    if code in SPECIAL_COLOURS:
        return SPECIAL_COLOURS[code]
    return POS_COLOURS[pos_index % len(POS_COLOURS)]


def encode_cat(arr):
    """numeric column → Int8, -1 = missing (preserve original survey codes)."""
    out = np.full(arr.shape[0], -1, np.int8)
    m = ~np.isnan(arr)
    out[m] = arr[m].astype(np.int16).clip(-128, 127).astype(np.int8)
    return out


def encode_index(arr):
    """0..1 (or 0..100) numeric → Int8 0..100, -1 = missing."""
    out = np.full(arr.shape[0], -1, np.int8)
    m = ~np.isnan(arr)
    vals = arr[m]
    # auto-detect scale: if max ≤ 1.5, assume 0..1; else 0..100
    if len(vals) and np.nanmax(vals) <= 1.5:
        vals = vals * 100
    out[m] = np.clip(np.rint(vals), 0, 100).astype(np.int8)
    return out


def build_for(wave, df, meta):
    cfg = WAVE_CONFIG[wave]
    yr = cfg["year"]
    if yr is not None:
        df = df[df[YEAR_COL] == yr].reset_index(drop=True)
    n = len(df)
    if n == 0:
        raise SystemExit(f"wave {wave}: no rows after Year=={yr} filter")
    print(f"\n=== wave {wave}: {n:,} rows ===")

    vl = meta.variable_value_labels
    lab = meta.column_names_to_labels

    # ---- country index ----
    cdf = (df[[COUNTRY_COL, ISO3_COL]].dropna(subset=[COUNTRY_COL])
                                       .drop_duplicates(COUNTRY_COL)
                                       .sort_values(COUNTRY_COL))
    countries = [{"name": r[0], "iso3": (r[1] if isinstance(r[1], str) else "")}
                 for r in cdf.itertuples(index=False)]
    cindex = {c["name"]: i for i, c in enumerate(countries)}
    country_col = df[COUNTRY_COL].map(cindex).fillna(-1).to_numpy(np.int16)
    print(f"  {len(countries)} countries")

    # ---- value label helper for a given source variable ----
    def answers_for(var):
        d = vl.get(var, {})
        codes = sorted(int(c) for c in d.keys())
        subs = [c for c in codes if c < 97]
        out = []
        for c in codes:
            pos = subs.index(c) if c in subs else 0
            out.append({"code": c, "label": d.get(float(c), d.get(c, str(c))),
                        "color": slug_color(c, pos)})
        return out

    # ---- encode each question column + emit Q / metric entries ----
    columns = []     # (key, arr, dtype)
    questions, metrics = [], []
    drops = []

    def add_q(slug, var, label):
        questions.append({"key": slug, "col": var, "label": label, "answers": answers_for(var)})

    def short_label(slug, label, kind):
        if kind == "worry":
            return label.split(" could")[0].split(" a threat")[0]
        return label

    for slug, var, kind, *rest in QUESTIONS:
        if var not in df.columns:
            drops.append((slug, var, "var not in trended file"))
            continue
        coverage = df[var].notna().mean() * 100
        if coverage < 0.5:
            drops.append((slug, var, f"only {coverage:.1f}% non-missing in this wave"))
            continue

        if kind == "index":
            arr = encode_index(df[var].to_numpy())
            columns.append((var, arr, "i8"))
            metrics.append({"key": slug, "col": var, "kind": "mean",
                            "label": rest[0] if rest else slug})
            continue

        arr = encode_cat(df[var].to_numpy())
        columns.append((var, arr, "i8"))
        add_q(slug, var, rest[0] if rest else label_for(var, lab))

        short = short_label(slug, rest[0] if rest else "", kind)
        if kind == "worry":
            is_climate_threat = slug in ("climate", "climate_other")
            not_word = "not a threat" if is_climate_threat else "not worried"
            metrics.append({"key": f"{slug}_very",       "col": var, "num": [1],   "label": f"{short} — very serious/worried (%)"})
            metrics.append({"key": f"{slug}_concerned", "col": var, "num": [1, 2], "label": f"{short} — very or somewhat (%)"})
            metrics.append({"key": f"{slug}_not",        "col": var, "num": [3],   "label": f"{short} — {not_word} at all (%)"})
        elif kind == "exp":
            metrics.append({"key": f"{slug}_personal", "col": var, "num": [1, 3],     "label": f"{short} — personally (%)"})
            metrics.append({"key": slug,                 "col": var, "num": [1, 2, 3], "label": f"{short} — self or someone (%)"})
            metrics.append({"key": f"{slug}_not",      "col": var, "num": [4],         "label": f"{short} — not experienced (%)"})
        elif kind == "trust":
            metrics.append({"key": f"{slug}_alot", "col": var, "num": [1],    "label": f"{short} — a lot (%)"})
            metrics.append({"key": f"{slug}_any",   "col": var, "num": [1, 2], "label": f"{short} — a lot or somewhat (%)"})
            metrics.append({"key": f"{slug}_not",   "col": var, "num": [3],    "label": f"{short} — not at all (%)"})
        elif kind == "binary":
            yes = rest[1] if len(rest) > 1 else [1]
            metrics.append({"key": f"{slug}_yes", "col": var, "num": yes, "label": f"{short} (%)"})
        elif kind == "single":
            metrics.append({"key": f"{slug}_yes", "col": var, "num": [1], "label": f"{short} (%)"})
        elif kind == "greatest":
            # 2021+ coding: climate/severe weather = 19
            metrics.append({"key": "greatest_climate", "col": var, "num": [19],
                            "label": "Climate/severe weather named greatest daily risk (%)"})
        elif kind == "greatest_2019":
            # 2019 coding: climate/disasters/weather = 16
            metrics.append({"key": "greatest_climate_2019", "col": var, "num": [16],
                            "label": "Climate/natural disasters named greatest daily risk (%, 2019 coding)"})

    # ---- dimensions (filter + breakdown) ----
    dimensions = []
    dim_payload = {}
    dimensions.append({"key": "countrynew", "col": "country", "label": "Country", "type": "country"})

    for key, src, label in DEMOG:
        if src not in df.columns:
            print(f"  ! dimension {key}: source col '{src}' missing — skipping")
            continue
        arr = encode_cat(df[src].to_numpy())
        # If the harmonised demog isn't actually populated for this wave (e.g. AgeGroups5
        # in 2019), drop it from the page rather than show an empty filter.
        if (arr >= 0).sum() < 0.1 * n:
            print(f"  ! dimension {key} ({src}): <10% populated in this wave — skipping")
            continue
        columns.append((src, arr, "i8"))
        dimensions.append({"key": key, "col": src, "label": label,
                           "cats": [{"code": a["code"], "label": a["label"]}
                                    for a in answers_for(src)]})

    # ---- year as a dim, for the cross-wave page ----
    if cfg["include_year_dim"]:
        yr_arr = df[YEAR_COL].fillna(-1).astype(int).to_numpy()
        yr_codes = sorted(int(y) for y in set(yr_arr) if y > 0)
        out = np.full(n, -1, np.int8)
        for code in yr_codes:
            out[yr_arr == code] = code - 2000   # 2019 → 19, 2021 → 21, …
        columns.append(("year_code", out, "i8"))
        dimensions.append({"key": "year", "col": "year_code", "label": "Survey year",
                           "cats": [{"code": y - 2000, "label": str(y)} for y in yr_codes]})

    # ---- weight ----
    if WEIGHT_COL not in df.columns:
        raise SystemExit(f"wave {wave}: {WEIGHT_COL} not in source file")
    weight = df[WEIGHT_COL].fillna(0).to_numpy(np.float32)

    # ---- pack binary (column-major) ----
    blob = bytearray()
    manifest_cols = []

    def append_col(key, arr, tag):
        nonlocal blob
        off = len(blob); blob += arr.tobytes()
        manifest_cols.append({"key": key, "dtype": tag, "off": off, "len": int(arr.shape[0])})

    append_col("country", country_col, "i16")
    seen = set()
    for key, arr, tag in columns:
        if key in seen:
            continue
        seen.add(key)
        append_col(key, arr, tag)
    woff = len(blob); blob += weight.tobytes()

    manifest = {
        "wave": wave,
        "n": int(n),
        "weight": {"off": woff, "len": int(n), "dtype": "f32"},
        "columns": manifest_cols,
        "countries": countries,
        "dimensions": dimensions,
        "questions": questions,
        "metrics":   metrics,
    }
    out_base = os.path.join(DATA, cfg["out"])
    with open(out_base + ".json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, separators=(",", ":"), ensure_ascii=False)
    with open(out_base + ".bin", "wb") as f:
        f.write(blob)
    with gzip.open(out_base + ".bin.gz", "wb", compresslevel=9) as f:
        f.write(blob)

    print(f"  {len(questions)} questions, {len(metrics)} metrics, "
          f"{len(dimensions)} dimensions, {len(countries)} countries")
    print(f"  json {os.path.getsize(out_base+'.json')/1024:.0f} KB | "
          f"bin {os.path.getsize(out_base+'.bin')/1e6:.2f} MB | "
          f"gz {os.path.getsize(out_base+'.bin.gz')/1e6:.2f} MB")
    if drops:
        print(f"  dropped {len(drops)} catalogue items (not present in this wave):")
        for slug, var, why in drops:
            print(f"    - {slug:24s} ({var}): {why}")


def label_for(var, lab):
    return lab.get(var, var) or var


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wave", required=True, choices=list(WAVE_CONFIG.keys()) + ["all"])
    args = ap.parse_args()

    print(f"Reading {os.path.basename(SRC)} ...")
    df, meta = pyreadstat.read_sav(SRC, usecols=required_columns())
    print(f"  {len(df):,} total rows  ({df[YEAR_COL].dropna().astype(int).value_counts().sort_index().to_dict()})")

    waves = list(WAVE_CONFIG.keys()) if args.wave == "all" else [args.wave]
    for w in waves:
        build_for(w, df, meta)


if __name__ == "__main__":
    main()
