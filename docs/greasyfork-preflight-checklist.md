A checklist on the **Travel Agency** that answers one question before you fly: *is anything going to go to waste, or go wrong, while I'm away?*

Works on **Torn PDA** and desktop userscript managers (Tampermonkey, Violentmonkey).

## What it checks

Everything is compared with the real round trip for the destination and flight type you pick (flight times from the Torn wiki).

- **Energy and nerve**: will they cap while you're away, and roughly how much regen you'd waste. Bars already stacked above max are recognised.
- **Drug and booster cooldowns**: empty (nothing ticking while you fly) or running out before you're back.
- **Cash**: enough for the ticket and the shopping budget you set, or extra cash you should bank before you go (mug risk).
- **Faction**: a ranked war starting or running, a chain in progress, or your Organized Crime becoming ready while you're abroad.
- **Reminders**: weapons and armor don't fly, and Tourism Day doubles your carrying capacity.

A short banner on the Travel Agency lists only what needs attention. Tap it for the full checklist. The banner can be moved (hold and drag).

The script only reads and shows. It never books, buys or clicks anything.

## API key usage (Torn API ToS)

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
|---|---|---|---|---|
| Only locally: your key and trip settings stay in your browser | Nobody. Requests go only to api.torn.com | Personal gain: checking your status before a flight | Stored locally on your device. Not shared | Minimal (`user → bars, cooldowns, organizedcrime, travel`). Ranked wars use public data |

Your cash is read from Torn's own sidebar on the page you are viewing.

## Source & support

Source code, issues and changelog: [github.com/nebigoktug/torn-userscripts](https://github.com/nebigoktug/torn-userscripts)

If it saves you a wasted bar, a Xanax or a few $ to [Nebigoktug [3980062]](https://www.torn.com/profiles.php?XID=3980062) is always welcome ❤️
