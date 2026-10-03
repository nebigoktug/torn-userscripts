A swing-trading helper for **Torn's stock market**. It shows which stock has dipped furthest below its recent average (a buy candidate) and, for your open trades, the target sell price and the "sell by" day.

Works on **Torn PDA** and desktop userscript managers (Tampermonkey, Violentmonkey).

## The rule

> Buy the stock that is furthest below its 7-day average (at least 1% below).
> Sell at +2%, or after 14 days, whichever comes first. One trade at a time.

Backtested on daily closes for all Torn stocks, with Torn's 0.1% sell fee included:
- **+17% to +57% a year** in each of the last four years.
- Simply holding a stock made +3% to +6%, and lost 12% in one year.
- Every nearby setting (5–10 day average, 0.5–1.5% dip, 1.5–3% target) was also positive in every year.

**Past results are no guarantee**, and this is a game helper, not financial advice. The four numbers are settings you can change.

## Features

- **Buy candidate**: the stock furthest below its average, plus the full list with each stock's distance from its average.
- **Your open trades**: buy price, target price, gain so far and the sell-by date. Several recent buys of the same stock are merged into one trade. Holdings older than 60 days count as long-term and are left out.
- **Banner on the stock market page** with what to do now. It can be moved (hold and drag).

The script only reads and shows. It never buys or sells.

## Data and API key usage (Torn API ToS)

Live prices and your trades come from the Torn API. Daily price history comes from [tornsy.com](https://tornsy.com), a public Torn stock-data site. No key or player data is sent there, and history is fetched once a day. On desktop, your userscript manager will ask once to allow connections to tornsy.com.

| Data Storage | Data Sharing | Purpose of Use | Key Storage & Sharing | Key Access Level |
|---|---|---|---|---|
| Only locally: your key, settings and a small price history stay in your browser | Nobody. Your key goes only to api.torn.com. Price history comes from tornsy.com (public, nothing sent) | Personal gain: stock-trading suggestions | Stored locally on your device. Not shared | Limited (`user → stocks`, for your open trades). Prices alone work with a Public key |

## Source & support

Source code, issues and changelog: [github.com/nebigoktug/torn-userscripts](https://github.com/nebigoktug/torn-userscripts)

If a dip trade pays off, a Xanax or a few $ to [Nebigoktug [3980062]](https://www.torn.com/profiles.php?XID=3980062) keeps it going ❤️
