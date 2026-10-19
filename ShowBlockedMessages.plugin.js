/**
 * @name ShowBlockedMessages
 * @author Fxkee
 * @description Shows messages from users you have blocked as ordinary chat messages instead of the collapsed "blocked messages" row. The users stay blocked; only the chat presentation changes.
 * @version 1.2.0
 * @source https://github.com/Fxkee/ShowBlockedMessages
 * @updateUrl https://raw.githubusercontent.com/Fxkee/ShowBlockedMessages/main/ShowBlockedMessages.plugin.js
 */

"use strict";

/*
 * How it works
 * ------------
 * Discord builds the chat out of a "channel stream": an array of items such as
 * {type: "MESSAGE", content: <MessageRecord>, groupId}, {type: "DIVIDER", ...}
 * and, for blocked users, {type: "MESSAGE_GROUP_BLOCKED", content: [<items>], key}.
 * The message list renders a blocked group as the "N blocked messages - Show
 * message" row and only renders the group's `content` items once that row is
 * clicked. The original messages are therefore already present client-side;
 * only their presentation is collapsed.
 *
 * This plugin patches the render output of the channel-messages component
 * (the React.memo export whose inner function hands `channelStream` to the
 * message list) and replaces every blocked group with the items it contains.
 * Discord's own message list then renders those items exactly like any other
 * message: same components, same keys, same group headers, same dividers.
 *
 * Reply previews (the "replied to" line above a message) are rendered by a
 * separate shared component that receives an `isReplyAuthorBlocked` prop from
 * its callers and shows a "Blocked message" placeholder when it is set. The
 * plugin clears that prop before the component renders, so the preview shows
 * the referenced message's avatar and text like any other reply.
 *
 * Clicking a reply preview (or a search result) runs a shared "can jump to
 * this message" guard that shows a "you blocked this person" modal and
 * refuses. The plugin answers that guard with "allowed" for blocked authors
 * and defers to Discord for everyone else, so the spammer dialogs stay.
 *
 * Nothing about relationships is touched: the relationship store is only
 * read, never patched, no unblock action is called and no message record is
 * mutated. Removing the plugin restores the native rows, placeholders and
 * modal.
 */

const REACT_MEMO_TYPE = Symbol.for("react.memo");

/** Discord's ChannelStreamItem type enum uses its key names as values; these are the fallback. */
const FALLBACK_STREAM_TYPES = Object.freeze({
    MESSAGE: "MESSAGE",
    THREAD_STARTER_MESSAGE: "THREAD_STARTER_MESSAGE",
    DIVIDER: "DIVIDER",
    MESSAGE_GROUP_BLOCKED: "MESSAGE_GROUP_BLOCKED",
    MESSAGE_GROUP_IGNORED: "MESSAGE_GROUP_IGNORED"
});

const DEFAULT_SETTINGS = Object.freeze({
    /** Also reveal groups Discord collapses because the author is "ignored" (not blocked). */
    revealIgnored: false
});

/**
 * Source fragments of the module that contains Discord's channel-messages
 * component. They identify the module factory, which is unaffected by other
 * plugins' patches, and are combined with a structural check of the export.
 */
const CHAT_MODULE_MARKERS = ["channelStream:", "messageGroupSpacing", "showNewMessagesBar"];

/**
 * Source fragments of the module that owns the shared reply-preview
 * component, plus the fragments its exported function must contain.
 */
const REPLY_MODULE_MARKERS = ["isReplyAuthorBlocked", "contentPlaceholder", "isReplySpineClickable", "repliedAuthor"];
const REPLY_COMPONENT_MARKERS = ["isReplyAuthorBlocked", "referencedMessage"];

/**
 * Source fragments of the module exporting the "can jump to this message"
 * guard (blocked / ignored / spammer modals), and of the function itself.
 */
const JUMP_GUARD_MODULE_MARKERS = ["isBlockedForMessage", "isIgnoredForMessage", "MODERATE_MEMBERS", "confirmText"];
const JUMP_GUARD_FUNCTION_MARKERS = ["isBlockedForMessage", "confirmText"];

/** DOM entry points used to find chat views that are already on screen. */
const MOUNTED_CHAT_SELECTOR = '[data-list-id="chat-messages"], li[id^="chat-messages-"]';
const MOUNTED_MESSAGE_SELECTOR = 'li[id^="chat-messages-"]';

const MAX_TREE_DEPTH = 10;
const MAX_FIBER_HOPS = 300;
const MAX_HOOK_HOPS = 64;
const MAX_SUBTREE_FIBERS = 4000;

function isPlainObject(value) {
    if (value === null || typeof value !== "object") return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function isEmptyPlainObject(value) {
    return isPlainObject(value) && Object.keys(value).length === 0;
}

module.exports = class ShowBlockedMessages {
    constructor(meta) {
        this.meta = meta ?? {};
        this.name = typeof this.meta.name === "string" && this.meta.name ? this.meta.name : "ShowBlockedMessages";
        this.settings = {...DEFAULT_SETTINGS};
        this.streamTypes = FALLBACK_STREAM_TYPES;

        /** Webpack exports object that owns the chat component, and the key it lives under. */
        this.chatModule = null;
        this.chatExportKey = null;
        /** The React.memo object that Discord renders; its `.type` is the patched inner function. */
        this.chatComponent = null;

        /** Webpack exports object that owns the shared reply-preview component, and its key. */
        this.replyModule = null;
        this.replyExportKey = null;

        /** Webpack exports object that owns the jump guard, its key, and the store it is answered from. */
        this.jumpGuardModule = null;
        this.jumpGuardExportKey = null;
        this.relationshipStore = null;

        /** channelStream array -> flattened array. Keyed by identity, so Discord's memoised streams hit the cache. */
        this.streamCache = new WeakMap();
        this.abortController = null;
        this.replyAbortController = null;
        this.jumpAbortController = null;
        this.active = false;
        this.reportedProblems = new Set();
    }

    /* ------------------------------------------------------------------ */
    /* Lifecycle                                                           */
    /* ------------------------------------------------------------------ */

    start() {
        this.active = true;
        this.reportedProblems.clear();
        this.loadSettings();
        this.resolveStreamTypes();

        let exports = null;
        try {
            exports = BdApi.Webpack.getModule(this.buildModuleFilter(), {defaultExport: false});
        } catch (error) {
            this.fail("Searching for Discord's chat module threw an error.", error);
            return;
        }

        if (exports) {
            this.install(exports);
            return;
        }

        this.log("info", "Discord's chat module is not loaded yet; the patch will be installed once it loads.");
        this.waitForChatModule();
    }

    stop() {
        this.active = false;

        for (const key of ["abortController", "replyAbortController", "jumpAbortController"]) {
            if (this[key]) {
                this[key].abort();
                this[key] = null;
            }
        }

        try {
            BdApi.Patcher.unpatchAll(this.name);
        } catch (error) {
            this.log("error", "Failed to remove patches.", error);
        }

        // memo.type is Discord's original function again (or another plugin's wrapper); point the
        // mounted chat views back at it and let Discord redraw the native collapsed rows.
        if (this.chatComponent) this.refreshMountedChats();
        if (this.replyModule) this.refreshMountedReplyPreviews();

        this.chatModule = null;
        this.chatExportKey = null;
        this.chatComponent = null;
        this.replyModule = null;
        this.replyExportKey = null;
        this.jumpGuardModule = null;
        this.jumpGuardExportKey = null;
        this.relationshipStore = null;
        this.streamCache = new WeakMap();
    }

    getSettingsPanel() {
        const settings = [{
            type: "switch",
            id: "revealIgnored",
            name: "Also reveal messages from ignored users",
            note: "Discord collapses messages from users you \"ignore\" the same way it collapses blocked users. Turn this on to show those messages normally too.",
            value: this.settings.revealIgnored
        }];

        const build = BdApi.UI?.buildSettingsPanel;
        if (typeof build === "function") {
            return build({
                settings,
                // BetterDiscord calls onChange(category, id, value); older builds may omit the category.
                onChange: (...args) => {
                    const value = args[args.length - 1];
                    const id = args[args.length - 2];
                    this.updateSetting(id, value);
                }
            });
        }

        // Minimal fallback for BetterDiscord builds without buildSettingsPanel.
        const panel = document.createElement("div");
        panel.style.padding = "8px 0";
        for (const setting of settings) {
            const label = document.createElement("label");
            label.style.display = "flex";
            label.style.alignItems = "center";
            label.style.gap = "8px";
            label.style.color = "var(--header-primary)";
            const input = document.createElement("input");
            input.type = "checkbox";
            input.checked = Boolean(setting.value);
            input.addEventListener("change", () => this.updateSetting(setting.id, input.checked));
            label.append(input, document.createTextNode(setting.name));
            panel.append(label);
        }
        return panel;
    }

    /* ------------------------------------------------------------------ */
    /* Settings                                                            */
    /* ------------------------------------------------------------------ */

    loadSettings() {
        let stored = null;
        try {
            stored = BdApi.Data.load(this.name, "settings");
        } catch (error) {
            this.log("warn", "Could not read saved settings; using defaults.", error);
        }
        const next = {...DEFAULT_SETTINGS};
        if (isPlainObject(stored)) {
            for (const key of Object.keys(DEFAULT_SETTINGS)) {
                if (typeof stored[key] === typeof DEFAULT_SETTINGS[key]) next[key] = stored[key];
            }
        }
        this.settings = next;
    }

    updateSetting(id, value) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, id)) return;
        if (typeof value !== typeof DEFAULT_SETTINGS[id]) return;
        if (this.settings[id] === value) return;

        this.settings = {...this.settings, [id]: value};
        try {
            BdApi.Data.save(this.name, "settings", this.settings);
        } catch (error) {
            this.log("warn", "Could not save settings.", error);
        }

        // Cached flattenings depend on the settings; rebuild them and redraw open chats.
        this.streamCache = new WeakMap();
        if (this.active && this.chatComponent) this.refreshMountedChats();
        if (this.active && this.replyModule) this.refreshMountedReplyPreviews();
    }

    /* ------------------------------------------------------------------ */
    /* Module discovery and patching                                       */
    /* ------------------------------------------------------------------ */

    resolveStreamTypes() {
        try {
            const {Webpack} = BdApi;
            const filter = Webpack.Filters.byKeys("MESSAGE", "DIVIDER", "THREAD_STARTER_MESSAGE", "MESSAGE_GROUP_BLOCKED", "MESSAGE_GROUP_IGNORED");
            const found = Webpack.getModule(filter, {searchExports: true});
            if (found && typeof found.MESSAGE_GROUP_BLOCKED === "string") {
                this.streamTypes = Object.freeze({
                    MESSAGE: found.MESSAGE,
                    THREAD_STARTER_MESSAGE: found.THREAD_STARTER_MESSAGE,
                    DIVIDER: found.DIVIDER,
                    MESSAGE_GROUP_BLOCKED: found.MESSAGE_GROUP_BLOCKED,
                    MESSAGE_GROUP_IGNORED: found.MESSAGE_GROUP_IGNORED
                });
                return;
            }
        } catch (error) {
            this.log("warn", "Could not resolve Discord's stream item types; using the known values.", error);
        }
        this.streamTypes = FALLBACK_STREAM_TYPES;
    }

    /**
     * Builds the webpack filter for the module that owns the chat component.
     * Prefers a source match on the module factory (robust against other
     * plugins having already patched the component) and always requires the
     * export to have the expected React.memo shape.
     */
    buildModuleFilter() {
        const Filters = BdApi.Webpack.Filters;
        const bySource = typeof Filters?.bySource === "function" ? Filters.bySource(...CHAT_MODULE_MARKERS) : null;
        const requireSourceCheck = bySource === null;

        return (exports, module, id) => {
            if (bySource !== null) {
                try {
                    if (!bySource(exports, module, id)) return false;
                } catch {
                    return false;
                }
            }
            return ShowBlockedMessages.findChatExportKey(exports, requireSourceCheck) !== null;
        };
    }

    /**
     * Returns the export key holding a React.memo component whose inner
     * function looks like Discord's channel-messages component, or null.
     * With `checkSource` the inner function's source must contain the markers
     * (used only when module-source filtering is unavailable).
     */
    static findChatExportKey(exports, checkSource = false) {
        if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) return null;
        let keys;
        try {
            keys = Object.keys(exports);
        } catch {
            return null;
        }
        if (keys.length === 0 || keys.length > 25) return null;

        for (const key of keys) {
            let value;
            try {
                value = exports[key];
            } catch {
                continue;
            }
            if (ShowBlockedMessages.isMemoComponent(value) && (!checkSource || ShowBlockedMessages.sourceHasMarkers(value.type))) return key;
        }
        return null;
    }

    static isMemoComponent(value) {
        return value !== null && typeof value === "object" && value.$$typeof === REACT_MEMO_TYPE && typeof value.type === "function";
    }

    static sourceHasMarkers(fn) {
        let source;
        try {
            source = Function.prototype.toString.call(fn);
        } catch {
            return false;
        }
        return CHAT_MODULE_MARKERS.every(marker => source.includes(marker));
    }

    waitForChatModule() {
        const wait = BdApi.Webpack.waitForModule;
        if (typeof wait !== "function") {
            this.fail("Discord's chat module is not loaded and this BetterDiscord build cannot wait for it.");
            return;
        }

        this.abortController = typeof AbortController === "function" ? new AbortController() : null;
        let promise;
        try {
            const options = {defaultExport: false};
            if (this.abortController) options.signal = this.abortController.signal;
            promise = wait(this.buildModuleFilter(), options);
        } catch (error) {
            this.fail("Waiting for Discord's chat module threw an error.", error);
            return;
        }

        if (!promise || typeof promise.then !== "function") {
            this.fail("Waiting for Discord's chat module did not return a promise.");
            return;
        }

        promise.then(exports => {
            this.abortController = null;
            if (!this.active) return;
            if (exports) this.install(exports);
            else this.fail("Discord's chat module could not be found.");
        }).catch(error => {
            this.abortController = null;
            if (this.active) this.fail("Waiting for Discord's chat module failed.", error);
        });
    }

    install(exports) {
        if (!this.active || this.chatComponent) return;

        const key = ShowBlockedMessages.findChatExportKey(exports);
        if (key === null) {
            this.fail("The chat module was found but its component does not have the expected shape.");
            return;
        }

        const component = exports[key];
        let unpatch = null;
        try {
            unpatch = BdApi.Patcher.after(this.name, component, "type", (_thisObject, _args, result) => this.onChatRender(result));
        } catch (error) {
            this.fail("Patching the chat component failed.", error);
            return;
        }
        if (typeof unpatch !== "function") {
            this.fail("BetterDiscord did not install the chat component patch.");
            return;
        }

        this.chatModule = exports;
        this.chatExportKey = key;
        this.chatComponent = component;
        this.streamCache = new WeakMap();

        const refreshed = this.refreshMountedChats();
        this.log("info", `Active. Blocked messages are shown as normal messages${refreshed ? ` (${refreshed} open chat view${refreshed === 1 ? "" : "s"} refreshed)` : ""}.`);

        this.installReplyPreviewPatch();
        this.installJumpGuardPatch();
    }

    /* ------------------------------------------------------------------ */
    /* Optional secondary patches                                          */
    /* ------------------------------------------------------------------ */

    /**
     * Resolves a module now or when it loads and hands its exports to
     * `onFound`. Failures are logged as warnings: these patches are optional
     * and the main feature keeps working without them.
     */
    resolveOptionalModule({label, filter, abortKey, onFound}) {
        let exports = null;
        try {
            exports = BdApi.Webpack.getModule(filter, {defaultExport: false});
        } catch (error) {
            this.log("warn", `Searching for ${label} threw an error; that part stays on Discord's behaviour.`, error);
            return;
        }
        if (exports) {
            onFound(exports);
            return;
        }

        const wait = BdApi.Webpack.waitForModule;
        if (typeof wait !== "function") return;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        this[abortKey] = controller;
        let promise;
        try {
            const options = {defaultExport: false};
            if (controller) options.signal = controller.signal;
            promise = wait(filter, options);
        } catch (error) {
            this.log("warn", `Waiting for ${label} threw an error.`, error);
            return;
        }
        if (!promise || typeof promise.then !== "function") return;
        promise.then(result => {
            this[abortKey] = null;
            if (this.active && result) onFound(result);
        }).catch(error => {
            this[abortKey] = null;
            if (this.active) this.log("warn", `Waiting for ${label} failed.`, error);
        });
    }

    /** Module filter: source markers on the module factory plus a plain-function export with its own markers. */
    buildFunctionModuleFilter(moduleMarkers, functionMarkers) {
        const Filters = BdApi.Webpack.Filters;
        const bySource = typeof Filters?.bySource === "function" ? Filters.bySource(...moduleMarkers) : null;
        return (exports, module, id) => {
            if (bySource !== null) {
                try {
                    if (!bySource(exports, module, id)) return false;
                } catch {
                    return false;
                }
            }
            return ShowBlockedMessages.findFunctionExportKey(exports, functionMarkers) !== null;
        };
    }

    /* ------------------------------------------------------------------ */
    /* Reply previews                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * The "replied to" line above a reply is a shared component that gets an
     * `isReplyAuthorBlocked` prop from its callers. This patch is optional:
     * if the component cannot be found the main feature still works and only
     * reply previews keep Discord's placeholder.
     */
    installReplyPreviewPatch() {
        if (!this.active || this.replyModule) return;
        this.resolveOptionalModule({
            label: "the reply-preview component",
            filter: this.buildFunctionModuleFilter(REPLY_MODULE_MARKERS, REPLY_COMPONENT_MARKERS),
            abortKey: "replyAbortController",
            onFound: exports => this.patchReplyPreview(exports)
        });
    }

    /** Returns the key of the plain function export whose source mentions the reply-preview props, or null. */
    static findReplyExportKey(exports) {
        return ShowBlockedMessages.findFunctionExportKey(exports, REPLY_COMPONENT_MARKERS);
    }

    /** Returns the key of a plain (non-class) function export whose source contains every marker, or null. */
    static findFunctionExportKey(exports, markers) {
        if (exports === null || (typeof exports !== "object" && typeof exports !== "function")) return null;
        let keys;
        try {
            keys = Object.keys(exports);
        } catch {
            return null;
        }
        if (keys.length === 0 || keys.length > 25) return null;

        for (const key of keys) {
            let value;
            try {
                value = exports[key];
            } catch {
                continue;
            }
            if (typeof value !== "function" || value.prototype?.isReactComponent) continue;
            let source;
            try {
                source = Function.prototype.toString.call(value);
            } catch {
                continue;
            }
            if (markers.every(marker => source.includes(marker))) return key;
        }
        return null;
    }

    patchReplyPreview(exports) {
        if (!this.active || this.replyModule) return;
        const key = ShowBlockedMessages.findReplyExportKey(exports);
        if (key === null) {
            this.log("warn", "The reply-preview module was found but has an unexpected shape; reply previews keep Discord's placeholder.");
            return;
        }

        let unpatch = null;
        try {
            unpatch = BdApi.Patcher.before(this.name, exports, key, (_thisObject, args) => this.onReplyPreviewRender(args));
        } catch (error) {
            this.log("warn", "Patching the reply-preview component failed; reply previews keep Discord's placeholder.", error);
            return;
        }
        if (typeof unpatch !== "function") return;

        this.replyModule = exports;
        this.replyExportKey = key;
        this.refreshMountedReplyPreviews();
    }

    /** `before` callback for the reply-preview component: clears the blocked/ignored flags on its props. */
    onReplyPreviewRender(args) {
        if (!this.active || !Array.isArray(args)) return;
        const props = args[0];
        if (props === null || typeof props !== "object") return;

        const clearBlocked = props.isReplyAuthorBlocked === true;
        const clearIgnored = this.settings.revealIgnored && props.isReplyAuthorIgnored === true;
        if (!clearBlocked && !clearIgnored) return;

        const next = {...props};
        if (clearBlocked) next.isReplyAuthorBlocked = false;
        if (clearIgnored) next.isReplyAuthorIgnored = false;
        args[0] = next;
    }

    /**
     * Reply previews already on screen were created with the unpatched
     * component. Their parent re-creates the element on its next render, so
     * nudge each parent through Discord's own store-subscription re-render.
     */
    refreshMountedReplyPreviews() {
        const getFiber = BdApi.ReactUtils?.getInternalInstance;
        if (typeof getFiber !== "function" || typeof document === "undefined") return 0;

        let refreshed = 0;
        try {
            for (const node of document.querySelectorAll(MOUNTED_MESSAGE_SELECTOR)) {
                let fiber = null;
                try {
                    fiber = getFiber(node);
                } catch {
                    continue;
                }
                const previews = ShowBlockedMessages.findDescendantFibers(fiber, ShowBlockedMessages.isReplyPreviewFiber);
                for (const preview of previews) {
                    const parent = ShowBlockedMessages.findAncestorFiber(preview.return, candidate => ShowBlockedMessages.findStoreStateHook(candidate.memoizedState) !== null);
                    const hook = parent ? ShowBlockedMessages.findStoreStateHook(parent.memoizedState) : null;
                    if (!hook) continue;
                    hook.queue.dispatch({});
                    refreshed++;
                }
            }
        } catch (error) {
            this.reportOnce("refresh-replies", "Re-rendering open reply previews failed; they update when their message re-renders.", error);
        }
        return refreshed;
    }

    /* ------------------------------------------------------------------ */
    /* Jumping to a blocked user's message                                 */
    /* ------------------------------------------------------------------ */

    /**
     * Discord runs a shared guard before jumping to a referenced message
     * (reply click, search result). It shows a "you blocked this person"
     * modal and returns false for blocked authors. The patch answers "allowed"
     * for authors this plugin reveals and lets Discord handle everyone else.
     */
    installJumpGuardPatch() {
        if (!this.active || this.jumpGuardModule) return;
        this.resolveOptionalModule({
            label: "the jump-to-message guard",
            filter: this.buildFunctionModuleFilter(JUMP_GUARD_MODULE_MARKERS, JUMP_GUARD_FUNCTION_MARKERS),
            abortKey: "jumpAbortController",
            onFound: exports => this.patchJumpGuard(exports)
        });
    }

    /** Finds Discord's relationship store, which is only ever read. */
    resolveRelationshipStore() {
        const {Webpack} = BdApi;
        const candidates = [];
        try {
            if (typeof Webpack.getStore === "function") candidates.push(Webpack.getStore("RelationshipStore"));
        } catch {
            // fall through to the key-based lookup
        }
        try {
            candidates.push(Webpack.getModule(Webpack.Filters.byKeys("isBlockedForMessage", "isIgnoredForMessage", "isBlocked")));
        } catch {
            // handled below
        }
        return candidates.find(store => store && typeof store.isBlockedForMessage === "function" && typeof store.isIgnoredForMessage === "function") ?? null;
    }

    patchJumpGuard(exports) {
        if (!this.active || this.jumpGuardModule) return;
        const key = ShowBlockedMessages.findFunctionExportKey(exports, JUMP_GUARD_FUNCTION_MARKERS);
        if (key === null) {
            this.log("warn", "The jump-guard module was found but has an unexpected shape; jumping to blocked users' messages keeps Discord's modal.");
            return;
        }

        const store = this.resolveRelationshipStore();
        if (!store) {
            this.log("warn", "Discord's relationship store could not be found; jumping to blocked users' messages keeps Discord's modal.");
            return;
        }

        let unpatch = null;
        try {
            unpatch = BdApi.Patcher.instead(this.name, exports, key, (_thisObject, args, original) => this.onJumpGuard(args, original));
        } catch (error) {
            this.log("warn", "Patching the jump guard failed; jumping to blocked users' messages keeps Discord's modal.", error);
            return;
        }
        if (typeof unpatch !== "function") return;

        this.jumpGuardModule = exports;
        this.jumpGuardExportKey = key;
        this.relationshipStore = store;
    }

    /** `instead` callback for the jump guard: allow revealed authors, defer to Discord for everyone else. */
    onJumpGuard(args, original) {
        const message = Array.isArray(args) ? args[0] : undefined;
        if (this.active && this.isRevealedAuthor(message)) return true;
        return original(...(Array.isArray(args) ? args : []));
    }

    /** True when this plugin shows the message's author normally (blocked, or ignored with the setting on). */
    isRevealedAuthor(message) {
        if (message === null || typeof message !== "object" || !this.relationshipStore) return false;
        try {
            if (this.relationshipStore.isBlockedForMessage(message)) return true;
            return this.settings.revealIgnored && this.relationshipStore.isIgnoredForMessage(message) === true;
        } catch (error) {
            this.reportOnce("relationship-read", "Reading the relationship store failed; Discord's own jump guard is used.", error);
            return false;
        }
    }

    static isReplyPreviewFiber(fiber) {
        const props = fiber.memoizedProps;
        return props !== null && typeof props === "object" && "isReplyAuthorBlocked" in props && "referencedMessage" in props;
    }

    /** Depth-first search of a fiber's subtree, bounded so a huge tree cannot stall the client. */
    static findDescendantFibers(root, predicate) {
        const found = [];
        if (!root) return found;
        const stack = [root];
        let visited = 0;
        while (stack.length > 0 && visited++ < MAX_SUBTREE_FIBERS) {
            const fiber = stack.pop();
            if (predicate(fiber)) found.push(fiber);
            if (fiber.sibling && fiber !== root) stack.push(fiber.sibling);
            if (fiber.child) stack.push(fiber.child);
        }
        return found;
    }

    /* ------------------------------------------------------------------ */
    /* Render patch                                                        */
    /* ------------------------------------------------------------------ */

    /** `after` callback for the chat component. Returns a replacement tree or undefined to keep Discord's. */
    onChatRender(result) {
        if (!this.active) return undefined;
        try {
            return this.rewriteTree(result, 0);
        } catch (error) {
            this.reportOnce("render", "Failed to rewrite the chat render output; Discord's original output is used.", error);
            return undefined;
        }
    }

    /**
     * Walks a React element tree looking for the element that receives
     * `channelStream` and returns a copy of the tree with that prop replaced
     * by the flattened stream. Returns undefined when nothing changes, so the
     * original elements (and their keys) are reused untouched.
     */
    rewriteTree(node, depth) {
        if (node === null || typeof node !== "object" || depth > MAX_TREE_DEPTH) return undefined;

        if (Array.isArray(node)) {
            let copy = null;
            for (let i = 0; i < node.length; i++) {
                const replacement = this.rewriteTree(node[i], depth + 1);
                if (replacement !== undefined) {
                    if (copy === null) copy = node.slice();
                    copy[i] = replacement;
                }
            }
            return copy === null ? undefined : copy;
        }

        const props = node.props;
        if (props === null || typeof props !== "object") return undefined;

        if (Array.isArray(props.channelStream)) {
            const flattened = this.flattenStream(props.channelStream);
            if (flattened === props.channelStream) return undefined;
            return BdApi.React.cloneElement(node, {channelStream: flattened});
        }

        if (props.children !== undefined) {
            const children = this.rewriteTree(props.children, depth + 1);
            if (children !== undefined) return BdApi.React.cloneElement(node, {children});
        }
        return undefined;
    }

    /**
     * Replaces every revealable collapsed group in a channel stream with the
     * items it contains. Returns the same array when there is nothing to do.
     */
    flattenStream(stream) {
        const cached = this.streamCache.get(stream);
        if (cached !== undefined) return cached;

        let out = null;
        for (let i = 0; i < stream.length; i++) {
            const item = stream[i];
            if (this.isRevealableGroup(item) && this.isRenderableGroupContent(item.content)) {
                if (out === null) out = stream.slice(0, i);
                for (const inner of item.content) out.push(inner);
            } else if (out !== null) {
                out.push(item);
            }
        }

        const result = out === null ? stream : out;
        this.streamCache.set(stream, result);
        return result;
    }

    isRevealableGroup(item) {
        if (item === null || typeof item !== "object" || !Array.isArray(item.content)) return false;
        if (item.type === this.streamTypes.MESSAGE_GROUP_BLOCKED) return true;
        if (item.type === this.streamTypes.MESSAGE_GROUP_IGNORED) return this.settings.revealIgnored;
        return false;
    }

    /** Only reveal a group whose items the message list knows how to render on its own. */
    isRenderableGroupContent(content) {
        const types = this.streamTypes;
        for (const inner of content) {
            if (inner === null || typeof inner !== "object") return this.rejectGroup(inner);
            if (inner.type === types.DIVIDER) continue;
            if ((inner.type === types.MESSAGE || inner.type === types.THREAD_STARTER_MESSAGE) && inner.content !== null && typeof inner.content === "object") continue;
            return this.rejectGroup(inner);
        }
        return true;
    }

    rejectGroup(inner) {
        this.reportOnce("group-content", "A collapsed group contained an item the plugin does not recognise; that group is left collapsed.", inner);
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* Refreshing chat views that are already mounted                      */
    /* ------------------------------------------------------------------ */

    /**
     * A React.memo component caches the inner function on its mounted fiber,
     * so (un)patching `memo.type` alone only affects chat views mounted later.
     * For the views on screen, point their fibers at the current `memo.type`
     * and ask Discord's own store subscription (useStateFromStores) to
     * re-render them, exactly as a store update would.
     */
    refreshMountedChats() {
        if (!this.chatComponent) return 0;

        let fibers;
        try {
            fibers = this.findMountedChatFibers();
        } catch (error) {
            this.reportOnce("find-fibers", "Could not inspect the open chat views; switch channels to apply the change.", error);
            return 0;
        }

        let refreshed = 0;
        for (const fiber of fibers) {
            if (this.rerenderChatFiber(fiber)) refreshed++;
        }
        if (fibers.size > refreshed) {
            this.log("warn", `Could not refresh ${fibers.size - refreshed} open chat view(s); switch channels to apply the change.`);
        }
        return refreshed;
    }

    findMountedChatFibers() {
        const result = new Set();
        const getFiber = BdApi.ReactUtils?.getInternalInstance;
        if (typeof getFiber !== "function" || typeof document === "undefined") return result;

        for (const node of document.querySelectorAll(MOUNTED_CHAT_SELECTOR)) {
            let fiber = null;
            try {
                fiber = getFiber(node);
            } catch {
                continue;
            }
            const chatFiber = ShowBlockedMessages.findAncestorFiber(fiber, candidate => candidate.elementType === this.chatComponent);
            if (!chatFiber) continue;
            if (chatFiber.alternate && result.has(chatFiber.alternate)) continue;
            result.add(chatFiber);
        }
        return result;
    }

    static findAncestorFiber(fiber, predicate) {
        let current = fiber;
        let hops = 0;
        while (current && hops++ < MAX_FIBER_HOPS) {
            if (predicate(current)) return current;
            current = current.return;
        }
        return null;
    }

    rerenderChatFiber(fiber) {
        const render = this.chatComponent.type;
        for (const candidate of [fiber, fiber.alternate]) {
            if (candidate && candidate.elementType === this.chatComponent) candidate.type = render;
        }

        const hook = ShowBlockedMessages.findStoreStateHook(fiber.memoizedState) ?? ShowBlockedMessages.findStoreStateHook(fiber.alternate?.memoizedState);
        if (!hook) return false;

        try {
            hook.queue.dispatch({});
            return true;
        } catch (error) {
            this.reportOnce("refresh", "Re-rendering an open chat view failed; switch channels to apply the change.", error);
            return false;
        }
    }

    /**
     * Finds the dummy `useState(null)` hook of Discord's `useStateFromStores`
     * in a fiber's hook list. That hook stores `{stores, getStateFromStores,
     * areStatesEqual, ...}` in a preceding `useRef`, so the signature is
     * unambiguous, and Discord itself re-renders by dispatching `{}` to it.
     */
    static findStoreStateHook(firstHook) {
        let hook = firstHook;
        let hops = 0;
        while (hook && typeof hook === "object" && hops++ < MAX_HOOK_HOPS) {
            const ref = hook.memoizedState?.current;
            if (ref && typeof ref === "object" && Array.isArray(ref.stores) && typeof ref.getStateFromStores === "function") {
                // useRef -> useInsertionEffect -> useState(null) -> useInsertionEffect
                const stateHook = hook.next?.next;
                const dispatch = stateHook?.queue?.dispatch;
                const state = stateHook?.memoizedState;
                if (typeof dispatch === "function" && (state === null || isEmptyPlainObject(state))) return stateHook;
            }
            hook = hook.next;
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Diagnostics                                                         */
    /* ------------------------------------------------------------------ */

    fail(message, error) {
        this.log("error", `${message} The plugin stays inactive and Discord's own blocked-message behaviour is unchanged.`, ...(error ? [error] : []));
        try {
            BdApi.UI?.showToast?.(`${this.name}: ${message} Check the console for details.`, {type: "error"});
        } catch {
            // A failed toast must never break anything.
        }
    }

    reportOnce(key, message, detail) {
        if (this.reportedProblems.has(key)) return;
        this.reportedProblems.add(key);
        this.log("error", message, ...(detail !== undefined ? [detail] : []));
    }

    log(level, ...args) {
        const logger = BdApi.Logger;
        if (logger && typeof logger[level] === "function") {
            logger[level](this.name, ...args);
            return;
        }
        const method = typeof console[level] === "function" ? level : "log";
        console[method](`[${this.name}]`, ...args);
    }
};
