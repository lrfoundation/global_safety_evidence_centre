/* ============================================================
   Respondent Globe — editorial content.

   This file holds everything a non-developer might want to change
   before a talk: who is in the tour, and how the survey's field-note
   labels get turned into readable English. No logic lives here.

   PLEASE CHECK THE NAMES AND DATES before showing this to a Newcastle
   audience. A wrong club history is worse than no persona at all.
   ============================================================ */

/* The tour, in running order. Every iso3 below is confirmed present in
   wrp_explorer_trended.json.

   `avoid` lists question keys that must never be quoted on that
   person's card. Cheick Tioté and Christian Atsu both died young —
   Atsu in the 2023 Kahramanmaraş earthquake — so their cards are kept
   away from disaster, severe-weather and climate material. That is a
   deliberate editorial guardrail, not a technical constraint. If you
   would rather they were not in the tour at all, delete the two rows. */
export const REEL = [
  { iso3: 'GBR', name: 'Alan Shearer',         club: 'Newcastle United 1996–2006' },
  { iso3: 'PER', name: 'Nobby Solano',         club: '1998–2004, 2005–07' },
  { iso3: 'COL', name: 'Faustino Asprilla',    club: '1996–98' },
  { iso3: 'FRA', name: 'David Ginola',         club: '1995–97' },
  { iso3: 'BRA', name: 'Bruno Guimarães',      club: '2022–' },
  { iso3: 'SWE', name: 'Alexander Isak',       club: '2022–' },
  { iso3: 'PRY', name: 'Miguel Almirón',       club: '2019–25' },
  { iso3: 'SEN', name: 'Papiss Cissé',         club: '2012–16' },
  { iso3: 'IRL', name: 'Shay Given',           club: '1997–2009' },
  { iso3: 'ARG', name: 'Fabricio Coloccini',   club: '2008–16' },
  { iso3: 'NGA', name: 'Obafemi Martins',      club: '2006–09' },
  { iso3: 'CIV', name: 'Cheick Tioté',         club: '2010–17', avoid: ['weather', 'exp_weather', 'climate', 'impacted_disaster_t', 'could_protect'] },
  { iso3: 'GHA', name: 'Christian Atsu',       club: '2016–21', avoid: ['weather', 'exp_weather', 'climate', 'impacted_disaster_t', 'could_protect'] },
  { iso3: 'COD', name: 'Lomana LuaLua',        club: '2000–04' },
  { iso3: 'JPN', name: 'Yoshinori Muto',       club: '2018–20' },
  { iso3: 'KOR', name: 'Ki Sung-yueng',        club: '2018–20' },
  { iso3: 'USA', name: 'DeAndre Yedlin',       club: '2016–20' },
  { iso3: 'NLD', name: 'Tim Krul',             club: '2006–17' },
  { iso3: 'SVK', name: 'Martin Dúbravka',      club: '2018–' },
  { iso3: 'CHE', name: 'Fabian Schär',         club: '2018–' },
  { iso3: 'TUR', name: 'Emre Belözoğlu',       club: '2005–08' },
  { iso3: 'SRB', name: 'Aleksandar Mitrović',  club: '2015–18' },
  { iso3: 'ESP', name: 'Ayoze Pérez',          club: '2014–19' },
  { iso3: 'PRT', name: 'Hugo Viana',           club: '2002–06' },
  { iso3: 'ITA', name: 'Fabrizio Ravanelli',   club: '1997–99' },
  { iso3: 'DEU', name: 'Dietmar Hamann',       club: '1998–99' },
  { iso3: 'GRC', name: 'Nikos Dabizas',        club: '1998–2004' },
  { iso3: 'DNK', name: 'Jon Dahl Tomasson',    club: '1997–98' },
  { iso3: 'DZA', name: 'Nabil Bentaleb',       club: '2021' }
];

/* The manifest's question labels are field notes ("Worried food could
   cause serious harm"). These are what goes on the card. */
export const SHORT_LABEL = {
  climate:             'Climate change',
  food:                'Worried about food',
  water:               'Worried about water',
  crime:               'Worried about violent crime',
  weather:             'Worried about severe weather',
  mental_health:       'Worried about mental health',
  traffic:             'Worried about road traffic',
  work:                'Worried about work',
  exp_food:            'Harmed by food',
  exp_water:           'Harmed by water',
  exp_crime:           'Harmed by violent crime',
  exp_weather:         'Harmed by severe weather',
  exp_traffic:         'Harmed by traffic',
  exp_mental_health:   'Harmed by mental health',
  exp_work:            'Harmed at work',
  greatest:            'Greatest risk to daily safety',
  safer_5yr:           'Compared with five years ago',
  fin_res:             'If income stopped',
  could_protect:       'Could protect their family',
  govt_cares:          'Government cares about them',
  neighbours_care:     'Neighbours care about them',
  impacted_disaster_t: 'Hit by a disaster in five years',
  plan_known:          'Household disaster plan'
};

/* WP22331's 25 answer labels are ALL-CAPS field notes up to 100
   characters, and code 14 carries a mojibake character. None of them
   can go on a slide as-is. */
export const GREATEST_SHORT = {
  1:  'road traffic',
  2:  'trains, boats and planes',
  3:  'crime and violence',
  4:  'war or terrorism',
  5:  'their own health',
  6:  'drugs, alcohol or smoking',
  7:  'COVID-19',
  8:  'stress and exhaustion',
  9:  'not having enough money',
  10: 'the economy',
  11: 'politics and corruption',
  12: 'technology',
  13: 'unclean water',
  14: 'unsafe food',
  15: 'hunger',
  16: 'accidents at home',
  17: 'injuries at work',
  18: 'pollution',
  19: 'climate and severe weather',
  20: 'earthquakes and volcanoes',
  21: 'drowning',
  22: 'something else',
  23: 'nothing at all'
};

/* Answer labels that read badly mid-sentence. Anything not listed here
   falls through to the manifest's own label, lower-cased. */
export const ANSWER_SHORT = {
  climate:       { 1: 'a very serious threat', 2: 'a somewhat serious threat', 3: 'not a threat at all' },
  safer_5yr:     { 1: 'more safe', 2: 'less safe', 3: 'about as safe' },
  fin_res:       { 1: 'could cover basic needs for under a week', 2: 'could cover basic needs for weeks', 3: 'could cover basic needs for a month or more', 4: 'could not cover basic needs at all' }
};

/* Polygons whose centroid falls outside these boxes are dropped before
   area weighting. Without this, 13% of French respondents land in French
   Guiana and ~16% of Norwegians on Svalbard — which reads as a bug from
   the back of a room. Only territories large enough to be noticed are
   listed; everything under about 1% is left alone.
   The United States is deliberately absent: Alaska is genuinely surveyed
   as part of the US sample, and it is 15% of the country's area. */
export const HOMELAND = {
  FRA: [-5.5,  41.0, 10.0, 51.5],
  NOR: [ 4.0,  57.5, 32.0, 71.5],
  NLD: [ 3.0,  50.5,  7.5, 53.8],
  PRT: [-9.6,  36.8, -6.0, 42.2],
  ESP: [-9.4,  35.9,  4.4, 43.9],
  ZAF: [16.0, -35.0, 33.0, -22.0]
};
