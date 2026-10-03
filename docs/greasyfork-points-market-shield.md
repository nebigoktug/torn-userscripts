A **fat-finger guard for selling points** on the Points Market. One missing zero (3,100 instead of 31,000) can give away millions in seconds, because fast buyers snap up underpriced listings almost instantly. This script stops that listing before it is posted.

Works on **Torn PDA** and desktop userscript managers (Tampermonkey, Violentmonkey).

## How it works

While you type a price into the "Add listing" form, it is checked against two floors:

| Price | What happens |
|---|---|
| Below the **hard floor** ($28,000 per point by default) | **Blocked**: the price turns red, the ADD LISTING button is locked, and every way of submitting is cancelled: button, Enter key, and the Yes on Torn's own confirm step |
| Below the **market floor** (95% of the median of the 3 cheapest listings) | **Asks twice**: the first tap opens a dialog with the price, the market price and how much less you would get |
| At or above the market floor | Normal listing |

- The median of the 3 cheapest listings is used, so a single bait or mistaken listing can't lower the floor.
- Torn's price shortcuts are understood: `31k`, `1.5m`, `max`, `half`, `1/4`, `25%`.
- A card under the form shows the market price, the floor and the total you would receive.
- Both floors can be changed in the settings, and the shield can be turned off.

The script never lists, buys or clicks anything on its own. It only blocks or asks.

## Data and API key usage (Torn API ToS)

Market prices come from the Torn API (`market → pointsmarket`). Without a key, the script uses the listings on the page you are viewing. The key is optional.

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
|---|---|---|---|---|
| Only locally: your key and settings stay in your browser | Nobody. Your key goes only to api.torn.com | Personal: protecting your own points listings from typos | Stored locally on your device. Not shared | Public (optional) |

## Source & support

Source code, issues and changelog: [github.com/nebigoktug/torn-userscripts](https://github.com/nebigoktug/torn-userscripts)

If it saved you from a costly typo, a Xanax or a few $ to [Nebigoktug [3980062]](https://www.torn.com/profiles.php?XID=3980062) keeps it going ❤️
