#!/usr/bin/env python3
"""
Build per-wave World Risk Poll explorer datasets.

For each wave we read its OWN .sav (so every question that wave carries is
exposed), blend PROJWT in from the trended file for waves that lack it, and
emit a manifest the existing browser engine can load.

Sources:
    data/19_wrp.sav         2019 wave (227 cols)
    data/21_wrp.sav         2019+2021 — we filter to Year==2021
    data/23_wrp.sav         2023 wave (63 cols, has PROJWT)
    data/trended_wrp.sav    Cross-wave file (2019-2023) — used as the trended
                            page source AND as the source of PROJWT for waves
                            that lack it; we also append wrp_25.sav onto it.
    data/wrp_25.sav         2025 (kept on its own pipeline in
                            build_explorer_data.py; concatenated onto trended
                            here as Year==2025).

Run:
    python scripts/build_explorer_wave.py --wave 2019
    python scripts/build_explorer_wave.py --wave 2021
    python scripts/build_explorer_wave.py --wave 2023
    python scripts/build_explorer_wave.py --wave trended
    python scripts/build_explorer_wave.py --wave all

Outputs (per wave):
    data/wrp_explorer_<wave>.json
    data/wrp_explorer_<wave>.bin
    data/wrp_explorer_<wave>.bin.gz
"""
import argparse, json, gzip, os, re
import numpy as np
import pandas as pd
import pyreadstat

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

# ---- WRP data-viz palette (must match build_explorer_data.py / Chart Studio) ----
POS_COLOURS    = ["#e3076e", "#00a7b3", "#00785c", "#f07800", "#7a50de"]
SPECIAL_COLOURS = {97: "#d8d8de", 98: "#bdbdbd", 99: "#0d2240"}

# ---------------------------------------------------------------------------
# WAVE CONFIG — each wave knows where its data lives, which year (if any) it
# needs to be filtered to, and what its demographic columns are called.
# ---------------------------------------------------------------------------
def cfg(sav, *, year_filter=None, country_col="Country", iso3_col="COUNTRY_ISO3",
        weight_col="PROJWT", blend_projwt_from=None, demog=None, out=None,
        include_year_dim=False, append_wrp25=False, label=None, lede=None):
    return {"sav": sav, "year_filter": year_filter, "country_col": country_col,
            "iso3_col": iso3_col, "weight_col": weight_col,
            "blend_projwt_from": blend_projwt_from, "demog": demog or [],
            "out": out, "include_year_dim": include_year_dim,
            "append_wrp25": append_wrp25, "label": label, "lede": lede}

# Each demographic = (slug,  source col,  user-facing label).
# Slugs are the harmonised browser keys ('gender', 'age_5', …) the JS engine
# expects so the same code renders every wave.
# Order: country (auto, position 1) → region → country-income → gender → age →
# education → income quintile → urban/rural → employment → wave-content.
DEMOG_2019 = [
    ("GlobalRegion",     "RegionReport", "Global region"),
    ("CountryIncome",    "WBI",          "Country income group"),
    ("gender",           "WP1219",       "Gender"),
    ("age_5",            "AgeGroups",    "Age (groups)"),
    ("education",        "Education",    "Education level"),
    ("income_quintiles", "INCOME_5",     "Income quintile"),
    ("urban_rural",      "Urbanicity",   "Urban / rural"),
    ("employment",       "EMP_2010",     "Employment status"),
]
DEMOG_2021 = [
    ("GlobalRegion",     "GlobalRegion",            "Global region"),
    ("CountryIncome",    "CountryIncomeLevel2021", "Country income group"),
    ("gender",           "Gender",                  "Gender"),
    ("age_5",            "AgeGroups4",              "Age (4 groups)"),
    ("education",        "Education",               "Education level"),
    ("income_quintiles", "INCOME_5",                "Income quintile"),
    ("urban_rural",      "Urbanicity",              "Urban / rural"),
    ("employment",       "EMP_2010",                "Employment status"),
]
DEMOG_2023 = [
    ("GlobalRegion",     "GlobalRegion",            "Global region"),
    ("CountryIncome",    "CountryIncomeLevel2023", "Country income group"),
    ("gender",           "Gender",                  "Gender"),
    ("age_5",            "AgeGroups5",              "Age (5 groups)"),
    ("education",        "Education",               "Education level"),
    ("income_quintiles", "INCOME_5",                "Income quintile"),
    ("urban_rural",      "Urbanicity",              "Urban / rural"),
    ("employment",       "EMP_2010",                "Employment status"),
]
# Trended/2025-appended share the same naming (post-rename) as 2023.
DEMOG_TRENDED = DEMOG_2023

WAVE_CONFIG = {
    "2019":    cfg("19_wrp.sav", country_col="countrynew", iso3_col=None,
                   weight_col=None, blend_projwt_from=("trended_wrp.sav", 2019),
                   demog=DEMOG_2019, out="wrp_explorer_2019",
                   label="2019",  lede="Explore the 2019 World Risk Poll — every question Lloyd's Register Foundation fielded that year, filterable by demographics. All figures are population-weighted."),
    "2021":    cfg("21_wrp.sav", year_filter=("Year", 2021),
                   weight_col="PROJWT_2021",
                   demog=DEMOG_2021, out="wrp_explorer_2021",
                   label="2021",  lede="Explore the 2021 World Risk Poll across worry, experienced harm, disaster resilience, trust and discrimination. All figures are population-weighted."),
    "2023":    cfg("23_wrp.sav",
                   demog=DEMOG_2023, out="wrp_explorer_2023",
                   label="2023",  lede="Explore the 2023 World Risk Poll across worry, experienced harm, disaster resilience, trust and discrimination. All figures are population-weighted."),
    "trended": cfg("trended_wrp.sav", append_wrp25=True, include_year_dim=True,
                   demog=DEMOG_TRENDED, out="wrp_explorer_trended",
                   label="2019–2025", lede="Cross-wave view: every respondent from 2019, 2021, 2023 and 2025 in a single dataset. Use the survey-year filter or breakdown to see how worry, experienced harm and resilience have moved over time."),
}

# ---------------------------------------------------------------------------
# CANONICAL FILTER ORDER — the .filters-grid renders 5 columns × 4 rows, so
# we'd like up to 20 dimensions per wave, in the SAME slot order whenever the
# wave carries that item. Slots that don't exist in the wave are dropped
# silently rather than left blank, but the remaining ones keep their position.
# (slug,  source col on the source SAV,  user-facing label)
# ---------------------------------------------------------------------------
FILTER_SLOTS = [
    # core geographic + demographic (positions 1-9) — always shown
    ("__demog__",                None,        None),
    # Content filters (positions 10+). Listed roughly in priority/relevance order.
    # When two slugs map to the same conceptual filter but different waves (e.g.
    # WP20719 vs L5 for "Climate change a threat"), the first one to land in
    # the file wins and the duplicates are skipped, so the ORDER is consistent
    # across waves even though the underlying variable differs.
    # — climate / threat —
    ("climate_change_threat",   "WP20719",   "Climate change a threat"),
    ("climate_change_threat",   "L5",        "Climate change a threat"),
    ("most_other_people_climate","WP24225",  "Most others: climate threat"),
    # — greatest source of risk —
    ("greatest_source",         "WP22331",   "Greatest source of risk"),
    ("greatest_source",         "WP20713",   "Greatest source of risk (2019 wording)"),
    ("greatest_source",         "L3_A",      "Greatest source of risk (2019)"),
    # — worry items as quick-look filters —
    ("worry_food",              "WP20720",   "Worried about food"),
    ("worry_food",              "L6A",       "Worried about food (2019)"),
    ("worry_water",             "WP20721",   "Worried about water"),
    ("worry_water",             "L6B",       "Worried about water (2019)"),
    ("worry_crime",             "WP20722",   "Worried about violent crime"),
    ("worry_crime",             "L6C",       "Worried about violent crime (2019)"),
    ("worry_weather",           "WP20723",   "Worried about severe weather"),
    ("worry_weather",           "L6D",       "Worried about severe weather (2019)"),
    ("worry_mental",            "WP20726",   "Worried about mental health"),
    ("worry_mental",            "L6G",       "Worried about mental health (2019)"),
    # — disaster experience / preparedness —
    ("impacted_disaster",       "WP24213",   "Impacted by a disaster (2025)"),
    ("impacted_disaster",       "disaster_experienced", "Impacted by a disaster (trended)"),
    ("government_prepared",     "WP24198",   "Government well prepared"),
    ("able_to_take_action",     "WP24215",   "Able to act on warning"),
    ("could_protect",           "WP22252",   "Could protect self/family"),
    ("fin_res",                 "WP22228",   "Financial resilience"),
    ("plan_known",              "WP23345",   "Household disaster plan"),
    ("plan_known",              "disaster_plan", "Household disaster plan (trended)"),
    # — trust / care —
    ("govt_cares",              "WP22231",   "Government / authorities care"),
    ("neighbours_care",         "WP22232",   "Neighbours care"),
    # — discrimination —
    ("disc_skin",               "WP22259",   "Discrimination: skin colour"),
    ("disc_religion",           "WP22260",   "Discrimination: religion"),
    ("disc_nationality",        "WP22261",   "Discrimination: nationality"),
    ("disc_gender",             "WP22262",   "Discrimination: gender"),
    ("disc_disability",         "WP22263",   "Discrimination: disability"),
    # — 2019 likelihood / experience extras —
    ("worry_power_2019",        "L6E",       "Worried about electrical power lines (2019)"),
    ("likely_crime_2019",       "L7C",       "Likely violent-crime harm (2019)"),
    ("likely_mental_2019",      "L7G",       "Likely mental-health harm (2019)"),
    ("likely_traffic_2019",     "L9A",       "Likely traffic-accident harm (2019)"),
    ("exp_crime_2019",          "L8C",       "Experienced violent crime (2019)"),
    ("exp_mental_2019",         "L8G",       "Experienced mental-health harm (2019)"),
    # — odds & ends —
    ("safer_5yr",               "WP20711",   "Feel safer than five years ago"),
]

# ---------------------------------------------------------------------------
# MANUAL QUESTION CATALOGUE — questions with hand-picked slugs + nice labels
# (used when the source variable is present). Anything else categorical found
# in the SAV will be auto-added as a question with slug = lowercase var name.
# (slug, var, kind, label, extra_yes_codes)
# ---------------------------------------------------------------------------
KNOWN_QUESTIONS = [
    # ---- worry / threat ----
    ("climate",            "WP20719", "worry",  "Climate change a threat to country (next 20 yrs)"),
    ("climate_2019",       "L5",      "worry",  "Climate change a threat to country (2019)"),
    ("climate_other",      "WP24225", "worry",  "Most others see climate as a threat"),
    ("food",               "WP20720", "worry",  "Worried food could cause serious harm"),
    ("food_2019",          "L6A",     "worry",  "Worried food could cause harm (2019)"),
    ("water",              "WP20721", "worry",  "Worried water could cause serious harm"),
    ("water_2019",         "L6B",     "worry",  "Worried water could cause harm (2019)"),
    ("crime",              "WP20722", "worry",  "Worried violent crime could cause serious harm"),
    ("crime_2019",         "L6C",     "worry",  "Worried violent crime could cause harm (2019)"),
    ("weather",            "WP20723", "worry",  "Worried severe weather could cause serious harm"),
    ("weather_2019",       "L6D",     "worry",  "Worried severe weather could cause harm (2019)"),
    ("power_2019",         "L6E",     "worry",  "Worried electrical power lines (2019)"),
    ("mental_health",      "WP20726", "worry",  "Worried mental health could cause serious harm"),
    ("mental_2019",        "L6G",     "worry",  "Worried mental health (2019)"),
    ("traffic",            "WP22213", "worry",  "Worried traffic could cause serious harm"),
    ("work",               "WP22214", "worry",  "Worried work could cause serious harm"),
    ("prolonged_weather",  "WP24174", "worry",  "Worried prolonged severe weather (2025)"),
    ("wildfires",          "WP24173", "worry",  "Worried wildfires (2025)"),
    ("air",                "WP24175", "worry",  "Worried the air could cause harm (2025)"),
    # ---- experience (post-2020) ----
    ("exp_food",            "WP22442", "exp",    "Experienced harm: eating food"),
    ("exp_water",           "WP22443", "exp",    "Experienced harm: drinking water"),
    ("exp_crime",           "WP22444", "exp",    "Experienced harm: violent crime"),
    ("exp_weather",         "WP22445", "exp",    "Experienced harm: severe weather"),
    ("exp_prolonged_weather","WP24177","exp",    "Experienced harm: prolonged severe weather (2025)"),
    ("exp_wildfires",       "WP24176", "exp",    "Experienced harm: wildfires (2025)"),
    ("exp_air",             "WP24178", "exp",    "Experienced harm: the air (2025)"),
    ("exp_traffic",         "WP22446", "exp",    "Experienced harm: traffic"),
    ("exp_mental_health",   "WP22447", "exp",    "Experienced harm: mental health"),
    ("exp_work",            "WP22448", "exp",    "Experienced harm: work"),
    # ---- 2019 experience (binary, L-coded) ----
    ("exp_crime_2019",      "L8C",     "single", "Experienced harm: violent crime (2019)"),
    ("exp_mental_2019",     "L8G",     "single", "Experienced harm: mental health (2019)"),
    # ---- 2019 likelihood (next two years) ----
    ("likely_crime_2019",   "L7C",     "worry",  "Likely violent crime harm next 2 yrs (2019)"),
    ("likely_mental_2019",  "L7G",     "worry",  "Likely mental-health harm next 2 yrs (2019)"),
    ("likely_traffic_2019", "L9A",     "worry",  "Likely traffic-accident harm next 2 yrs (2019)"),
    # ---- bridge experience (trended/2019) ----
    ("exp_food_trended",    "harm_food_trended",          "single", "Experienced harm: food (trended)"),
    ("exp_water_trended",   "harm_water_trended",         "single", "Experienced harm: water (trended)"),
    ("exp_crime_trended",   "harm_crime_trended",         "single", "Experienced harm: violent crime (trended)"),
    ("exp_weather_trended", "harm_weather_trended",       "single", "Experienced harm: severe weather (trended)"),
    ("exp_mental_trended",  "harm_mental_health_trended", "single", "Experienced harm: mental health (trended)"),
    # ---- trust / care ----
    ("govt_cares",          "WP22231", "trust",  "Government cares about your wellbeing"),
    ("authorities_care",    "WP22469", "trust",  "Authorities care about your wellbeing"),
    ("neighbours_care",     "WP22232", "trust",  "Neighbours care about your wellbeing"),
    # ---- disaster / resilience ----
    ("impacted_disaster_t", "disaster_experienced", "single", "Experienced a disaster in past 5 yrs (trended)"),
    ("impacted_disaster",   "WP24213", "single", "Experienced a disaster in past 5 yrs (2025)"),
    ("plan_known_t",        "disaster_plan",        "single", "Household disaster plan known by all (trended)"),
    ("plan_known",          "WP23345", "single",  "Household disaster plan known by all members"),
    ("could_protect",       "WP22252", "single",  "Could protect self/family in a future disaster"),
    ("fin_res",             "WP22228", "binary",  "Cover basic needs a month+ if income lost",
                            [2]),
    # ---- discrimination ----
    ("disc_skin",           "WP22259", "single", "Experienced discrimination: skin colour"),
    ("disc_religion",       "WP22260", "single", "Experienced discrimination: religion"),
    ("disc_nationality",    "WP22261", "single", "Experienced discrimination: nationality / ethnicity"),
    ("disc_gender",         "WP22262", "single", "Experienced discrimination: gender"),
    ("disc_disability",     "WP22263", "single", "Experienced discrimination: disability"),
    # ---- greatest source of risk ----
    ("greatest",            "WP22331", "greatest", "Greatest source of risk to daily safety"),
    ("greatest_2019",       "WP20713", "greatest_2019", "Greatest source of risk to daily safety (2019)"),
    # ---- safer / safer than 5 yrs ago ----
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

# Columns the auto-discovery pass should NOT register as substantive questions —
# they are admin/technical/derived sample-design variables, ID columns, or
# duplicates of the harmonised demog dims we expose anyway.
AUTO_DISCOVER_EXCLUDE = {
    # IDs and admin
    "WPID", "WPID_RANDOM", "INTDATE", "Date", "Wave", "WAVE",
    # weights
    "WGT", "PROJWT", "PROJWT_2021", "PROJWT_2019", "HHWEIGHT2",
    # countries
    "Country", "countrynew", "COUNTRYNEW", "COUNTRY_ISO2", "COUNTRY_ISO3",
    "CountryIncomeLevel2019", "CountryIncomeLevel2021", "CountryIncomeLevel2023",
    "GlobalRegion", "RegionReport", "RegionLRF", "REG_GLOBAL", "REG2_GLOBAL",
    "Region_AFG", "Region_ALB",   # there are 140 of these "Region_XXX" PSU vars
    "REGION_IDN", "REGION2_IDN", "WP5",
    # demog already shown via DEMOG
    "WP1219", "WP1220", "WP1220RECODED_1", "WP3117", "DEGURBA", "EMP_2010",
    "Gender", "Age", "AgeGroups", "AgeGroups3", "AgeGroups4", "AgeGroups5",
    "Education", "Urbanicity", "INCOME_5", "WBI", "wbi", "HouseholdSize",
    "ChildrenInHousehold",
    # sample-design flags carried in trended_wrp.sav
    "countries_in_all_waves", "countries_in_w3_trend", "resilience_waves",
    # Year
    "Year", "YEAR",
}

# Substantive answer codes (= not DK / Refused / N/A). Codes above 90 are
# treated as missing for metric numerators across the codebase.
def is_substantive(code):
    return int(code) < 90


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
    """0..1 or 0..100 numeric → Int8 0..100, -1 = missing."""
    out = np.full(arr.shape[0], -1, np.int8)
    m = ~np.isnan(arr)
    vals = arr[m]
    if len(vals) and np.nanmax(vals) <= 1.5:
        vals = vals * 100
    out[m] = np.clip(np.rint(vals), 0, 100).astype(np.int8)
    return out


def auto_slug(var):
    """For auto-discovered questions, derive a friendly slug from the var name."""
    return re.sub(r"[^A-Za-z0-9]+", "_", var).strip("_").lower()


def answers_for(var, vl):
    d = vl.get(var, {})
    codes = sorted(int(c) for c in d.keys())
    subs = [c for c in codes if c < 97]
    out = []
    for c in codes:
        pos = subs.index(c) if c in subs else 0
        label = d.get(float(c), d.get(c, str(c)))
        out.append({"code": c, "label": label, "color": slug_color(c, pos)})
    return out


def short_label(slug, label, kind):
    if kind == "worry":
        return label.split(" could")[0].split(" a threat")[0].split(" — ")[0]
    return label


# ---- WRP25 → trended-column rename (for the trended build's 2025 append) ----
WRP25_RENAME = {
    "WP1219":           "Gender",
    "WP1220RECODED_1":  "AgeGroups5",
    "WP3117":           "Education",
    "DEGURBA":          "Urbanicity",
    "RegionLRF":        "GlobalRegion",
    "wbi":              "CountryIncomeLevel2023",
    "COUNTRYNEW":       "Country",
    "WPID":             "WPID_RANDOM",
    "worry_index":      "Worried.Index",
    "resilience_idv":   "resilience_idv_0_100_scale",
    "resilience_hhl":   "resilience_hhl_0_100_scale",
    "resilience_com":   "resilience_com_0_100_scale",
    "resilience_soc":   "resilience_soc_0_100_scale",
}


def load_wrp25_for_trended():
    src = os.path.join(DATA, "wrp_25.sav")
    df25, m25 = pyreadstat.read_sav(src)
    # If wrp_25 already has the target rename name (e.g. WPID_RANDOM), drop the
    # source so the rename can't create a duplicate column.
    for src_name, tgt_name in WRP25_RENAME.items():
        if src_name in df25.columns and tgt_name in df25.columns and src_name != tgt_name:
            df25 = df25.drop(columns=[src_name])
    df25 = df25.rename(columns={k: v for k, v in WRP25_RENAME.items() if k in df25.columns})
    # Education is stripped from wrp_25.sav — pull it from the full Lloyds release.
    edu_path = os.path.join(DATA, "Lloyds_2025_022026_w_projection_weight.sav")
    if "Education" not in df25.columns and os.path.exists(edu_path):
        edu, _ = pyreadstat.read_sav(edu_path, usecols=["WPID", "WP3117"])
        edu = edu.rename(columns={"WPID": "WPID_RANDOM", "WP3117": "Education"})
        edu.loc[~edu["Education"].isin([1, 2, 3]), "Education"] = np.nan
        df25 = df25.merge(edu, on="WPID_RANDOM", how="left")
    df25["Year"] = 2025
    return df25, m25


def blend_projwt(df, source, year):
    """Bring PROJWT in from another .sav (the trended one) on WPID_RANDOM."""
    src_path = os.path.join(DATA, source)
    df_src, _ = pyreadstat.read_sav(src_path, usecols=["WPID_RANDOM", "Year", "PROJWT", "COUNTRY_ISO3"])
    sub = df_src[df_src["Year"] == year][["WPID_RANDOM", "PROJWT", "COUNTRY_ISO3"]]
    n_before = df["PROJWT"].notna().sum() if "PROJWT" in df.columns else 0
    df = df.merge(sub, on="WPID_RANDOM", how="left", suffixes=("", "_blend"))
    if "PROJWT" not in df.columns and "PROJWT_blend" in df.columns:
        df = df.rename(columns={"PROJWT_blend": "PROJWT"})
    if "COUNTRY_ISO3" not in df.columns and "COUNTRY_ISO3_blend" in df.columns:
        df = df.rename(columns={"COUNTRY_ISO3_blend": "COUNTRY_ISO3"})
    print(f"  blended PROJWT from {source} (Year={year}): {df['PROJWT'].notna().sum():,} rows have weight (was {n_before:,})")
    return df


def build_for(wave):
    c = WAVE_CONFIG[wave]
    src_path = os.path.join(DATA, c["sav"])
    print(f"\n=== wave {wave}: reading {os.path.basename(src_path)} ===")
    df, meta = pyreadstat.read_sav(src_path)

    if c["append_wrp25"]:
        df25, _ = load_wrp25_for_trended()
        df = pd.concat([df, df25], ignore_index=True, sort=False)
        print(f"  appended wrp_25.sav as Year=2025: total {len(df):,} rows")

    # year filter (e.g. 2021 lives in 21_wrp.sav which also has 2019 rows)
    if c["year_filter"]:
        col, yr = c["year_filter"]
        df = df[df[col] == yr].reset_index(drop=True)
        print(f"  filtered to {col}=={yr}: {len(df):,} rows")

    # weight: either present, or blended from trended
    weight_col = c["weight_col"]
    if c["blend_projwt_from"]:
        src, yr = c["blend_projwt_from"]
        df = blend_projwt(df, src, yr)
        weight_col = "PROJWT"
    if weight_col not in df.columns:
        raise SystemExit(f"wave {wave}: weight col '{weight_col}' not present after blend")

    n = len(df)
    vl = meta.variable_value_labels
    lab = meta.column_names_to_labels

    # ---- country index ----
    cname = c["country_col"]; ciso = c["iso3_col"]
    if cname not in df.columns:
        raise SystemExit(f"wave {wave}: country col '{cname}' not in source file")
    if ciso and ciso not in df.columns:
        ciso = None
    if ciso:
        cdf = df[[cname, ciso]].dropna(subset=[cname]).drop_duplicates(cname).sort_values(cname)
        countries = [{"name": r[0], "iso3": (r[1] if isinstance(r[1], str) else "")} for r in cdf.itertuples(index=False)]
    else:
        cdf = df[[cname]].dropna(subset=[cname]).drop_duplicates(cname).sort_values(cname)
        countries = [{"name": r[0], "iso3": ""} for r in cdf.itertuples(index=False)]
    cindex = {x["name"]: i for i, x in enumerate(countries)}
    country_col_arr = df[cname].map(cindex).fillna(-1).to_numpy(np.int16)
    print(f"  {len(countries)} countries")

    # ---- catalogue: known + auto-discovered ----
    known_by_var = {q[1]: q for q in KNOWN_QUESTIONS}
    columns = []           # (key, np.array, dtype)
    questions, metrics = [], []
    seen_vars = set()

    def add_question_record(slug, var, label, kind, extras=None):
        # encode column
        if var in seen_vars:
            return
        seen_vars.add(var)
        if kind == "index":
            arr = encode_index(df[var].to_numpy())
            columns.append((var, arr, "i8"))
            metrics.append({"key": slug, "col": var, "kind": "mean",
                            "label": label})
            return
        arr = encode_cat(df[var].to_numpy())
        columns.append((var, arr, "i8"))
        # value labels for this variable
        ans = answers_for(var, vl)
        if not ans:   # nothing we can do without value labels
            return
        questions.append({"key": slug, "col": var, "label": label, "answers": ans})
        # generate metrics
        sub_codes = [a["code"] for a in ans if is_substantive(a["code"])]
        if kind == "worry":
            short = short_label(slug, label, kind)
            not_word = "not a threat" if "climate" in slug else "not worried"
            metrics.append({"key": f"{slug}_very",      "col": var, "num": [sub_codes[0]] if sub_codes else [1],
                            "label": f"{short} — very (%)"})
            if len(sub_codes) >= 2:
                metrics.append({"key": f"{slug}_concerned","col": var, "num": sub_codes[:2],
                                "label": f"{short} — very or somewhat (%)"})
            if len(sub_codes) >= 3:
                metrics.append({"key": f"{slug}_not",   "col": var, "num": [sub_codes[2]],
                                "label": f"{short} — {not_word} at all (%)"})
        elif kind == "exp":
            short = short_label(slug, label, kind)
            # 4-code experience: 1=personally, 2=know someone, 3=both, 4=No
            if set(sub_codes) >= {1, 2, 3, 4}:
                metrics.append({"key": f"{slug}_personal", "col": var, "num": [1, 3],     "label": f"{short} — personally (%)"})
                metrics.append({"key": slug,                 "col": var, "num": [1, 2, 3], "label": f"{short} — self or someone (%)"})
                metrics.append({"key": f"{slug}_not",      "col": var, "num": [4],         "label": f"{short} — not experienced (%)"})
            else:
                metrics.append({"key": f"{slug}_yes", "col": var, "num": sub_codes, "label": f"{short} (%)"})
        elif kind == "trust":
            short = short_label(slug, label, kind)
            metrics.append({"key": f"{slug}_alot", "col": var, "num": [sub_codes[0]] if sub_codes else [1], "label": f"{short} — a lot (%)"})
            if len(sub_codes) >= 2:
                metrics.append({"key": f"{slug}_any",   "col": var, "num": sub_codes[:2], "label": f"{short} — a lot or somewhat (%)"})
            if len(sub_codes) >= 3:
                metrics.append({"key": f"{slug}_not",   "col": var, "num": [sub_codes[2]], "label": f"{short} — not at all (%)"})
        elif kind == "binary":
            yes = extras if extras else [1]
            metrics.append({"key": f"{slug}_yes", "col": var, "num": yes, "label": f"{label} (%)"})
        elif kind == "single":
            metrics.append({"key": f"{slug}_yes", "col": var, "num": [1], "label": f"{label} (%)"})
        elif kind == "greatest":
            metrics.append({"key": "greatest_climate", "col": var, "num": [19],
                            "label": "Climate/severe weather named greatest daily risk (%)"})
        elif kind == "greatest_2019":
            metrics.append({"key": "greatest_climate_2019", "col": var, "num": [16],
                            "label": "Climate/natural disasters named greatest daily risk (2019, %)"})
        elif kind == "auto":
            # one metric per substantive answer
            short = label
            for code in sub_codes:
                a_lab = next(a["label"] for a in ans if a["code"] == code)
                a_slug = re.sub(r"[^A-Za-z0-9]+", "_", str(a_lab))[:24].strip("_").lower() or f"c{code}"
                metrics.append({"key": f"{slug}_{a_slug}", "col": var, "num": [code],
                                "label": f"{short} — {a_lab} (%)"})

    # 1) Manual catalogue first (better labels / slug names)
    for entry in KNOWN_QUESTIONS:
        slug, var, kind, *rest = entry
        if var not in df.columns:
            continue
        if df[var].notna().mean() * 100 < 0.5:
            continue
        label = rest[0]
        extras = rest[1] if len(rest) > 1 else None
        add_question_record(slug, var, label, kind, extras)

    # 2) Auto-discover everything else that's categorical & populated
    used_slugs = {q["key"] for q in questions} | {m["key"] for m in metrics}
    for var in df.columns:
        if var in seen_vars or var in AUTO_DISCOVER_EXCLUDE:
            continue
        if var not in vl or len(vl[var]) < 2:
            continue
        # skip if dtype isn't numeric
        if df[var].dtype.kind not in "fi":
            continue
        coverage = df[var].notna().mean() * 100
        if coverage < 1.0:
            continue
        # skip wildly-multi-code vars (look like sample-design or country lists)
        codes = [int(k) for k in vl[var].keys()]
        if len(codes) > 30:
            continue
        # don't shadow a known-slug
        slug = auto_slug(var)
        if slug in used_slugs:
            slug = slug + "_q"
        used_slugs.add(slug)
        add_question_record(slug, var, lab.get(var, var) or var, "auto")

    print(f"  {len(questions)} questions, {len(metrics)} metrics")

    # ---- dimensions: country, then demog, then filter slots ----
    dimensions = []
    dim_payload_added = set()
    dimensions.append({"key": "countrynew", "col": "country", "label": "Country", "type": "country"})

    for slug, src_col, demlabel in c["demog"]:
        if src_col not in df.columns:
            print(f"  ! dimension {slug}: source col '{src_col}' missing — skipping")
            continue
        arr = encode_cat(df[src_col].to_numpy())
        if (arr >= 0).sum() < 0.05 * n:
            print(f"  ! dimension {slug} ({src_col}): <5% populated — skipping")
            continue
        if src_col not in seen_vars:
            columns.append((src_col, arr, "i8"))
            seen_vars.add(src_col)
        dimensions.append({"key": slug, "col": src_col, "label": demlabel,
                           "cats": [{"code": a["code"], "label": a["label"]} for a in answers_for(src_col, vl)]})
        dim_payload_added.add(slug)

    # year dimension for the trended page
    if c["include_year_dim"] and "Year" in df.columns:
        yr_arr = df["Year"].fillna(-1).astype(int).to_numpy()
        codes = sorted(int(y) for y in set(yr_arr) if y > 0)
        out = np.full(n, -1, np.int8)
        for code in codes:
            out[yr_arr == code] = code - 2000
        columns.append(("year_code", out, "i8"))
        dimensions.append({"key": "year", "col": "year_code", "label": "Survey year",
                           "cats": [{"code": y - 2000, "label": str(y)} for y in codes]})

    # additional question-based filter dimensions, in canonical FILTER_SLOTS order
    DIM_CAP = 21   # country + up to 20 filterable slots → 5×4 grid + the country one
    for slug, src_col, dlabel in FILTER_SLOTS:
        if slug == "__demog__":
            continue
        if src_col is None or src_col not in df.columns:
            continue
        if df[src_col].notna().mean() * 100 < 1.0:
            continue
        if slug in dim_payload_added:
            continue
        if len(dimensions) >= DIM_CAP:
            break
        # make sure the column was encoded already (the manual catalogue or
        # auto-discovery usually has done it; if not, do it now)
        if src_col not in seen_vars:
            columns.append((src_col, encode_cat(df[src_col].to_numpy()), "i8"))
            seen_vars.add(src_col)
        ans = answers_for(src_col, vl)
        if not ans:
            continue
        dimensions.append({"key": slug, "col": src_col, "label": dlabel,
                           "cats": [{"code": a["code"], "label": a["label"]} for a in ans]})
        dim_payload_added.add(slug)

    print(f"  {len(dimensions)} dimensions  (5×4 grid + country)")

    # ---- weight ----
    weight = df[weight_col].fillna(0).to_numpy(np.float32)

    # ---- pack binary (column-major) ----
    blob = bytearray()
    manifest_cols = []
    def append_col(key, arr, tag):
        nonlocal blob
        off = len(blob); blob += arr.tobytes()
        manifest_cols.append({"key": key, "dtype": tag, "off": off, "len": int(arr.shape[0])})
    append_col("country", country_col_arr, "i16")
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
    out_base = os.path.join(DATA, c["out"])
    with open(out_base + ".json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, separators=(",", ":"), ensure_ascii=False)
    with open(out_base + ".bin", "wb") as f:
        f.write(blob)
    with gzip.open(out_base + ".bin.gz", "wb", compresslevel=9) as f:
        f.write(blob)
    print(f"  json {os.path.getsize(out_base+'.json')/1024:.0f} KB | "
          f"bin {os.path.getsize(out_base+'.bin')/1e6:.2f} MB | "
          f"gz {os.path.getsize(out_base+'.bin.gz')/1e6:.2f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wave", required=True, choices=list(WAVE_CONFIG.keys()) + ["all"])
    args = ap.parse_args()

    waves = list(WAVE_CONFIG.keys()) if args.wave == "all" else [args.wave]
    for w in waves:
        build_for(w)


if __name__ == "__main__":
    main()
