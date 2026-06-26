#!/usr/bin/env python3
"""
Label-based question crosswalk across World Risk Poll waves.

For each conceptual question (slug), scan every .sav file's variable
LABELS and pick the variable(s) whose label matches the slug's keyword
recipe. The point is to map e.g. 2019's `L6A` to the same conceptual
question as 2021/2023/2025's `WP20720`, without us having to read four
codebooks by hand.

Writes:
  data/question_crosswalk.csv          — slug, var per wave, label per wave
  data/question_crosswalk_warnings.txt — slugs that matched nothing in
                                         one or more waves (so we can see
                                         coverage gaps at a glance)

Eyeball the CSV before we wire build_explorer_wave.py to it.
"""
import os, re, csv
import pyreadstat

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

FILES = [
    ("2019",    "19_wrp.sav"),
    ("2021",    "21_wrp.sav"),
    ("2023",    "23_wrp.sav"),
    ("2025",    "wrp_25.sav"),
    ("trended", "trended_wrp.sav"),
]

# A matcher = a slug + an `all=` list of substrings that must all appear in
# the label (case-insensitive), and an optional `none=` list of substrings
# that must NOT. The matcher returns the variable(s) in label order, so
# a slug that should resolve to exactly one var per wave will tell us if it
# accidentally matched multiple.
def m(all_, none=(), names=()):
    return {"all": [s.lower() for s in all_], "none": [s.lower() for s in none],
            "names": tuple(names)}

QUESTIONS = [
    # ---- worry / threat (1=Very, 2=Somewhat, 3=Not at all) ----
    ("climate",            "Climate change a threat to country (next 20 yrs)",
        m(["climate change", "threat"])),
    ("climate_other",      "Most others see climate as a threat",
        m(["most other", "climate"])),
    ("food",               "Worried food could cause serious harm",
        m(["worried", "food"], none=["water", "experienced"])),
    ("water",              "Worried water could cause serious harm",
        m(["worried", "water"], none=["food", "experienced"])),
    ("crime",              "Worried violent crime could cause serious harm",
        m(["worried", "violent crime"], none=["experienced"])),
    ("weather",            "Worried severe weather could cause serious harm",
        m(["worried", "severe weather"], none=["experienced", "prolonged"])),
    ("prolonged_weather",  "Worried prolonged severe weather could cause harm",
        m(["worried", "prolonged"], none=["experienced"])),
    ("wildfires",          "Worried wildfires could cause serious harm",
        m(["worried", "wildfire"], none=["experienced"])),
    ("air",                "Worried the air could cause serious harm",
        m(["worried", "air"], none=["experienced"])),
    ("mental_health",      "Worried mental health could cause serious harm",
        m(["worried", "mental health"], none=["experienced"])),
    ("traffic",            "Worried traffic could cause serious harm",
        m(["worried", "traffic"], none=["experienced"])),
    ("work",               "Worried the work you do could cause serious harm",
        m(["worried", "work"], none=["experienced", "network", "look for", "out of"])),
    # ---- experience (1=personally 2=know someone 3=both 4=no) ----
    ("exp_food",            "Experienced harm: eating food",
        m(["experienced", "food"], none=["worried"])),
    ("exp_water",           "Experienced harm: drinking water",
        m(["experienced", "water"], none=["worried"])),
    ("exp_crime",           "Experienced harm: violent crime",
        m(["experienced", "violent crime"], none=["worried"])),
    ("exp_weather",         "Experienced harm: severe weather",
        m(["experienced", "severe weather"], none=["worried", "prolonged"])),
    ("exp_prolonged_weather","Experienced harm: prolonged severe weather",
        m(["experienced", "prolonged"], none=["worried"])),
    ("exp_wildfires",       "Experienced harm: wildfires",
        m(["experienced", "wildfire"], none=["worried"])),
    ("exp_air",             "Experienced harm: air",
        m(["experienced", "air"], none=["worried"])),
    ("exp_traffic",         "Experienced harm: traffic",
        m(["experienced", "traffic"], none=["worried"])),
    ("exp_mental_health",   "Experienced harm: mental health",
        m(["experienced", "mental health"], none=["worried"])),
    ("exp_work",            "Experienced harm: work",
        m(["experienced", "work"], none=["worried", "network"])),
    # ---- trust / care ----
    ("govt_cares",         "Government cares about your wellbeing",
        m(["government", "care"], none=["authorit"])),
    ("authorities_care",   "Authorities care about your wellbeing",
        m(["authorit", "care"])),
    ("neighbours_care",    "Neighbours care about your wellbeing",
        m(["neighbo", "care"])),
    # ---- disaster / resilience ----
    ("impacted_disaster",  "Experienced / impacted by disaster (past 5 yrs)",
        m(["disaster", "past five years"])),
    ("govt_prepared",      "National government well prepared for a disaster",
        m(["government", "prepared", "disaster"], none=["in power"])),
    ("govt_power_prepared","Government in power well prepared for a disaster",
        m(["in power", "prepared"])),
    ("able_action",        "Able to act on an advance disaster warning",
        m(["able", "act", "warning"])),
    ("plan_known",         "Household disaster plan known by all members",
        m(["plan", "household"])),
    ("could_protect",      "Could protect self/family in a future disaster",
        m(["protect", "future disaster"])),
    ("fin_res",            "Could cover basic needs a month or more if income lost",
        m(["cover", "basic needs"])),
    # ---- discrimination ----
    ("disc_skin",          "Experienced discrimination: skin colour",
        m(["discrimin", "skin"])),
    ("disc_religion",      "Experienced discrimination: religion",
        m(["discrimin", "religion"])),
    ("disc_nationality",   "Experienced discrimination: nationality/ethnicity",
        m(["discrimin"], none=["skin","religion","gender","disabilit","age"])),
    ("disc_gender",        "Experienced discrimination: gender",
        m(["discrimin", "gender"])),
    ("disc_disability",    "Experienced discrimination: disability",
        m(["discrimin", "disabilit"])),
    # ---- greatest source ----
    ("greatest",           "Greatest source of risk to daily safety",
        m(["greatest source", "risk"])),
    # ---- warnings (multiple in 2025; consolidate later) ----
    ("warn_internet",      "Received warning: internet / social media",
        m(["warning", "internet"])),
    ("warn_govt",          "Received warning: local government / police",
        m(["warning", "government"])),
    ("warn_media",         "Received warning: radio, TV or newspapers",
        m(["warning", "radio"])),
    ("warn_community",     "Received warning: local community organisation",
        m(["warning", "community"])),
]

DIMENSIONS = [
    ("country",       "Country (long name)",
        m([], names=["COUNTRYNEW", "COUNTRY", "countrynew"])),
    ("country_iso3",  "Country (ISO3)",
        m([], names=["COUNTRY_ISO3"])),
    ("region",        "Global / regional grouping",
        m([], names=["RegionLRF", "Region", "GlobalRegion"])),
    ("country_income","Country income group (World Bank)",
        m([], names=["wbi", "WB_INCOME", "INCOME_WB"])),
    ("wpid",          "Respondent ID",
        m([], names=["WPID"])),
    ("projwt",        "PROJWT (population-weighted)",
        m([], names=["PROJWT", "PROJWT_2021", "PROJWT_2019"])),
    ("gender",        "Gender of respondent",
        m([], names=["WP1219", "GENDER", "gender"])),
    ("age_5",         "Age (5 groups)",
        m([], names=["WP1220RECODED_1", "AGE5", "age_5"])),
    ("education",     "Education level",
        m([], names=["WP3117", "WP9811", "education"])),
    ("income_q",      "Income quintile (respondent)",
        m([], names=["INCOME_5", "income_quintiles"])),
    ("urban_rural",   "Urban / rural",
        m([], names=["DEGURBA", "urban_rural"])),
    ("employment",    "Employment status",
        m([], names=["EMP_2010", "employment"])),
    ("year",          "Survey year",
        m([], names=["Year", "YEAR", "WAVE"])),
]

INDEX_VARS = [
    ("worry_index",       "Worry index",
        m(["worry", "index"], names=["worry_index", "Worried.Index"])),
    ("experience_index",  "Experience index",
        m(["experience", "index"], names=["experience_index"])),
    ("resilience_index",  "Resilience index (overall)",
        m(["resilience", "index"], none=["individual","household","community","societ"],
          names=["resilience_index"])),
    ("resilience_idv",    "Resilience: individual",
        m(["resilience", "individual"], names=["resilience_idv"])),
    ("resilience_hhl",    "Resilience: household",
        m(["resilience", "household"], names=["resilience_hhl"])),
    ("resilience_com",    "Resilience: community",
        m(["resilience", "community"], names=["resilience_com"])),
    ("resilience_soc",    "Resilience: societal",
        m(["resilience", "societ"], names=["resilience_soc"])),
]


def label_matches(label, recipe):
    L = (label or "").lower()
    return all(s in L for s in recipe["all"]) and not any(s in L for s in recipe["none"])


def find_matches(meta, recipe):
    out = []
    names = set(recipe.get("names") or ())
    for v in meta.column_names:
        if v in names or label_matches(meta.column_names_to_labels.get(v, "") or "", recipe):
            out.append(v)
    return out


def main():
    metas = {}
    for wave, fname in FILES:
        path = os.path.join(DATA, fname)
        if not os.path.exists(path):
            print(f"  ! {wave}: {fname} missing — skipping")
            continue
        _, meta = pyreadstat.read_sav(path, metadataonly=True)
        metas[wave] = meta
        print(f"  loaded metadata for {wave}  ({len(meta.column_names)} cols)")

    rows = []
    warnings = []

    def add_rows(section, items):
        rows.append({"section": section})
        for entry in items:
            slug, descr, recipe = entry
            row = {"section": "", "slug": slug, "description": descr}
            for wave, _ in FILES:
                if wave not in metas:
                    row[f"var_{wave}"] = ""; row[f"label_{wave}"] = ""; continue
                matches = find_matches(metas[wave], recipe)
                row[f"var_{wave}"] = " | ".join(matches)
                row[f"label_{wave}"] = " | ".join(metas[wave].column_names_to_labels.get(v, "") or "" for v in matches)
                if not matches:
                    warnings.append(f"  {section}/{slug}: NO match in {wave}")
            rows.append(row)

    add_rows("QUESTIONS", QUESTIONS)
    add_rows("DIMENSIONS", DIMENSIONS)
    add_rows("INDICES", INDEX_VARS)

    out_csv = os.path.join(DATA, "question_crosswalk.csv")
    fieldnames = ["section", "slug", "description"] + sum(
        ([f"var_{w}", f"label_{w}"] for w, _ in FILES), [])
    with open(out_csv, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            for k in fieldnames:
                r.setdefault(k, "")
            w.writerow(r)
    print(f"\nwrote {out_csv}")

    if warnings:
        warn_path = os.path.join(DATA, "question_crosswalk_warnings.txt")
        with open(warn_path, "w", encoding="utf-8") as f:
            f.write("\n".join(warnings))
        print(f"wrote {warn_path}  ({len(warnings)} unmatched slug/wave pairs)")
    else:
        print("every slug matched in every wave")


if __name__ == "__main__":
    main()
