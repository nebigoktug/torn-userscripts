# torn-userscripts

Torn City userscripts.

| Script | What it does |
|---|---|
| [Torn FF/BS Badges](Torn_FFBS_Badges.user.js) | FairFight + estimated battle-stat badges next to player names (via FFScouter), live hospital/travel timers, a sort/filter bar on faction and war member lists, and a don't-attack list with an attack-page warning. Works on Torn PDA and desktop. |
| [Torn Graffiti Helper](Torn_Graffiti_Helper.user.js) | Rep progress, colour suggestions and crew/CS100 targets on the graffiti crime page. [Greasy Fork](https://greasyfork.org/en/scripts/587425-torn-graffiti-helper) |
| [Torn Pickpocketing Helper](Torn_Pickpocketing_Helper.user.js) | Colours every pickpocketing mark for your crime skill, its activity and its build (green go, amber risky, red skip, purple cop), with a short tag such as "on phone ▲" or "muscular ▼". Based on Emforus' pickpocketing guide. No panel, no settings, no requests. |
| [Torn Museum Set Helper](Torn_Museum_Set_Helper.user.js) | Every museum set: flowers, plushies and artifacts. Counts what you own, complete sets and what's missing for a target, where flowers and plushies are sold abroad, market and bazaar cost of the missing items (bazaars via weav3r.dev) and the points profit (Museum Day aware). Replaces the Flower Set Helper. [Greasy Fork](https://greasyfork.org/en/scripts/598503-torn-museum-set-helper) |
| [Torn Pre-flight Checklist](Torn_Preflight_Checklist.user.js) | Before you fly: will energy/nerve cap while you're away, will drug/booster cooldowns run out mid-trip, is your cash right (ticket, shopping budget, mug risk), and is there a ranked war, chain or OC you'd miss. Uses the real round trip for your destination and flight type; a summary banner on the Travel Agency. [Greasy Fork](https://greasyfork.org/en/scripts/598498-torn-pre-flight-checklist) |
| [Torn Stock Dip Finder](Torn_Stock_Dip_Finder.user.js) | Swing-trading helper for the stock market: the stock furthest below its 7-day average (buy candidate), and for your open trades the +2% target and 14-day sell-by date. Rule backtested on ~5 years of daily prices (tornsy.com). Suggestions only; you trade yourself. [Greasy Fork](https://greasyfork.org/en/scripts/598499-torn-stock-dip-finder) |
| [Torn Points Market Shield](Torn_Points_Market_Shield.user.js) | Fat-finger guard for selling points: blocks a listing below a hard floor ($28,000 by default) and asks for a second confirmation below 95% of the cheapest listings. Catches clicks, submits and Enter. Never lists anything itself. [Greasy Fork](https://greasyfork.org/en/scripts/598500-torn-points-market-shield) |
| [Torn Chat Panel](Torn_Chat_Panel.user.js) | Full-screen messenger-style view of Torn's Chat 3.1: one chat list (last message, TCT time, unread count, online dot) and bubble conversations. Built on Torn's own chat: it reads what Torn loads and sends through Torn's message box. No API key; its only request is one history load on your tap when Torn hasn't loaded that chat. [Greasy Fork](https://greasyfork.org/en/scripts/598409-torn-chat-panel) |
| [Torn RR Martingale & Tracker](Torn_RR_Martingale.user.js) | Russian Roulette: fills the bet box with the next Martingale step (start bet and multiplier set in ⚙, default 2.1×), shows the loss streak, what the series risks and today's W/L and profit. Optional daily loss limit. Display extras (each can be turned off in ⚙): fast animations, compact layout, and the confirm button moved under your finger after Start/Join. Only fills the box; you make every tap. Reads results from the page; no API key, no requests. |
| [Torn - Poker Sidearm TR](Torn_Poker_Sidearm_TR.user.js) | Turkish translation of S7upidity's MIT-licensed [Poker Sidearm](https://greasyfork.org/scripts/596796) 8.7.1: FOLD / CALL / RAISE advice at Torn's poker table with Turkish explanations; Torn's button names stay in English. Advice logic unchanged. Based on 8.7.1 on purpose: 8.8.1 sends the Torn API key to the author's research server. |
| [Torn Panel Boilerplate](Torn_Panel_Boilerplate.user.js) | Reusable panel boilerplate for new scripts. |

## Torn FF/BS Badges

**Install:** from [Greasy Fork](https://greasyfork.org/en/scripts/597816-torn-ff-bs-badges) (recommended), or open the [raw script](https://raw.githubusercontent.com/nebigoktug/torn-userscripts/main/Torn_FFBS_Badges.user.js) with Tampermonkey / Violentmonkey. On Torn PDA, paste either install URL into the userscripts screen.

Needs a Torn API key registered at [ffscouter.com](https://ffscouter.com). Full feature list and the Torn API ToS table are in [docs/greasyfork-ffbs-badges.md](docs/greasyfork-ffbs-badges.md).

The script only displays information and never acts in the game for you.
