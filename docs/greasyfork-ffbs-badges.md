Shows **FairFight (FF)** and **estimated battle stats (BS)** next to player names all over Torn, using [FFScouter](https://ffscouter.com) estimates, plus live hospital / travel timers on faction and war pages.

Works on **Torn PDA** and desktop userscript managers (Tampermonkey, Violentmonkey).

## Features

- **FF / BS badges** next to player names and avatars. FF is shown the way Torn applies it: capped at 3, with `3↑` when the player is rated stronger than you (FFScouter's raw value is in the tooltip, and this can be turned off). FF is coloured by how good a fight it is. BS is coloured relative to *your own* total battle stats (you need a Limited key for this, otherwise BS badges stay grey).
- **Hospital & travel timers**: a countdown pill on names and a live Status column in faction and ranked-war member lists. The pill pulses in the last seconds before someone leaves hospital.
- **Sort & filter bar** on faction and war member lists: sort by FF, BS or hospital time, show "Okay" members only, with a live `Okay n/m` counter.
- **War pages**: finds the enemy faction automatically and shows their timers.
- **Don't-attack list**: load your ranked-war opponent, an ally or any faction by ID in the settings and tick the players to leave alone (termed-war terms, allies), or add single players. You can also protect your own faction. Protected players get a ✋ badge, listed ones a red row, they sink to the bottom of sorted lists, and their attack page shows a red warning banner. Warnings only; nothing is blocked.
- **Teammates hidden**: no FF/BS badges on your own faction members, which also saves lookups. This can be turned off.
- **Settings panel (⚙)** in Torn's footer button row:
  - Badge style (Classic / Solid dark / Bright), size and position
  - Colour thresholds, with a live preview
  - Light / dark theme, following Torn automatically
  - Cache length and a cache clear button
- **Light on the API**: FF/BS results are cached on your device (72 h by default), requests are queued and back off on errors, and only players on screen are looked up.

## Setup

1. Sign up at [ffscouter.com](https://ffscouter.com) with your Torn API key. Free; only registered keys work.
2. Install the script and open any Torn page. A setup card asks for that key once.
3. Optional: use a **Limited** key so BS badges can be coloured against your own stats.

The script only displays information. It never clicks or acts in the game for you.

## API key usage (Torn API ToS)

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
|---|---|---|---|---|
| Only locally: settings, the don't-attack list and the FF/BS cache stay in your browser | Nobody. The player IDs on the page are sent to FFScouter to look up their estimates | Competitive advantage: FF / battle-stat estimates and hospital / travel timers for choosing targets, and faction member lists (war opponent, allies) for the don't-attack list | Stored locally on your device. Shared with FFScouter (ffscouter.com) to fetch estimates | Public. Limited recommended (`user → battlestats`, for BS colours) |

See also [FFScouter's privacy policy](https://ffscouter.com/privacy).

## Works with Torn Chat Panel

[Torn Chat Panel](https://greasyfork.org/en/scripts/598409-torn-chat-panel), a messenger-style view of Torn's chat, shows the same FF / BS estimates next to names in chat. It reads them from this script's cache, so it makes no extra lookups.

## Source & support

Source code, issues and changelog: [github.com/nebigoktug/torn-userscripts](https://github.com/nebigoktug/torn-userscripts)
