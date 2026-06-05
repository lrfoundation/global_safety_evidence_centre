#!/usr/bin/env python3
"""
build_wrp_data.py — rebuild the World Risk Poll Cup dataset from the source SPSS files.

IMPORTANT: this is a RECONSTRUCTION, not the original generator. It was written to
match the methodology the dataset documents about itself (the `meta` block of
world_risk_poll_data.json): the four source files, the per-wave weight variables,
the England/Scotland region split, the composite "A threat" code, and the
"proportions over full non-null base, DK/Refused dropped from output" rule.

The question keys (L17A, WP20719, …) are the real SPSS variable names, so those are
known. Two things you should check against your actual .sav files before trusting the
output, because they can't be inferred from the JSON alone:
  1. COUNTRY_VAR — the country variable name per wave (WRP public files have used
     COUNTRYNEW; confirm for each wave).
  2. DK_CODES / REFUSED_CODES — the missing-answer codes to keep in the denominator
     but drop from the output rows.

Requires: pandas, pyreadstat  (pip install pandas pyreadstat)
Usage:    python build_wrp_data.py  ->  writes world_risk_poll_data.json
"""

import json
from collections import OrderedDict

import pandas as pd
import pyreadstat

PROP_DECIMALS = 4

# --- Per-wave configuration ---------------------------------------------------
# weight: weighting variable for that wave's file
# country_var: country identifier (value-labelled numeric in the WRP public files)
# uk_region_var: the "Region United Kingdom" variable used to split England/Scotland
# questions: SPSS variable names asked in that wave that feed the tournament
WAVES = OrderedDict({
    2019: dict(
        path="19_wrp.sav",
        weight="WGT",
        country_var="COUNTRYNEW",
        uk_region_var="Region_United_Kingdom",
        questions=["L17A", "L11"],
    ),
    2021: dict(
        path="lrf_world_risk_poll_2021_with_trended_data.sav",
        weight="PROJWT_2",
        country_var="COUNTRYNEW",
        uk_region_var="Region_United_Kingdom",
        questions=["WP22226", "WP22227"],
    ),
    2023: dict(
        path="LRF_WAVE_3_PUBLIC_RELEASE.sav",
        weight="PROJWT",
        country_var="COUNTRYNEW",
        uk_region_var="Region_United_Kingdom",
        questions=["WP23341", "WP23342", "WP22232"],
    ),
    2025: dict(
        path="wrp_25_.sav",
        weight="PROJWT",
        country_var="COUNTRYNEW",
        uk_region_var="Region_United_Kingdom",
        questions=["WP20719", "WP24225"],
    ),
})

# Overall display order of questions in the app
QUESTION_ORDER = ["L17A", "L11", "WP22226", "WP22227",
                  "WP23341", "WP23342", "WP22232", "WP20719", "WP24225"]

# Missing-answer codes: kept in the denominator (DK) / part of the non-null base,
# but never emitted as answer rows. Confirm these against your codebooks.
DK_CODES = {98}
REFUSED_CODES = {99}
DROP_FROM_OUTPUT = DK_CODES | REFUSED_CODES

# Derived composite answers: a synthetic code summing several substantive codes.
# WP20719 "A threat" = "Very serious threat" (1) + "Somewhat serious threat" (2).
COMPOSITES = {
    "WP20719": dict(code=-1, label="A threat", of=[1, 2]),
}

# England/Scotland split on the UK region variable.
# England = regions 1-5, 7, 8, 10, 11 ; Scotland = region 6.
UK_COUNTRY_NAME = "United Kingdom"
ENGLAND_REGIONS = {1, 2, 3, 4, 5, 7, 8, 10, 11}
SCOTLAND_REGIONS = {6}

# Optional: normalise SPSS country labels to the names the app expects.
COUNTRY_RENAME = {
    "Turkey": "Turkiye",
    "Cote d'Ivoire": "Ivory Coast",
    "Congo, Dem. Rep.": "Congo (Kinshasa)",
    "Democratic Republic of the Congo": "Congo (Kinshasa)",
}

# Countries that fill the 48-team draw but have no public WRP data; the app adds
# these as placeholders that forfeit. They are NOT produced here.
FORFEIT_PLACEHOLDERS = ["Qatar", "Iran", "Haiti", "Curaçao", "Cape Verde"]


def round_p(x):
    return round(float(x), PROP_DECIMALS)


def weighted_answers(sub, qvar, weight, value_labels, wave):
    """Compute one country's answer block for one question."""
    s = sub[[qvar, weight]].dropna(subset=[qvar])
    if s.empty:
        return None

    # Base = full non-null base (includes DK/Refused per the documented rule).
    base_w = s[weight].sum()
    base_n = len(s)
    if base_w <= 0:
        return None

    answers = []
    # Substantive codes only (DK/Refused excluded from output rows).
    codes = sorted(c for c in s[qvar].dropna().unique() if int(c) not in DROP_FROM_OUTPUT)
    pmap = {}
    for code in codes:
        code = int(code)
        w = s.loc[s[qvar] == code, weight].sum()
        p = round_p(w / base_w)
        pmap[code] = p
        answers.append({
            "code": code,
            "label": value_labels.get(code, str(code)),
            "p": p,
        })

    # Prepend any composite for this question.
    comp = COMPOSITES.get(qvar)
    if comp:
        cp = round_p(sum(pmap.get(c, 0.0) for c in comp["of"]))
        answers.insert(0, {"code": comp["code"], "label": comp["label"],
                           "p": cp, "composite": True})

    return {
        "label": COLUMN_LABELS.get(qvar, qvar),
        "wave": wave,
        "n": base_n,
        "answers": answers,
    }


COLUMN_LABELS = {}  # filled as files are read


def resolve_country(row, country_labels, uk_region_var):
    """Map a respondent row to a display country name, splitting the UK."""
    name = country_labels.get(int(row["_country_code"]), None)
    if name is None:
        return None
    name = COUNTRY_RENAME.get(name, name)
    if name == UK_COUNTRY_NAME:
        reg = row.get(uk_region_var)
        if pd.isna(reg):
            return None
        reg = int(reg)
        if reg in ENGLAND_REGIONS:
            return "England"
        if reg in SCOTLAND_REGIONS:
            return "Scotland"
        return None  # other UK regions not used
    return name


def main():
    countries = {}
    question_meta = OrderedDict()

    for wave, cfg in WAVES.items():
        df, meta = pyreadstat.read_sav(cfg["path"], apply_value_formats=False)
        country_labels = meta.variable_value_labels.get(cfg["country_var"], {})
        country_labels = {int(k): v for k, v in country_labels.items()}

        # Record question labels and per-question value labels.
        for qvar in cfg["questions"]:
            COLUMN_LABELS[qvar] = meta.column_names_to_labels.get(qvar, qvar)
            question_meta[qvar] = {"label": COLUMN_LABELS[qvar], "wave": wave}

        df = df.copy()
        df["_country_code"] = df[cfg["country_var"]]
        df["_country"] = df.apply(
            lambda r: resolve_country(r, country_labels, cfg["uk_region_var"]), axis=1)
        df = df.dropna(subset=["_country", cfg["weight"]])

        for qvar in cfg["questions"]:
            vlabels = {int(k): v for k, v in
                       meta.variable_value_labels.get(qvar, {}).items()}
            for cname, sub in df.groupby("_country"):
                block = weighted_answers(sub, qvar, cfg["weight"], vlabels, wave)
                if block and block["answers"]:
                    countries.setdefault(cname, {})[qvar] = block

    out = OrderedDict()
    out["meta"] = {
        "n_countries": len(countries),
        "n_questions": len(QUESTION_ORDER),
        "weight_var": "PROJWT (2023/25), PROJWT_2 (2021), WGT (2019)",
        "prop_decimals": PROP_DECIMALS,
        "source_files": ", ".join(c["path"] for c in WAVES.values()),
        "notes": ("Authoritative public-release build. Real England/Scotland split "
                  "via each wave's 'Region United Kingdom' variable "
                  "(England=regions 1-5,7,8,10,11; Scotland=region 6). "
                  "Worry/experience removed. Proportions over full non-null base "
                  "(DK in denominator); DK/Refused dropped from output."),
    }
    out["question_order"] = QUESTION_ORDER
    out["question_meta"] = {q: question_meta[q] for q in QUESTION_ORDER if q in question_meta}
    # Stable country ordering: as first encountered, matching the app's expectations.
    out["countries"] = countries

    with open("world_risk_poll_data.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote world_risk_poll_data.json — {len(countries)} countries, "
          f"{len(QUESTION_ORDER)} questions.")
    print("Forfeit placeholders the app adds separately:", ", ".join(FORFEIT_PLACEHOLDERS))


if __name__ == "__main__":
    main()
