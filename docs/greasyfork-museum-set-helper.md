Every **museum set** in one panel: flowers, plushies and artifacts (coins, arrowheads, sculptures, Companion Scripts, Senet, the amulet…). See what you own, which sets are complete, what's missing for your target, where to buy it, what it costs, and whether exchanging the sets for points is worth it.

Works on **Torn PDA** and desktop userscript managers (Tampermonkey, Violentmonkey).

## Features

- **Flowers, Plushies and Artifacts tabs**, with a picker for the different artifact sets and the points each set gives.
- **Your counts**: complete sets, and per item how many you have and how many are missing for a target number of sets.
- **Where to buy**: the country each flower and plushie is sold in abroad.
- **What it costs**: the cheapest way to buy the missing items, across item market listings and player bazaars (bazaars via [weav3r.dev](https://weav3r.dev); `B` marks a bazaar price, tap to open it).
- **Points profit**: the current points price, the value of a set in points (Museum Day +10% optional), what a full set costs, and your profit or loss for the target.
- **Live counts**: the Torn API caches your inventory for up to an hour. Tap **Live counts** for up-to-the-second numbers, or open the Flowers / Plushies / Artifacts tab on your Items page and the panel picks the numbers up from there.

The script only reads and shows. It never buys, travels or clicks anything.

On desktop, bazaar prices may not load because of Torn's page security settings; item market prices always work.

## Torn's scripting rules

**Live counts** makes one request to your Items page's list for the open tab (`item.php`, the same request Torn's own Items page makes). It is a non-API request, so it only happens when you tap the button: one request per tap, with a 15-second cooldown. Nothing is requested automatically. On the Items page, the script also reads the lists Torn itself loads when you open those tabs.

## API key usage (Torn API ToS)

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
|---|---|---|---|---|
| Only locally: your key, targets, a 10-minute price cache and the artifact item list stay in your browser | Nobody. Your key goes only to api.torn.com. Bazaar prices come from weav3r.dev (public, no key or player data sent) | Personal gain: planning museum sets | Stored locally on your device. Not shared | Minimal (`user → inventory`). Item list and market prices use public data |

## Source & support

Source code, issues and changelog: [github.com/nebigoktug/torn-userscripts](https://github.com/nebigoktug/torn-userscripts)

If it helps you fill the museum, a Xanax or a few $ to [Nebigoktug [3980062]](https://www.torn.com/profiles.php?XID=3980062) keeps it going ❤️
