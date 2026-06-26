#!/usr/bin/env python3
"""
Audit which variables exist in each World Risk Poll wave file, so we can
plan the per-wave explorer builds against actual coverage rather than
guesses.

Reads:
  data/19_wrp.sav   data/21_wrp.sav   data/23_wrp.sav
  data/trended_wrp.sav   (with `Year` column, 2019 / 2021 / 2023)
  data/wrp_25.sav

Writes:
  data/wave_audit.csv         — every variable seen in any file, with
                                presence flag + per-year non-missing %
                                (from the trended file where available)
                                + flag if it's in the 2025 catalogue.
  data/wave_audit_summary.txt — human-readable summary printed to stdout
                                and saved alongside the CSV.

Run:
  python scripts/audit_waves.py
"""
import os, sys, csv
from collections import defaultdict
import numpy as np
import pyreadstat

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, "..", "data"))

FILES = {
    "2019":    "19_wrp.sav",
    "2021":    "21_wrp.sav",
    "2023":    "23_wrp.sav",
    "2025":    "wrp_25.sav",
    "trended": "trended_wrp.sav",
}

# Variables the current 2025 explorer treats as questions, metrics, dimensions, weight.
# Keep this in sync with build_explorer_data.py — we just want a presence check here.
CATALOGUE_2025 = {
    # WORRY
    "WP20719", "WP24225", "WP20720", "WP20721", "WP20722", "WP20723",
    "WP24174", "WP24173", "WP24175", "WP20726", "WP22213", "WP22214",
    # EXPERIENCE
    "WP22442", "WP22443", "WP22444", "WP22445", "WP24177", "WP24176",
    "WP24178", "WP22446", "WP22447", "WP22448",
    # TRUST / care
    "WP22231", "WP22469", "WP22232",
    # BINARY disaster / resilience
    "WP24213", "WP24198", "WP24386", "WP24215", "WP23345", "WP22252", "WP22228",
    # DISC
    "WP22259", "WP22260", "WP22261", "WP22262", "WP22263",
    # WARN
    "WP24181", "WP24182", "WP24183", "WP24184",
    "WP24185", "WP24186", "WP24187", "WP24188",
    # GREATEST
    "WP22331",
    # demographics
    "WP1219", "WP1220RECODED_1", "WP3117", "INCOME_5", "DEGURBA", "EMP_2010",
    "RegionLRF", "wbi",
    # indices
    "worry_index", "experience_index", "resilience_index",
    "resilience_idv", "resilience_hhl", "resilience_com", "resilience_soc",
    # core
    "WPID", "COUNTRYNEW", "COUNTRY_ISO3", "PROJWT",
}


def read_meta(path):
    _, meta = pyreadstat.read_sav(path, metadataonly=True)
    return meta


def main():
    metas = {}
    rows_per = {}
    print("Reading metadata for each file:")
    for wave, fname in FILES.items():
        p = os.path.join(DATA, fname)
        if not os.path.exists(p):
            print(f"  ! {wave}: {fname} missing — skipping")
            continue
        m = read_meta(p)
        metas[wave] = m
        rows_per[wave] = m.number_rows
        print(f"  {wave:8s} {fname:24s}  {m.number_rows:>9,} rows  {len(m.column_names):>4} cols")

    # Union of all variable names across the per-wave files (NOT the trended file —
    # that one is its own thing and we don't want its harmonised duplicates
    # confusing the per-wave coverage column).
    all_vars = set()
    for wave in ("2019", "2021", "2023", "2025"):
        if wave in metas:
            all_vars.update(metas[wave].column_names)
    # Always include the catalogue, even if a wave drops them.
    all_vars.update(CATALOGUE_2025)

    # Per-year non-missing % from the trended file (most reliable signal
    # for whether a question was actually asked in a wave, not just present
    # as an empty column).
    trended_nonmissing = {}   # var -> {year: pct}
    trended_year_n = {}       # year -> total rows
    if "trended" in metas:
        print("\nReading trended_wrp.sav columns for per-year non-missing %% (this can take a minute)...")
        keep = [c for c in metas["trended"].column_names if c in all_vars or c == "Year"]
        df, _ = pyreadstat.read_sav(os.path.join(DATA, FILES["trended"]), usecols=keep)
        if "Year" in df.columns:
            for yr, sub in df.groupby("Year"):
                yr_int = int(yr) if not np.isnan(yr) else None
                if yr_int is None:
                    continue
                trended_year_n[yr_int] = len(sub)
                for c in sub.columns:
                    if c == "Year":
                        continue
                    nm = sub[c].notna().mean() * 100
                    trended_nonmissing.setdefault(c, {})[yr_int] = nm

    # Build the CSV
    out_csv = os.path.join(DATA, "wave_audit.csv")
    fieldnames = [
        "variable", "label_2025_or_trended",
        "in_2019", "in_2021", "in_2023", "in_2025", "in_trended",
        "trended_nm_2019", "trended_nm_2021", "trended_nm_2023",
        "in_2025_catalogue",
    ]
    with open(out_csv, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for v in sorted(all_vars):
            # prefer 2025 label, fall back to trended, then any wave that has it
            label = ""
            for wave in ("2025", "trended", "2023", "2021", "2019"):
                if wave in metas:
                    label = metas[wave].column_names_to_labels.get(v, "") or label
                if label:
                    break
            row = {
                "variable": v,
                "label_2025_or_trended": label,
                "in_2019": int(v in metas.get("2019", {} ).column_names) if "2019" in metas else "",
                "in_2021": int(v in metas.get("2021", {} ).column_names) if "2021" in metas else "",
                "in_2023": int(v in metas.get("2023", {} ).column_names) if "2023" in metas else "",
                "in_2025": int(v in metas.get("2025", {} ).column_names) if "2025" in metas else "",
                "in_trended": int(v in metas.get("trended", {} ).column_names) if "trended" in metas else "",
                "trended_nm_2019": f"{trended_nonmissing.get(v, {}).get(2019, ''):.0f}" if trended_nonmissing.get(v, {}).get(2019) is not None else "",
                "trended_nm_2021": f"{trended_nonmissing.get(v, {}).get(2021, ''):.0f}" if trended_nonmissing.get(v, {}).get(2021) is not None else "",
                "trended_nm_2023": f"{trended_nonmissing.get(v, {}).get(2023, ''):.0f}" if trended_nonmissing.get(v, {}).get(2023) is not None else "",
                "in_2025_catalogue": int(v in CATALOGUE_2025),
            }
            w.writerow(row)
    print(f"\nwrote {out_csv}  ({len(all_vars):,} variables)")

    # Human-readable summary
    lines = []
    def p(s=""):
        lines.append(s); print(s)

    p("\n=== Wave audit summary ===")
    p(f"{'wave':10s} {'rows':>10s}  {'cols':>5s}  catalogue Qs covered")
    for wave in ("2019", "2021", "2023", "2025", "trended"):
        if wave not in metas:
            continue
        cols = set(metas[wave].column_names)
        cov = sum(1 for v in CATALOGUE_2025 if v in cols)
        p(f"{wave:10s} {rows_per[wave]:>10,}  {len(cols):>5d}  {cov:>3d} / {len(CATALOGUE_2025)}")

    # What in the 2025 catalogue is missing from each older wave?
    for wave in ("2019", "2021", "2023"):
        if wave not in metas:
            continue
        cols = set(metas[wave].column_names)
        missing = sorted(v for v in CATALOGUE_2025 if v not in cols)
        p(f"\n--- {wave}: {len(missing)} catalogue items NOT in per-wave file ---")
        for v in missing:
            in_t = "trended" if (v in metas.get("trended", {} ).column_names) else "  -  "
            tnm = trended_nonmissing.get(v, {}).get(int(wave), None)
            tnm_s = f"trended non-miss in {wave}: {tnm:.0f}%" if tnm is not None else ""
            p(f"   {v:18s}  via {in_t:7s}  {tnm_s}")

    # Weight + Year column presence — drives the build-script blending plan
    p("\n--- Weight / Year column inventory ---")
    for wave, meta in metas.items():
        wcols = [c for c in meta.column_names if any(k in c.upper() for k in ("WGT","WEIGHT","PROJWT"))]
        ycols = [c for c in meta.column_names if c.upper() in ("YEAR","WAVE")]
        p(f"   {wave:10s} weight: {wcols!s:55s} year: {ycols!s}")

    with open(os.path.join(DATA, "wave_audit_summary.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))


if __name__ == "__main__":
    main()
