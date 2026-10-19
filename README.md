# ShowBlockedMessages (BetterDiscord)

Shows messages from users you have blocked as ordinary chat messages. The
"1 blocked message — Show message" row disappears and the messages behind it
are rendered with Discord's normal message components: avatar, username,
timestamp, formatting, mentions, embeds, attachments and reactions.

The users stay blocked. The plugin never touches your relationships, never
calls an unblock action and never changes what Discord's relationship store
reports. It only changes how the already-downloaded messages are presented.

## Install

1. Download `ShowBlockedMessages.plugin.js` from the latest
   [release](https://github.com/Fxkee/ShowBlockedMessages/releases/latest)
   and copy it to your BetterDiscord plugins folder.
   On Windows that is `%APPDATA%\BetterDiscord\plugins`.
2. Enable **ShowBlockedMessages** in Discord under User Settings → Plugins.

Open chats update immediately. If a view does not refresh, switching channels
once applies the change.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| Also reveal messages from ignored users | off | Discord collapses "ignored" users the same way as blocked users. Turning this on reveals those groups too. |

## How it works

Discord turns a channel's messages into a *channel stream*: an array of items
such as `MESSAGE`, `DIVIDER` and, for blocked authors, `MESSAGE_GROUP_BLOCKED`.
A blocked group carries the original message items in its `content` array.
The message list renders the group as the collapsed row and only renders the
`content` items after "Show message" is clicked.

The plugin patches the render output of the channel-messages component (the
`React.memo` export of Discord's chat module, found through `BdApi.Webpack`)
and replaces each blocked group in the `channelStream` prop with the items it
contains. Discord's own message list then renders them like any other message,
with its own components, keys, group headers and unread dividers. No DOM is
touched and no message HTML is fabricated.

Reply previews (the "replied to" line above a reply) are a separate shared
component that receives an `isReplyAuthorBlocked` prop from its callers and
shows a "Blocked message" placeholder when it is set. A second, optional
`before` patch clears that prop so the preview shows the referenced message's
avatar and text. If that component cannot be found, the main feature still
works and only the previews keep Discord's placeholder.

Clicking a reply preview or a search result runs a shared "can jump to this
message" guard that shows a "Soo... you blocked this person" modal and
refuses. A third optional patch answers that guard with "allowed" when the
author is blocked (read from the relationship store, which is never written)
and defers to Discord's own guard for everyone else, so the spammer dialogs
are unchanged.

Because a `React.memo` component caches its inner function on mounted fibers,
patching alone would only affect chats opened later. For chats already on
screen, the plugin points their fibers at the patched function and triggers
Discord's own `useStateFromStores` re-render, the same path a store update
takes. The same mechanism restores the native rows when the plugin is
disabled.

## Scope and limitations

- Works in server text channels, threads, forum posts and DMs, for loaded
  history and for newly arriving messages.
- Messages that Discord never delivers to the client cannot be shown. Blocked
  DMs, for example, never reach the client; the plugin cannot and does not try
  to fetch them.
- Collapsed groups for spammers and suspended users are left as Discord
  renders them.
- The "Conversation Focus" overlay builds its own list internally and still
  shows collapsed rows there.
- Notifications, mention badges, search results and other places that consult
  the relationship state are unchanged, because the relationship state is
  unchanged.

## Safe failure

If the chat module or the component cannot be found, or does not have the
expected shape, the plugin logs a diagnostic, shows one error toast, installs
no patch and leaves Discord's own behaviour intact. Render errors fall back to
Discord's original output and are logged once.

## Development

The patch target was verified against Discord's current stable web bundle
(October 2026): the chat module exports a single `React.memo` component whose
inner function passes `channelStream` to the message list, and the collapsed
group renderer destructures `{messages, channel, compact, unreadId,
collapsedReason, canUncollapse}` and renders `messages.content` when expanded.
Confirmed working in the Discord desktop client with BetterDiscord 1.14.3 on
19 October 2026.

Unit tests for the pure logic (stream flattening, tree rewriting, module and
fiber discovery, lifecycle) run outside Discord with a stubbed `BdApi`:

```bash
node test/run-tests.js
```

The plugin is a single file with no build step and no dependencies.

## License

MIT, see `LICENSE`.
