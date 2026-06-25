#!/usr/bin/env python3
"""
Build the World Risk Poll 2025 Data Explorer dataset.

Reads tools/data/wrp_25.sav (SPSS microdata, PROJWT-weighted) and emits a compact
columnar dataset the browser explorer loads once and aggregates live:

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
"""
import json, gzip, struct, os, sys
import numpy as np
import pyreadstat

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))
SAV = os.path.join(DATA, "wrp_25.sav")

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
TRUST = [  # 1=a lot 2=somewhat 3=not at all 98 99
    ("WP22231", "govt_cares", "Government cares about your wellbeing"),
    ("WP22469", "authorities_care", "Authorities care about your wellbeing"),
    ("WP22232", "neighbours_care", "Neighbours care about your wellbeing"),
]
BINARY = [  # (var, slug, label, yes_codes) — 1=Yes 2=No ...
    ("WP24213", "impacted_disaster", "Impacted by a disaster (past 5 yrs)", [1]),
    ("WP24198", "govt_prepared", "National government well prepared for a disaster", [1]),
    ("WP24386", "govt_power_prepared", "Government in power well prepared for a disaster", [1]),
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
INDICES = [
    ("worry_index", "Worry Index"), ("experience_index", "Experience Index"),
    ("resilience_index", "Resilience Index"), ("resilience_idv", "Resilience: individual"),
    ("resilience_hhl", "Resilience: household"), ("resilience_com", "Resilience: community"),
    ("resilience_soc", "Resilience: society"),
]
# dimensions usable as filter + breakdown: (key, var, label)
DEMOG = [
    ("gender", "WP1219", "Gender"), ("age_5", "WP1220RECODED_1", "Age (5 groups)"),
    ("education", "WP3117", "Education level"), ("income_quintiles", "INCOME_5", "Income quintile"),
    ("urban_rural", "DEGURBA", "Urban / rural"), ("employment", "EMP_2010", "Employment status"),
]

def slug_color(code, pos_index):
    if code in SPECIAL_COLOURS:
        return SPECIAL_COLOURS[code]
    return POS_COLOURS[pos_index % len(POS_COLOURS)]

def main():
    cat_vars = ([v for v, *_ in WORRY] + [v for v, *_ in EXPERIENCE] + [v for v, *_ in TRUST]
                + [v for v, *_ in BINARY] + [v for v, *_ in DISC] + [GREATEST[0]]
                + ["WP1219", "WP1220RECODED_1", "INCOME_5", "DEGURBA", "EMP_2010",
                   "RegionLRF", "wbi"] + WARN_VARS)
    idx_vars = [k for k, _ in INDICES]
    need = list(dict.fromkeys(["WPID", "COUNTRYNEW", "COUNTRY_ISO3", "PROJWT"] + cat_vars + idx_vars))
    print(f"Reading {len(need)} columns from wrp_25.sav ...")
    df, meta = pyreadstat.read_sav(SAV, usecols=need)
    n = len(df)
    vl = meta.variable_value_labels
    lab = meta.column_names_to_labels
    # Blend in full-coverage education from the fuller release: WP3117 covers all 140
    # countries, whereas wrp_25's own WP9811 only covers 49. Joined per respondent on WPID.
    FULL = os.path.join(DATA, "Lloyds_2025_022026_w_projection_weight.sav")
    edu, _ = pyreadstat.read_sav(FULL, usecols=["WPID", "WP3117"])
    df = df.merge(edu, on="WPID", how="left")
    vl["WP3117"] = {1.0: "Elementary or less", 2.0: "Secondary / some tertiary", 3.0: "Completed tertiary (degree)"}
    lab["WP3117"] = "Education level"
    print(f"  {n:,} respondents | education (WP3117) coverage {df.WP3117.isin([1,2,3]).mean()*100:.0f}%, "
          f"{df.groupby('COUNTRY_ISO3').WP3117.apply(lambda s: s.isin([1,2,3]).any()).sum()} countries")

    # ---- country index + iso ----
    cdf = df[["COUNTRYNEW", "COUNTRY_ISO3"]].dropna(subset=["COUNTRYNEW"]).drop_duplicates("COUNTRYNEW")
    cdf = cdf.sort_values("COUNTRYNEW")
    countries = [{"name": r.COUNTRYNEW, "iso3": (r.COUNTRY_ISO3 if isinstance(r.COUNTRY_ISO3, str) else "")}
                 for r in cdf.itertuples()]
    cindex = {c["name"]: i for i, c in enumerate(countries)}
    country_col = df["COUNTRYNEW"].map(cindex).fillna(-1).to_numpy(np.int16)

    # ---- derived dimensions ----
    def derive_any(vars_):
        sub = df[vars_].to_numpy()
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
        a = df[var].to_numpy()
        out = np.full(n, -1, np.int8)
        m = ~np.isnan(a)
        out[m] = a[m].astype(np.int8)
        return out

    add_i8("any_warning", any_warning)
    add_i8("any_form_discrimination", any_disc)
    for var in cat_vars:
        add_i8(var, enc_cat(var))
    # blended education (WP3117): keep substantive codes 1/2/3, drop DK(4)/RF(5) -> missing
    edu_arr = np.full(n, -1, np.int8); ev = df["WP3117"].to_numpy(); em = np.isin(ev, [1, 2, 3]); edu_arr[em] = ev[em].astype(np.int8)
    columns.append(("WP3117", edu_arr, "i8"))
    # indices -> 0..100 int8
    for k, _ in INDICES:
        a = df[k].to_numpy()
        out = np.full(n, -1, np.int8)
        m = ~np.isnan(a)
        out[m] = np.clip(np.rint(a[m] * 100), 0, 100).astype(np.int8)
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

    # worry / threat
    for var, slug, label in WORRY:
        add_question(slug, var, label)
        metrics.append({"key": f"{slug}_very", "col": var, "num": [1],
                        "label": f"{label.split(' could')[0].split(' a threat')[0]} — very serious/worried (%)"})
        metrics.append({"key": f"{slug}_concerned", "col": var, "num": [1, 2],
                        "label": f"{label.split(' could')[0].split(' a threat')[0]} — very or somewhat (%)"})
    # experience
    for var, slug, label in EXPERIENCE:
        add_question(slug, var, label)
        metrics.append({"key": slug, "col": var, "num": [1, 2, 3], "label": f"{label} (self or someone) (%)"})
    # trust
    for var, slug, label in TRUST:
        add_question(slug, var, label)
        metrics.append({"key": f"{slug}_alot", "col": var, "num": [1], "label": f"{label} — a lot (%)"})
        metrics.append({"key": f"{slug}_any", "col": var, "num": [1, 2], "label": f"{label} — a lot or somewhat (%)"})
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
    # index metrics (continuous mean)
    for k, label in INDICES:
        metrics.append({"key": k, "col": k, "kind": "mean", "label": f"{label} (mean, 0–1)"})

    # ---- dimensions (filter + breakdown) ----
    def dim_cats(var):
        return [{"code": a["code"], "label": a["label"]} for a in answers_for(var)]
    dimensions.append({"key": "countrynew", "col": "country", "label": "Country", "type": "country"})
    dimensions.append({"key": "GlobalRegion", "col": "RegionLRF", "label": "Global region", "cats": dim_cats("RegionLRF")})
    dimensions.append({"key": "CountryIncome", "col": "wbi", "label": "Country income group", "cats": dim_cats("wbi")})
    for key, var, label in DEMOG:
        dimensions.append({"key": key, "col": var, "label": label, "cats": dim_cats(var)})
    # question-based filter dimensions
    for var, slug, label, *_ in ([("WP24213", "impacted_by_disaster", "Impacted by a disaster", None),
                                  ("WP24215", "able_to_take_action", "Able to act on warning", None),
                                  ("WP24198", "government_prepared", "Government well prepared", None),
                                  ("WP22228", "fin_res", "Financial resilience", None),
                                  ("WP22331", "greatest_source", "Greatest source of risk", None),
                                  ("WP24225", "most_other_people_climate", "Most others: climate threat", None),
                                  ("WP20719", "climate_change_threat", "Climate change a threat", None)]):
        dimensions.append({"key": slug, "col": var, "label": label, "cats": dim_cats(var)})
    dimensions.append({"key": "any_warning", "col": "any_warning", "label": "Received any warning",
                       "cats": [{"code": 1, "label": "Yes"}, {"code": 2, "label": "No"}]})
    dimensions.append({"key": "any_form_discrimination", "col": "any_form_discrimination", "label": "Any discrimination",
                       "cats": [{"code": 1, "label": "Yes"}, {"code": 2, "label": "No"}]})

    # ---- weight ----
    weight = df["PROJWT"].fillna(0).to_numpy(np.float32)

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
        a = df[df.COUNTRYNEW == country]
        w = a["PROJWT"].to_numpy(); v = a[var].to_numpy()
        den = w[~np.isnan(v)].sum()
        nu = w[np.isin(v, num)].sum()
        return nu / den * 100 if den else float("nan")
    print("  verify climate_very:", {c: round(metric_pct(c, "WP20719", [1]), 1) for c in ["Malawi", "Costa Rica", "Portugal"]},
          "(target 85.6 / 76.2 / 65.8)")
    print("  verify climate_other_very:", {c: round(metric_pct(c, "WP24225", [1]), 1) for c in ["Malawi", "Costa Rica"]},
          "(target 77.8 / 49.3)")

if __name__ == "__main__":
    main()
