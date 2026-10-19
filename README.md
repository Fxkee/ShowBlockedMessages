# ShowBlockedMessages

A [BetterDiscord](https://betterdiscord.app) plugin that shows messages from
people you have blocked as ordinary chat messages, **without unblocking them**.

Discord hides a blocked user's messages behind a "1 blocked message — Show
message" row, replaces replies to them with a "Blocked message" placeholder,
and refuses to jump to their messages. With this plugin enabled, their
messages look exactly like everyone else's: avatar, name, timestamp,
formatting, mentions, embeds, attachments and reactions, all rendered by
Discord's own components.

Your block list is never touched. The users stay blocked everywhere else in
Discord; only how their already-delivered messages are displayed changes.

## What changes

| Where | Discord's default | With the plugin |
| --- | --- | --- |
| Chat | "N blocked messages — Show message" row | The messages, shown normally and grouped like any other |
| Reply previews | "Blocked message" placeholder | The replied-to message's avatar and text |
| Clicking a reply or search result | "Soo... you blocked this person" dialog | Jumps to the message |

## Install

1. Download `ShowBlockedMessages.plugin.js` from the
   [latest release](https://github.com/Fxkee/ShowBlockedMessages/releases/latest).
2. Put it in your BetterDiscord plugins folder. You can open it from
   **User Settings → Plugins → Open Plugins Folder**, or go to:
   - Windows: `%APPDATA%\BetterDiscord\plugins`
   - macOS: `~/Library/Application Support/BetterDiscord/plugins`
   - Linux: `~/.config/BetterDiscord/plugins`
3. Enable **ShowBlockedMessages** under **User Settings → Plugins**.

Open chats update straight away. If one does not, switch channels once.

**Updating:** download the newer release and replace the file.
BetterDiscord reloads it automatically.

**Uninstalling:** disable or delete the plugin. Discord's normal blocked
message rows, placeholders and dialogs come back immediately.

## Settings

Open them with the gear icon next to the plugin in **User Settings → Plugins**.

| Setting | Default | Effect |
| --- | --- | --- |
| Also reveal messages from ignored users | Off | Discord hides "ignored" users the same way as blocked ones. Turn this on to show their messages, reply previews and jumps normally too. |

## FAQ

**Does this unblock anyone?**
No. The plugin never calls an unblock action and never changes your
relationships. It only reads whether a message's author is blocked.

**Can the blocked person tell?**
No. Everything happens in your own client. The plugin itself makes no network
requests and sends nothing to anyone. Jumping to a message loads it the same
way any other jump in Discord does.

**Why can't I see a blocked user's DMs?**
Discord does not deliver DMs from blocked users to your client at all. The
plugin can only show messages your client already has, and it does not try to
fetch anything.

**Does it work on Vencord?**
No. Vencord cannot load BetterDiscord plugins. A Vencord version would have to
be a separate port.

## Limitations

- Works in server text channels, threads, forum posts and DMs, for loaded
  history and for new messages.
- Messages from spammers and suspended users stay collapsed, as Discord shows
  them.
- The "Conversation Focus" overlay builds its own message list and still shows
  collapsed rows.
- Search still hides blocked users' results behind Discord's own "show blocked
  results" toggle. Once shown, jumping to them works.
- Notifications, unread badges and mention counts still treat blocked users as
  blocked.

## If Discord changes

The plugin is three independent patches: the chat list, reply previews and the
jump dialog. Each one checks that Discord's code looks as expected before
patching it.

- If the **chat list** patch cannot be applied, the plugin installs nothing,
  shows one error notification and leaves Discord exactly as it was.
- If a **reply preview** or **jump dialog** patch cannot be applied, the rest
  keeps working and only that part falls back to Discord's behaviour, with a
  warning in the console.
- Errors while rendering fall back to Discord's original output instead of
  breaking the chat.

If something stops working after a Discord update, please
[open an issue](https://github.com/Fxkee/ShowBlockedMessages/issues) with the
`ShowBlockedMessages` lines from the console (Ctrl+Shift+I, Console tab).

## How it works

Discord turns a channel's messages into a *channel stream*, an array of items
such as `MESSAGE`, `DIVIDER` and, for blocked authors, `MESSAGE_GROUP_BLOCKED`.
A blocked group already contains the original message items; the message list
just draws a collapsed row in their place until "Show message" is clicked.

- **Chat list.** An `after` patch on the channel-messages component (a
  `React.memo` export found through `BdApi.Webpack`) replaces each blocked
  group in its `channelStream` prop with the items inside it. Discord's own
  message list then renders them with its normal components, keys, headers and
  unread dividers. No DOM is edited and no message HTML is generated.
- **Reply previews.** A `before` patch on the shared reply-preview component
  clears its `isReplyAuthorBlocked` prop, so it renders the referenced message
  instead of the placeholder.
- **Jump dialog.** An `instead` patch on Discord's "can jump to this message"
  guard returns "allowed" when the author is blocked. For everyone else it
  calls Discord's own guard unchanged.

A `React.memo` component caches its render function on mounted chats, so for
chats already on screen the plugin swaps in the patched function and triggers
Discord's own store-driven re-render. Disabling the plugin does the same in
reverse.

## Repository layout

| Path | What it is |
| --- | --- |
| `ShowBlockedMessages.plugin.js` | The plugin. A single file with no dependencies and no build step. |
| `test/run-tests.js` | Unit tests for the plugin's logic, run in Node with a stubbed `BdApi`. |
| `LICENSE` | MIT license. |

## Development

Run the tests with Node.js 18 or newer:

```bash
node test/run-tests.js
```

To try a change, copy `ShowBlockedMessages.plugin.js` into your plugins
folder; BetterDiscord reloads it when the file changes.

Last verified against Discord's stable desktop client with BetterDiscord
1.14.3 in October 2026.

## Disclaimer

BetterDiscord is a client modification, and client modifications are against
Discord's Terms of Service. Use this plugin at your own risk. This project is
not affiliated with Discord or BetterDiscord.

## License

[MIT](LICENSE)
