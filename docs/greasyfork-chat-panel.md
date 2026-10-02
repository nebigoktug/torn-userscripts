A full-screen, messenger-style view of **Torn's Chat 3.1**: one list of all your chats and a clean bubble view for each one. Built for phones (**Torn PDA**) and works on desktop (Tampermonkey, Violentmonkey).

Torn's own chat keeps doing the work underneath. The panel reads the messages Torn already loads and sends through Torn's own message box, so nothing about how your messages travel changes.

## Features

- **One chat list**: faction, company, global, trade, travel and private chats together, newest first. Each row shows the avatar, the last message, the time and the unread count. Private chats show an online dot.
- **Bubble conversations**: messages from the same person are grouped, with avatars and coloured names in group chats. Links are clickable, emoji-only messages are shown larger, and @mentions of you are highlighted.
- **Unread messages**: a divider marks where the unread part starts, and a `↑ N` button jumps straight to it and marks them all read. Read chats stay read after a page reload.
- **Emoji picker**: recent emojis, the ones most used in your own chats, a Torn set (💰🌸🧸✈️💊🔫…) and the usual categories.
- **Long-press menus**: on a message: reply (@name), copy, open link, open profile, message privately. On a chat: pin to top, mute.
- **Phone-friendly**: the Back button moves between chat and list, the message box stays above the keyboard, and the unread total sits on the chat button.
- **FF / BS chips** next to names, if you also use [Torn FF/BS Badges](https://greasyfork.org/en/scripts/597816-torn-ff-bs-badges). They are read from its local cache, with no extra requests.
- **Settings (⚙)**: text size, Enter to send, background pattern, FF/BS chips, mute chat sounds, hide Torn's own chat.
- Times are shown in **TCT**, like the rest of Torn.

## How it uses Torn's chat

- Torn's chat windows are **hidden but keep running** underneath the panel. Its chat button is replaced by the panel's green one. You can turn the hiding off in the settings, for example to reach Torn's own chat settings.
- Opening a chat in the panel taps that chat's button in Torn's chat bar. Scrolling up scrolls Torn's window so Torn loads older messages. **Send** puts your text into Torn's message box and taps Torn's send button.
- **Failsafe**: if Torn changes its chat and the panel can't find the chat bar, gets no data, or can't open chat windows, it shows Torn's own chat again and says why.

## Torn's scripting rules

The script makes **no API calls** and needs **no API key**. It only reads what Torn's chat already loads on the page you are viewing.

It can make two non-API requests, both the same ones Torn's own chat makes and both only after something you did:
- When you tap a chat whose messages Torn hasn't loaded on this page, it asks Torn's chat once for that chat's latest 50 messages.
- When you have read a chat to the bottom (or tap `↑ N`), it first lets Torn's own hidden chat window mark it as read: scrolled to the bottom, then the `✕` on Torn's own "new messages" pill. Only if Torn doesn't, it sends Torn's "read" request for that chat once, so the unread count doesn't come back on the next page.

Nothing is requested automatically or in the background.

Everything it stores (the chat list, your settings, emoji counts) stays in your browser.

## Support

If the panel makes your Torn life nicer, a Xanax or a few $ to [Nebigoktug [3980062]](https://www.torn.com/profiles.php?XID=3980062) keeps it going ❤️

Source code, issues and changelog: [github.com/nebigoktug/torn-userscripts](https://github.com/nebigoktug/torn-userscripts)
