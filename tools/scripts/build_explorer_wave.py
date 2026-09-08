#!/usr/bin/env python3
"""
Build per-wave World Risk Poll explorer datasets.

Every wave is read from the harmonised wave files produced by
build_wrp_waves.py - the parquet for the data, the sibling .sav (metadata only)
for the variable and value labels. All four waves share one set of column
names, codes and labels for country, weights and demographics, so a single
config covers them and the per-wave blending this script used to do is gone:

  * PROJWT ships with every wave, so there is no blending from the trended file
    and no synthetic weight for the five 2019 countries that file omits
    (Belarus, Jamaica, Lesotho, Rwanda, Turkmenistan, 4,718 respondents, whose
    projected populations were 5x to 26x too large under the old fallback).
  * COUNTRY_ISO3 ships with every wave, so there is no ISO3 blending and no
    hand-maintained fallback table.
  * The demographics carry identical names and codes in every wave, so a filter
    chosen on one wave means the same thing on the next.

The trended page stacks all four waves. 2019 kept the field questionnaire's
L-codes, so those columns are renamed onto the WP numbers the later waves use
(L_TO_WP_2019, verified respondent-by-respondent against Gallup's trended
file), and the items whose source variable changed between waves are bridged
onto common columns (BRIDGES).

Sources (override the folder with WRP_CLEAN_DIR):
    <WRP_CLEAN_DIR>/WRP_2019/WRP_2019.parquet  + .sav for labels
    <WRP_CLEAN_DIR>/WRP_2021/WRP_2021.parquet  + .sav
    <WRP_CLEAN_DIR>/WRP_2023/WRP_2023.parquet  + .sav
    <WRP_CLEAN_DIR>/WRP_2025/WRP_2025.parquet  + .sav   (trended stack only;
                            the single-wave 2025 page is built by
                            build_explorer_data.py from the same file)

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
and, with --wave all, data/country_waves.json for the Dataset details tab.
"""
import argparse, json, gzip, os, re
import numpy as np
import pandas as pd
import pyreadstat

from wrp_indices import experience_index_2025

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

# Root of the harmonised wave files (build_wrp_waves.py output). Override when
# the "Datafile cleaning/output" folder lives somewhere else.
CLEAN_DIR = os.environ.get("WRP_CLEAN_DIR", r"D:\Repos\Foundation\Datafile cleaning\output")

# ---- WRP data-viz palette (must match build_explorer_data.py / Chart Studio) ----
POS_COLOURS    = ["#e3076e", "#00a7b3", "#00785c", "#f07800", "#7a50de"]
SPECIAL_COLOURS = {97: "#d8d8de", 98: "#bdbdbd", 99: "#0d2240"}

# ---------------------------------------------------------------------------
# WAVE CONFIG - every wave now comes from the harmonised build_wrp_waves.py
# output: WRP_<year>.parquet for the data, the sibling WRP_<year>.sav for the
# variable and value labels. All four waves share one set of harmonised column
# names (Country, COUNTRY_ISO3, PROJWT, Gender, Education, ...), so there is no
# per-wave demographic map, no PROJWT blending and no ISO3 blending any more.
# ---------------------------------------------------------------------------
def cfg(year, *, demog=None, out=None, include_year_dim=False, stack_all=False,
        label=None, lede=None):
    return {"year": year, "demog": demog or [], "out": out,
            "include_year_dim": include_year_dim, "stack_all": stack_all,
            "label": label, "lede": lede}

# Each demographic = (slug, source col, user-facing label). Slugs are the
# browser keys ('gender', 'age_5', ...) the JS engine expects, so the same code
# renders every wave. One list now covers all four waves.
# Order: country (auto, position 1) -> region -> country-income -> gender ->
# age -> education -> income quintile -> urban/rural -> employment.
DEMOG = [
    ("GlobalRegion",     "GlobalRegion",       "Global region"),
    ("CountryIncome",    "CountryIncomeLevel", "Country income group"),
    ("gender",           "Gender",             "Gender"),
    ("age_5",            "AgeGroups5",         "Age (5 groups)"),
    ("education",        "Education",          "Education level"),
    ("income_quintiles", "INCOME_5",           "Income quintile"),
    ("urban_rural",      "Urbanicity",         "Urban / rural"),
    ("employment",       "EMP_2010",           "Employment status"),
]

WAVE_CONFIG = {
    "2019":    cfg(2019, demog=DEMOG, out="wrp_explorer_2019",
                   label="2019",  lede="Explore the 2019 World Risk Poll - every question Lloyd's Register Foundation fielded that year, filterable by demographics. All figures are population-weighted."),
    "2021":    cfg(2021, demog=DEMOG, out="wrp_explorer_2021",
                   label="2021",  lede="Explore the 2021 World Risk Poll across worry, experienced harm, disaster resilience, trust and discrimination. All figures are population-weighted."),
    "2023":    cfg(2023, demog=DEMOG, out="wrp_explorer_2023",
                   label="2023",  lede="Explore the 2023 World Risk Poll across worry, experienced harm, disaster resilience, trust and discrimination. All figures are population-weighted."),
    "trended": cfg(None, stack_all=True, include_year_dim=True,
                   demog=DEMOG, out="wrp_explorer_trended",
                   label="2019-2025", lede="Cross-wave view: every respondent from 2019, 2021, 2023 and 2025 in a single dataset. Use the survey-year filter or breakdown to see how worry, experienced harm and resilience have moved over time."),
}
ALL_YEARS = (2019, 2021, 2023, 2025)

# 2019 kept the field questionnaire's L-codes; from 2021 the same items carry
# the WP numbers. Verified respondent-by-respondent against Gallup's own
# trended file: for every pair below the two columns agree on more than 99.9%
# of the 149,477 shared 2019 respondents. Applied only when stacking waves, so
# the single-wave 2019 page keeps its native names and its own question wording.
L_TO_WP_2019 = {
    "L2":   "WP20711",   # feel safer than five years ago
    "L3_A": "WP20713",   # greatest source of risk (2019 code frame)
    "L5":   "WP20719",   # climate change a threat
    "L6A":  "WP20720",   # worried about food
    "L6B":  "WP20721",   # worried about water
    "L6C":  "WP20722",   # worried about violent crime
    "L6D":  "WP20723",   # worried about severe weather
    "L6G":  "WP20726",   # worried about mental health
}

# Bridge variables built for the stacked file, so a question whose source
# variable changed between waves still trends. Each entry is
#   target: {year: (source var, {source code: bridged code})}
# and the bridged codes are always 1 = yes, 2 = no, 99 = DK/Refused. This
# reproduces the recodes in Gallup's trended file (checked against
# harm_food_trended and disaster_experienced) and extends them to 2025, which
# that file predates.
_EXP_4CODE = {1: 1, 2: 1, 3: 1, 4: 2, 98: 99, 99: 99}   # 1/2/3 = any experience
_YESNO = {1: 1, 2: 2, 98: 99, 99: 99}


def _harm(l_code, wp_code):
    return {2019: (l_code, _YESNO), 2021: (wp_code, _EXP_4CODE),
            2023: (wp_code, _EXP_4CODE), 2025: (wp_code, _EXP_4CODE)}


BRIDGES = {
    "harm_food_trended":          _harm("L8A", "WP22442"),
    "harm_water_trended":         _harm("L8B", "WP22443"),
    "harm_crime_trended":         _harm("L8C", "WP22444"),
    "harm_weather_trended":       _harm("L8D", "WP22445"),
    "harm_mental_health_trended": _harm("L8G", "WP22447"),
    "disaster_experienced": {2021: ("WP22245", _YESNO), 2023: ("WP23344", _YESNO),
                             2025: ("WP24213", _YESNO)},
    "disaster_plan":        {2021: ("WP22253", _YESNO), 2023: ("WP23345", _YESNO),
                             2025: ("WP23345", _YESNO)},
}
BRIDGE_LABELS = {1: "Yes", 2: "No", 99: "DK/Refused"}

# Each wave publishes its Worry and Experience indices its own way - the items
# counted, what counts as having experienced harm, and the scaling all move
# between waves (see wrp_indices.py for the definitions read off the data). So
# the four figures are NOT on a common footing. They are carried on every wave, including the trended
# stack, because that is what the tool is asked for, but the flag below travels
# with them into the manifest so the browser can say so on the one view where
# the difference actually bites (change between waves). To trend the underlying
# idea, use worry_score / experience_score, which the harmonised files compute
# the same way in every wave.
NOT_COMPARABLE_VARS = {"worry_index_published", "experience_index_published"}

TRENDED_EXCLUDE_VARS = {
    # signed -1..+1; the Int8 0..100 index encoding would silently clamp every
    # negative gap to zero.
    "worry_exp_gap",
}


def wave_files(year):
    """(parquet, sav) for one harmonised wave, or exit with a usable message."""
    base = os.path.join(CLEAN_DIR, "WRP_%d" % year)
    parquet = os.path.join(base, "WRP_%d.parquet" % year)
    sav = os.path.join(base, "WRP_%d.sav" % year)
    for path in (parquet, sav):
        if not os.path.exists(path):
            raise SystemExit(
                f"Harmonised wave file not found at {path}. Point WRP_CLEAN_DIR at the "
                "'Datafile cleaning/output' folder, or re-run build_wrp_waves.py."
            )
    return parquet, sav


def load_wave(year):
    """One harmonised wave: (df, value_labels, variable_labels).

    Data comes from the parquet; the labels come from the sibling .sav, read
    metadata-only, because the parquet stores bare numeric codes.
    """
    parquet, sav = wave_files(year)
    df = pd.read_parquet(parquet)
    _, meta = pyreadstat.read_sav(sav, metadataonly=True)
    vl = {k: dict(v) for k, v in meta.variable_value_labels.items()}
    lab = dict(meta.column_names_to_labels)
    return df, vl, lab


def add_bridges(df, year):
    """Add the cross-wave bridge columns this wave can supply."""
    made = []
    for target, per_year in BRIDGES.items():
        if year not in per_year:
            continue
        src, mapping = per_year[year]
        if src not in df.columns:
            continue
        df[target] = df[src].map(mapping)
        made.append(target)
    return made


def load_stacked():
    """All four waves on one set of column names, for the trended page."""
    frames, vl, lab = [], {}, {}
    for year in ALL_YEARS:
        d, v, l = load_wave(year)
        if year == 2019:
            d = d.rename(columns=L_TO_WP_2019)
            v = {L_TO_WP_2019.get(k, k): x for k, x in v.items()}
            l = {L_TO_WP_2019.get(k, k): x for k, x in l.items()}
        made = add_bridges(d, year)
        if year == 2025:
            # The harmonised 2025 file leaves experience_index_published empty
            # because LRF published none. Rebuild wave 4's own index from the
            # ten items so the series reaches this wave too (wrp_indices.py).
            d["experience_index_published"] = experience_index_2025(d)
        d["Year"] = year
        frames.append(d)
        # Later waves win on wording; codes are unioned, so an answer band a
        # later wave added (WP22247 gained codes 51/52 in 2023) is not lost.
        for var, codes in v.items():
            vl.setdefault(var, {}).update(codes)
        lab.update(l)
        extra = (", bridges: " + ", ".join(made)) if made else ""
        print(f"  {year}: {len(d):,} respondents, {d['Country'].nunique()} countries{extra}")
    for target in BRIDGES:
        vl[target] = {float(k): v for k, v in BRIDGE_LABELS.items()}
        lab.setdefault(target, target)
    # Drop columns a frame has no data for at all (resilience in 2019, say)
    # before concatenating: it keeps pandas from having to guess a dtype from
    # an all-NA block, and the column still arrives from the waves that do
    # carry it.
    frames = [f.dropna(axis=1, how="all") for f in frames]
    df = pd.concat(frames, ignore_index=True, sort=False)
    print(f"  stacked: {len(df):,} respondents, {df['Country'].nunique()} countries")
    return df, vl, lab


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
    ("most_other_people_climate","WP24225",  "Most others: climate threat"),
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
    ("climate_2019",       "L5",      "worry",  "Climate change a threat to country"),
    ("climate_other",      "WP24225", "worry",  "Most others see climate as a threat"),
    ("food",               "WP20720", "worry",  "Worried food could cause serious harm"),
    ("food_2019",          "L6A",     "worry",  "Worried food could cause harm"),
    ("water",              "WP20721", "worry",  "Worried water could cause serious harm"),
    ("water_2019",         "L6B",     "worry",  "Worried water could cause harm"),
    ("crime",              "WP20722", "worry",  "Worried violent crime could cause serious harm"),
    ("crime_2019",         "L6C",     "worry",  "Worried violent crime could cause harm"),
    ("weather",            "WP20723", "worry",  "Worried severe weather could cause serious harm"),
    ("weather_2019",       "L6D",     "worry",  "Worried severe weather could cause harm"),
    ("power_2019",         "L6E",     "worry",  "Worried electrical power lines"),
    ("mental_health",      "WP20726", "worry",  "Worried mental health could cause serious harm"),
    ("mental_2019",        "L6G",     "worry",  "Worried mental health"),
    ("traffic",            "WP22213", "worry",  "Worried traffic could cause serious harm"),
    ("work",               "WP22214", "worry",  "Worried work could cause serious harm"),
    ("prolonged_weather",  "WP24174", "worry",  "Worried prolonged severe weather"),
    ("wildfires",          "WP24173", "worry",  "Worried wildfires"),
    ("air",                "WP24175", "worry",  "Worried the air could cause harm"),
    # ---- experience (post-2020) ----
    ("exp_food",            "WP22442", "exp",    "Experienced harm: eating food"),
    ("exp_water",           "WP22443", "exp",    "Experienced harm: drinking water"),
    ("exp_crime",           "WP22444", "exp",    "Experienced harm: violent crime"),
    ("exp_weather",         "WP22445", "exp",    "Experienced harm: severe weather"),
    ("exp_prolonged_weather","WP24177","exp",    "Experienced harm: prolonged severe weather"),
    ("exp_wildfires",       "WP24176", "exp",    "Experienced harm: wildfires"),
    ("exp_air",             "WP24178", "exp",    "Experienced harm: the air"),
    ("exp_traffic",         "WP22446", "exp",    "Experienced harm: traffic"),
    ("exp_mental_health",   "WP22447", "exp",    "Experienced harm: mental health"),
    ("exp_work",            "WP22448", "exp",    "Experienced harm: work"),
    # ---- 2019 experience (binary, L-coded) ----
    ("exp_crime_2019",      "L8C",     "single", "Experienced harm: violent crime"),
    ("exp_mental_2019",     "L8G",     "single", "Experienced harm: mental health"),
    # ---- 2019 likelihood (next two years) ----
    ("likely_crime_2019",   "L7C",     "worry",  "Likely violent crime harm next 2 yrs"),
    ("likely_mental_2019",  "L7G",     "worry",  "Likely mental-health harm next 2 yrs"),
    ("likely_traffic_2019", "L9A",     "worry",  "Likely traffic-accident harm next 2 yrs"),
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
    ("impacted_disaster",   "WP24213", "single", "Experienced a disaster in past 5 yrs"),
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
    ("greatest_2019",       "WP20713", "greatest_2019", "Greatest source of risk to daily safety"),
    # ---- safer / safer than 5 yrs ago ----
    ("safer_5yr",           "WP20711", "worry",   "Feel safer than five years ago"),
    # ---- indices ----
    # Two families. The *_published pair is what LRF printed for that wave and
    # belongs on the single-wave pages; the recomputed scores use the items
    # asked in identical form in every wave and are the ones that trend, so
    # only they survive the cross-wave filter (see TRENDED_EXCLUDE_VARS).
    ("worry_index",           "worry_index_published",      "index", "Worry Index (0-100)"),
    ("experience_index",      "experience_index_published", "index", "Experience Index (0-100)"),
    ("worry_score",           "worry_score",                "index", "Worry score, 5 common items (0-100)"),
    ("worry_score_core7",     "worry_score_core7",          "index", "Worry score, 7 items (0-100)"),
    ("experience_score",      "experience_score",           "index", "Experience score, self or someone known (0-100)"),
    ("experience_score_self", "experience_score_self",      "index", "Experience score, personally (0-100)"),
    ("experience_score_core7","experience_score_core7",     "index", "Experience score, 7 items (0-100)"),
    ("resilience_index",      "resilience_index",           "index", "Resilience Index (0-100)"),
    ("resilience_idv",        "resilience_idv",             "index", "Resilience: individual (0-100)"),
    ("resilience_hhl",        "resilience_hhl",             "index", "Resilience: household (0-100)"),
    ("resilience_com",        "resilience_com",             "index", "Resilience: community (0-100)"),
    ("resilience_soc",        "resilience_soc",             "index", "Resilience: societal (0-100)"),
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
    # harmonised block that is already exposed as a demographic dimension,
    # a weight, an id or a score
    "CountryIncomeLevel", "Urbanicity2", "AgeGroups", "FIELD_DATE", "IncomeFeelings",
    "worry_score", "worry_score_core7", "worry_index_published",
    "experience_score", "experience_score_self", "experience_score_core7",
    "experience_index_published", "worry_exp_gap",
    "resilience_index", "resilience_index_100",
    "resilience_idv", "resilience_hhl", "resilience_com", "resilience_soc",
    # 2023 fielding diagnostics, not survey content
    "Q4_mean", "Q5_mean", "Q4_RMw_projwt_byusertime", "Q5_RMw_projwt_byusertime",
    "Q4_mean_projwt_byusertime", "Q5_mean_projwt_byusertime",
    # 2019 employment derivations (EMP_2010 is the one we expose)
    "EMP_FTEMP", "EMP_FTEMP_POP", "EMP_LFPR", "EMP_UNDER", "EMP_UNEMP",
    "EMP_WORK_HOURS",
}

# Per-country primary-sampling-unit variables (REGION_ALB, REGION2_IDN, ...).
# There are hundreds and each is populated for one country only, so they are
# never survey content. Matched by prefix rather than listed one by one.
def is_psu_var(var):
    return var.startswith("REGION") or var.startswith("Region")

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


def load_drop_set(wave):
    """Read the editable per-wave audit CSV, return slugs the user marked as drop."""
    import csv as _csv
    path = os.path.join(DATA, f"questions_{wave}.csv")
    drops = set()
    if not os.path.exists(path):
        return drops
    with open(path, encoding="utf-8-sig") as f:
        for row in _csv.DictReader(f):
            mark = (row.get("drop") or "").strip().lower()
            if mark in ("drop", "yes", "y", "1", "x", "true"):
                drops.add((row.get("slug") or "").strip())
    return drops


def emit_audit_csv(wave, candidates, drops_in_csv, df):
    """Rewrite the audit CSV — keeping the user's drop marks for slugs they
    flagged previously, and adding new candidates with empty marks."""
    import csv as _csv
    path = os.path.join(DATA, f"questions_{wave}.csv")
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = _csv.writer(f)
        w.writerow(["slug", "source_var", "label", "n_answers", "non_missing_%", "drop"])
        for c in candidates:
            v = c["var"]; cov = (df[v].notna().mean() * 100) if v in df.columns else 0
            mark = "drop" if c["slug"] in drops_in_csv else ""
            w.writerow([c["slug"], v, c["label"], c["n_answers"], f"{cov:.1f}", mark])


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


def build_for(wave):
    c = WAVE_CONFIG[wave]
    print(f"\n=== wave {wave}: reading harmonised wave file(s) ===")
    if c["stack_all"]:
        df, vl, lab = load_stacked()
    else:
        df, vl, lab = load_wave(c["year"])
        print(f"  {len(df):,} respondents, {df['Country'].nunique()} countries")

    weight_col = "PROJWT"
    if weight_col not in df.columns or df[weight_col].isna().any():
        missing = int(df[weight_col].isna().sum()) if weight_col in df.columns else len(df)
        raise SystemExit(f"wave {wave}: {missing:,} rows have no {weight_col}")

    n = len(df)

    # For the trended page, restrict the catalogue to questions that actually
    # TREND — present in at least 2 of the waves at ≥5% non-missing. Anything
    # asked in only one wave can't have a meaningful time course.
    cross_wave_vars = None
    if c["include_year_dim"] and "Year" in df.columns:
        years = sorted({int(y) for y in df["Year"].dropna().unique() if y > 0})
        cross_wave_vars = set()
        for var in df.columns:
            if var == "Year" or df[var].dtype.kind not in "fi":
                continue
            if var in TRENDED_EXCLUDE_VARS:
                continue
            waves_present = sum(1 for yr in years
                                if df.loc[df["Year"] == yr, var].notna().mean() >= 0.05)
            if waves_present >= 2:
                cross_wave_vars.add(var)
        print(f"  cross-wave restriction: {len(cross_wave_vars)} vars present in "
              f"at least 2 of {len(years)} waves {years}")

    # ---- country index ----
    # Both columns are in the harmonised block of every wave file, fully
    # populated, so the old per-wave country/ISO3 blending is gone.
    cdf = (df[["Country", "COUNTRY_ISO3"]].dropna(subset=["Country"])
             .drop_duplicates("Country").sort_values("Country"))
    countries = [{"name": r[0], "iso3": (r[1] if isinstance(r[1], str) else "")}
                 for r in cdf.itertuples(index=False)]
    missing_iso = [x["name"] for x in countries if not x["iso3"]]
    if missing_iso:
        raise SystemExit(f"wave {wave}: no ISO3 for {missing_iso} - the map would drop them")
    cindex = {x["name"]: i for i, x in enumerate(countries)}
    country_col_arr = df["Country"].map(cindex).fillna(-1).to_numpy(np.int16)
    print(f"  {len(countries)} countries")

    # ---- catalogue: known + auto-discovered ----
    known_by_var = {q[1]: q for q in KNOWN_QUESTIONS}
    columns = []           # (key, np.array, dtype)
    questions, metrics = [], []
    seen_vars = set()
    drops = load_drop_set(wave)
    candidates = []  # every question we'd offer, before drops are applied

    def add_question_record(slug, var, label, kind, extras=None):
        # record candidate (so the CSV always lists every available question,
        # whether or not the user has it dropped)
        n_ans = len((vl.get(var) or {}).keys())
        candidates.append({"slug": slug, "var": var, "label": label, "n_answers": n_ans})
        if slug in drops:
            return
        # encode column
        if var in seen_vars:
            return
        seen_vars.add(var)
        if kind == "index":
            arr = encode_index(df[var].to_numpy())
            columns.append((var, arr, "i8"))
            rec = {"key": slug, "col": var, "kind": "mean", "label": label}
            if var in NOT_COMPARABLE_VARS:
                rec["comparable"] = False
            metrics.append(rec)
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
            # one metric per substantive answer. The slug is the answer label
            # truncated to 24 characters, so two long answers that share an
            # opening phrase used to collide - the second metric then became
            # unreachable and the dropdown showed the same key twice. Fall back
            # to the answer code when that happens.
            short = label
            taken = {mm["key"] for mm in metrics}
            for code in sub_codes:
                a_lab = next(a["label"] for a in ans if a["code"] == code)
                a_slug = re.sub(r"[^A-Za-z0-9]+", "_", str(a_lab))[:24].strip("_").lower() or f"c{code}"
                key = f"{slug}_{a_slug}"
                if key in taken:
                    key = f"{slug}_c{code}"
                taken.add(key)
                metrics.append({"key": key, "col": var, "num": [code],
                                "label": f"{short} — {a_lab} (%)"})

    # 1) Manual catalogue first (better labels / slug names)
    for entry in KNOWN_QUESTIONS:
        slug, var, kind, *rest = entry
        if var not in df.columns:
            continue
        if df[var].notna().mean() * 100 < 0.5:
            continue
        if cross_wave_vars is not None and var not in cross_wave_vars:
            continue  # trended only keeps questions present in every wave
        label = rest[0]
        extras = rest[1] if len(rest) > 1 else None
        add_question_record(slug, var, label, kind, extras)

    # 2) Auto-discover everything else that's categorical & populated
    used_slugs = {q["key"] for q in questions} | {m["key"] for m in metrics}
    for var in df.columns:
        if var in seen_vars or var in AUTO_DISCOVER_EXCLUDE or is_psu_var(var):
            continue
        if var not in vl or len(vl[var]) < 2:
            continue
        # skip if dtype isn't numeric
        if df[var].dtype.kind not in "fi":
            continue
        coverage = df[var].notna().mean() * 100
        if coverage < 1.0:
            continue
        if cross_wave_vars is not None and var not in cross_wave_vars:
            continue  # trended only keeps questions present in every wave
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
    DIM_CAP = 20   # country + region + country-income + 6 demog + 11 content = 5×4 grid
    for slug, src_col, dlabel in FILTER_SLOTS:
        if slug == "__demog__":
            continue
        if src_col is None or src_col not in df.columns:
            continue
        if df[src_col].notna().mean() * 100 < 1.0:
            continue
        if cross_wave_vars is not None and src_col not in cross_wave_vars:
            # On the trended page a filter that only bites on one wave costs a
            # slot in a 20-slot grid and silently empties three of the four
            # bars. Same rule as the questions: at least two waves.
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

    # ---- catalogue sanity: the browser keys questions, metrics and dimensions
    # by slug, so a duplicate makes one of the pair unreachable and the URL
    # ambiguous. Fail the build rather than ship it.
    for field, items in (("question", questions), ("metric", metrics),
                         ("dimension", dimensions)):
        keys = [x["key"] for x in items]
        dupes = sorted({k for k in keys if keys.count(k) > 1})
        if dupes:
            raise SystemExit(f"wave {wave}: duplicate {field} keys {dupes}")

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

    # Audit CSV — every candidate question this wave offers, with the user's
    # previous "drop" marks preserved. To drop a question from the page, mark
    # the `drop` column (any of: drop / yes / y / 1 / x / true) and re-run.
    emit_audit_csv(wave, candidates, drops, df)
    n_dropped = len(drops)
    print(f"  audit CSV: questions_{wave}.csv  ({len(candidates)} candidates, "
          f"{n_dropped} dropped -> {len(questions)} questions in manifest)")


def build_country_waves_index():
    """Country-by-wave roll-up (sample n and PROJWT-weighted total per cell)
    used by the explorer's Dataset details tab. Written to
    data/country_waves.json once.

    Source: the four harmonised wave files (build_wrp_waves.py output), one per
    wave. This used to read trended_wrp.sav, which drops the respondents Gallup
    left out of the cross-wave file - the tab then reported 137 countries in
    2019 and 120 in 2021, while the wave datasets the explorer actually loads
    hold 142 and 121. Reading the per-wave files makes the coverage table agree
    with the waves it describes.
    """
    print("\n=== building data/country_waves.json (country x wave roll-up) ===")
    frames = []
    for year in (2019, 2021, 2023, 2025):
        path = os.path.join(CLEAN_DIR, f"WRP_{year}", f"WRP_{year}.parquet")
        if not os.path.exists(path):
            raise SystemExit(
                f"Harmonised wave file not found at {path}. Point WRP_CLEAN_DIR at the "
                "'Datafile cleaning/output' folder, or re-run build_wrp_waves.py."
            )
        part = pd.read_parquet(path, columns=["Country", "COUNTRY_ISO3", "PROJWT"])
        part["Year"] = year
        print(f"  {year}: {len(part):,} respondents, {part['Country'].nunique()} countries")
        frames.append(part)
    df = pd.concat(frames, ignore_index=True)
    df = df.dropna(subset=["Country", "Year"])
    df["Year"] = df["Year"].astype(int)

    summary = []
    countries = sorted(df["Country"].dropna().unique())
    for cname in countries:
        sub = df[df["Country"] == cname]
        iso3 = ""
        iso_vals = sub["COUNTRY_ISO3"].dropna().unique()
        if len(iso_vals): iso3 = str(iso_vals[0])
        by_wave = {}
        for yr in sorted(sub["Year"].unique()):
            ysub = sub[sub["Year"] == yr]
            by_wave[str(int(yr))] = {
                "n":   int(ysub["PROJWT"].notna().sum()),
                "pop": int(round(ysub["PROJWT"].fillna(0).sum())),
            }
        # also a grand "all" row for the rightmost column
        by_wave["all"] = {"n": int(sub["PROJWT"].notna().sum()),
                          "pop": int(round(sub["PROJWT"].fillna(0).sum()))}
        summary.append({"name": cname, "iso3": iso3, "by_wave": by_wave})

    out_path = os.path.join(DATA, "country_waves.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"waves": ["2019", "2021", "2023", "2025"], "countries": summary},
                  f, separators=(",", ":"), ensure_ascii=False)
    print(f"  wrote {out_path}  ({len(summary)} countries)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wave", required=True, choices=list(WAVE_CONFIG.keys()) + ["all"])
    args = ap.parse_args()

    waves = list(WAVE_CONFIG.keys()) if args.wave == "all" else [args.wave]
    for w in waves:
        build_for(w)
    if args.wave == "all":
        build_country_waves_index()


if __name__ == "__main__":
    main()
