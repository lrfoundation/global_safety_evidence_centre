#!/usr/bin/env python3
"""Index definitions shared by the two explorer builders.

The World Risk Poll's published Worry and Experience indices are built
differently in different waves, so each wave's page carries its own. This
module holds the one index that has to be recomputed rather than read from a
column: 2025's Experience Index.

How each wave builds its published indices, read off the data rather than the
documentation. In every case the published value turns out to be a function of
a single raw score, checked as a monotone 1-to-1 map.

Worry Index - score each item 2 (very worried) / 1 (somewhat) / 0 (not), sum,
then scale:

    2019  seven items (L6A-G: food, water, crime, weather, power lines,
          appliances, mental health), Rasch-weighted and min-max scaled to 15
          values.
    2021  seven items (WP20720-6, WP22213-4: power lines and appliances give
          way to traffic and work), same scaling.
    2023  same seven items and scaling as 2021.
    2025  ten items, plain linear score/20 - 21 evenly spaced values.

Experience Index:

    2019  seven items (L8A-G), "did this harm you", Rasch-weighted and min-max
          scaled to eight values. 2019 asked only about the respondent.
    2021  seven items (WP22442-8), "you OR someone you know", same scaling.
    2023  seven items (WP22442-8), "you" only (codes 1 and 3), same scaling.
    2025  ten items, "you" only, a plain mean - eleven evenly spaced values.
          LRF published none, so the harmonised file leaves the column empty
          and experience_index_2025() below rebuilds the wave-4 release's own.

So for the Worry Index the item set and the scaling both move; for the
Experience Index the answer base moves too, between 2021 and 2023. Weighted
global means run 16.2, 23.2, 12.8, 13.9 for the published Experience Index
across the four waves, while the like-for-like experience_score runs 18.5,
21.0, 26.6, 28.7 - the published series falls by nearly half between 2021 and
2023 purely because the base narrowed from "you or someone you know" to "you".
Each figure is right for its own wave and none of them trend against each
other. Both builders mark them "comparable": false in the manifest, and the
browser shows a note under the metric pickers whenever one is selected.

experience_index_2025() rebuilds that column from the ten items. Checked
against wrp_25.sav's own experience_index: identical on all 137,154 rows it
covers, and missing on exactly the same rows.

"""
import numpy as np

# The ten experience items in the 2025 questionnaire, in release order.
EXPERIENCE_ITEMS_2025 = [
    "WP22442",  # eating food
    "WP22443",  # drinking water
    "WP22444",  # violent crime
    "WP22445",  # severe weather
    "WP24177",  # prolonged severe weather
    "WP24176",  # wildfires
    "WP24178",  # the air
    "WP22446",  # traffic
    "WP22447",  # mental health
    "WP22448",  # work
]

# 1 = personally experienced, 2 = know someone, 3 = both, 4 = no.
# "Personally" is codes 1 and 3.
_PERSONALLY = (1, 3)
_ANSWERED = (1, 2, 3, 4)


def experience_index_2025(df, items=None):
    """Series-shaped ndarray: 2025's Experience Index, NaN where incomplete.

    Mean over `items` of "personally experienced", defined only for
    respondents who gave a substantive answer to every item — which is how the
    wave-4 release computes it.
    """
    items = list(items or EXPERIENCE_ITEMS_2025)
    missing = [v for v in items if v not in df.columns]
    if missing:
        raise SystemExit(f"cannot build the 2025 Experience Index, missing {missing}")
    arr = df[items].astype("float64").to_numpy()
    answered = np.isin(arr, _ANSWERED)
    complete = answered.all(axis=1)
    out = np.full(len(df), np.nan)
    out[complete] = np.isin(arr[complete], _PERSONALLY).sum(axis=1) / len(items)
    return out
