"use strict";

/*
 * Unit tests for the pure parts of ShowBlockedMessages.plugin.js.
 * Run with:  node test/run-tests.js
 *
 * The plugin reads the global `BdApi`; a small stub is installed here so the
 * file can be required outside Discord. Nothing here touches Discord or
 * BetterDiscord.
 */

const assert = require("node:assert/strict");
const path = require("node:path");

const logs = [];
const saved = {};

global.BdApi = {
    React: {
        cloneElement(element, props) {
            return {...element, props: {...element.props, ...props}};
        }
    },
    Logger: {
        info: (...args) => logs.push(["info", ...args]),
        warn: (...args) => logs.push(["warn", ...args]),
        error: (...args) => logs.push(["error", ...args])
    },
    Data: {
        load: (name, key) => saved[`${name}:${key}`],
        save: (name, key, value) => { saved[`${name}:${key}`] = value; }
    },
    Webpack: {
        Filters: {
            byKeys: () => () => false,
            bySource: () => () => false
        },
        getModule: () => undefined
    },
    Patcher: {
        after: () => () => {},
        unpatchAll: () => {}
    },
    UI: {},
    ReactUtils: {}
};

const Plugin = require(path.join(__dirname, "..", "ShowBlockedMessages.plugin.js"));

const tests = [];
function test(name, fn) { tests.push({name, fn}); }

function message(id, authorId, groupId = id) {
    return {type: "MESSAGE", content: {id, author: {id: authorId}}, groupId};
}
function blockedGroup(key, content, extra = {}) {
    return {type: "MESSAGE_GROUP_BLOCKED", key, content, ...extra};
}
function ignoredGroup(key, content) {
    return {type: "MESSAGE_GROUP_IGNORED", key, content};
}

function makePlugin() {
    const plugin = new Plugin({name: "ShowBlockedMessages"});
    plugin.active = true;
    return plugin;
}

/* ---------------------------------------------------------------- */
/* flattenStream                                                     */
/* ---------------------------------------------------------------- */

test("stream without collapsed groups is returned by identity", () => {
    const plugin = makePlugin();
    const stream = [{type: "DIVIDER", content: "Today"}, message("1", "a"), message("2", "a", "1")];
    assert.equal(plugin.flattenStream(stream), stream);
});

test("blocked groups are replaced by their items, in order, keeping item identity", () => {
    const plugin = makePlugin();
    const divider = {type: "DIVIDER", unreadId: "3"};
    const m3 = message("3", "blocked");
    const m4 = message("4", "blocked", "3");
    const group = blockedGroup("3", [divider, m3, m4], {hasUnread: true});
    const m1 = message("1", "a");
    const m5 = message("5", "b");
    const stream = [m1, group, m5];

    const out = plugin.flattenStream(stream);
    assert.notEqual(out, stream);
    assert.deepEqual(out.map(item => item), [m1, divider, m3, m4, m5]);
    assert.equal(out[1], divider);
    assert.equal(out[2], m3);
    assert.equal(stream.length, 3, "input stream is not mutated");
    assert.equal(group.content.length, 3, "group content is not mutated");
});

test("several consecutive and non-consecutive groups are all revealed", () => {
    const plugin = makePlugin();
    const stream = [
        blockedGroup("1", [message("1", "x")]),
        blockedGroup("2", [message("2", "y")]),
        message("3", "a"),
        blockedGroup("4", [message("4", "x"), message("5", "x", "4")])
    ];
    const out = plugin.flattenStream(stream);
    assert.deepEqual(out.map(item => item.content.id), ["1", "2", "3", "4", "5"]);
    assert.ok(out.every(item => item.type === "MESSAGE"));
});

test("thread starter messages inside a group are revealed", () => {
    const plugin = makePlugin();
    const starter = {type: "THREAD_STARTER_MESSAGE", content: {id: "9"}, groupId: "9"};
    const out = plugin.flattenStream([blockedGroup("9", [starter])]);
    assert.deepEqual(out, [starter]);
});

test("flattening is cached per stream identity", () => {
    const plugin = makePlugin();
    const stream = [blockedGroup("1", [message("1", "x")])];
    const first = plugin.flattenStream(stream);
    const second = plugin.flattenStream(stream);
    assert.equal(first, second);
});

test("ignored groups stay collapsed by default and are revealed when the setting is on", () => {
    const plugin = makePlugin();
    const group = ignoredGroup("1", [message("1", "x")]);
    const stream = [group];
    assert.equal(plugin.flattenStream(stream), stream);

    plugin.updateSetting("revealIgnored", true);
    assert.equal(saved["ShowBlockedMessages:settings"].revealIgnored, true, "setting is persisted");
    const out = plugin.flattenStream(stream);
    assert.deepEqual(out, group.content);
});

test("groups with unrecognised items are left collapsed and reported once", () => {
    const plugin = makePlugin();
    const weird = blockedGroup("1", [{type: "SOMETHING_NEW", content: {id: "1"}}]);
    const stream = [message("0", "a"), weird];
    assert.equal(plugin.flattenStream(stream), stream);
    plugin.flattenStream([blockedGroup("2", [{type: "SOMETHING_NEW"}])]);
    const reports = logs.filter(entry => entry[0] === "error" && String(entry[2]).includes("does not recognise"));
    assert.equal(reports.length, 1);
});

test("spammer and suspended-user groups are never touched", () => {
    const plugin = makePlugin();
    const stream = [
        {type: "MESSAGE_GROUP_SPAMMER", key: "1", content: [message("1", "x")]},
        {type: "MESSAGE_GROUP_SUSPENDED_USER", key: "2", content: [message("2", "y")]}
    ];
    assert.equal(plugin.flattenStream(stream), stream);
});

/* ---------------------------------------------------------------- */
/* rewriteTree                                                       */
/* ---------------------------------------------------------------- */

function element(type, props, key = null) {
    return {$$typeof: Symbol.for("react.element"), type, key, props};
}

test("rewriteTree replaces channelStream on the nested list element and keeps keys", () => {
    const plugin = makePlugin();
    const stream = [message("1", "a"), blockedGroup("2", [message("2", "x")])];
    const list = element("List", {channelStream: stream, channel: {id: "c"}}, "list-key");
    const wrapper = element("Wrapper", {children: list});
    const provider = element("Provider", {value: 1, children: wrapper});

    const out = plugin.rewriteTree(provider, 0);
    assert.ok(out, "a replacement tree is produced");
    assert.notEqual(out, provider);
    assert.equal(out.props.value, 1);
    const newList = out.props.children.props.children;
    assert.equal(newList.key, "list-key");
    assert.equal(newList.props.channel, list.props.channel);
    assert.deepEqual(newList.props.channelStream.map(item => item.content.id), ["1", "2"]);
    assert.equal(list.props.channelStream, stream, "original element is untouched");
});

test("rewriteTree returns undefined when there is nothing to reveal", () => {
    const plugin = makePlugin();
    const list = element("List", {channelStream: [message("1", "a")]});
    const tree = element("Provider", {children: [element("Other", {children: "text"}), list]});
    assert.equal(plugin.rewriteTree(tree, 0), undefined);
    assert.equal(plugin.rewriteTree(null, 0), undefined);
    assert.equal(plugin.rewriteTree("text", 0), undefined);
});

test("rewriteTree handles arrays of children and only copies the changed branch", () => {
    const plugin = makePlugin();
    const untouched = element("Sidebar", {children: "x"});
    const list = element("List", {channelStream: [blockedGroup("1", [message("1", "x")])]});
    const tree = element("Root", {children: [untouched, element("Mid", {children: list})]});
    const out = plugin.rewriteTree(tree, 0);
    assert.equal(out.props.children[0], untouched);
    assert.notEqual(out.props.children[1], tree.props.children[1]);
});

test("onChatRender never throws and falls back to the original output", () => {
    const plugin = makePlugin();
    plugin.flattenStream = () => { throw new Error("boom"); };
    const list = element("List", {channelStream: [blockedGroup("1", [message("1", "x")])]});
    assert.equal(plugin.onChatRender(list), undefined);
    plugin.active = false;
    assert.equal(plugin.onChatRender(list), undefined);
});

/* ---------------------------------------------------------------- */
/* Module and fiber discovery                                        */
/* ---------------------------------------------------------------- */

test("findChatExportKey recognises the memo export and rejects other shapes", () => {
    const inner = function ChatMessages(e) { return {channelStream: e, messageGroupSpacing: 1, showNewMessagesBar: true}; };
    const memo = {$$typeof: Symbol.for("react.memo"), type: inner, compare: null};
    assert.equal(Plugin.findChatExportKey({A: memo}), "A");
    assert.equal(Plugin.findChatExportKey({A: memo}, true), "A");
    assert.equal(Plugin.findChatExportKey({A: {$$typeof: Symbol.for("react.memo"), type: function other() {}}}, true), null);
    assert.equal(Plugin.findChatExportKey({A: inner}), null, "plain functions are not accepted");
    assert.equal(Plugin.findChatExportKey(null), null);
    assert.equal(Plugin.findChatExportKey(42), null);
    assert.equal(Plugin.findChatExportKey({}), null);
});

test("findStoreStateHook finds Discord's useStateFromStores dummy state hook", () => {
    const dispatch = () => {};
    const stateHook = {memoizedState: null, queue: {dispatch}, next: {memoizedState: {tag: 1}, next: null}};
    const effectHook = {memoizedState: {tag: 1}, next: stateHook};
    const refHook = {memoizedState: {current: {stores: [], getStateFromStores: () => 1, areStatesEqual: () => true}}, next: effectHook};
    const unrelated = {memoizedState: "x", queue: {dispatch: () => {}}, next: refHook};
    assert.equal(Plugin.findStoreStateHook(unrelated), stateHook);

    stateHook.memoizedState = {};
    assert.equal(Plugin.findStoreStateHook(unrelated), stateHook);

    stateHook.memoizedState = {real: "state"};
    assert.equal(Plugin.findStoreStateHook(unrelated), null, "a hook holding real state is never used");
    assert.equal(Plugin.findStoreStateHook(null), null);
});

test("rerenderChatFiber points mounted fibers at the current render function and dispatches", () => {
    const plugin = makePlugin();
    const original = function original() {};
    const patched = function patched() {};
    plugin.chatComponent = {$$typeof: Symbol.for("react.memo"), type: patched};

    let dispatched = 0;
    const stateHook = {memoizedState: null, queue: {dispatch: value => { dispatched++; assert.deepEqual(value, {}); }}, next: null};
    const hooks = {memoizedState: {current: {stores: [], getStateFromStores: () => 1}}, next: {memoizedState: {}, next: stateHook}};
    const alternate = {elementType: plugin.chatComponent, type: original, memoizedState: null};
    const fiber = {elementType: plugin.chatComponent, type: original, memoizedState: hooks, alternate};
    alternate.alternate = fiber;

    assert.equal(plugin.rerenderChatFiber(fiber), true);
    assert.equal(fiber.type, patched);
    assert.equal(alternate.type, patched);
    assert.equal(dispatched, 1);

    const noHook = {elementType: plugin.chatComponent, type: original, memoizedState: null, alternate: null};
    assert.equal(plugin.rerenderChatFiber(noHook), false);
});

test("findAncestorFiber walks up and gives up safely", () => {
    const target = {return: null};
    const leaf = {return: {return: target}};
    assert.equal(Plugin.findAncestorFiber(leaf, fiber => fiber === target), target);
    assert.equal(Plugin.findAncestorFiber(leaf, () => false), null);
    const loop = {}; loop.return = loop;
    assert.equal(Plugin.findAncestorFiber(loop, () => false), null, "cycles terminate");
});

/* ---------------------------------------------------------------- */
/* Lifecycle                                                         */
/* ---------------------------------------------------------------- */

test("start fails safely when the chat module cannot be found", () => {
    const plugin = new Plugin({name: "ShowBlockedMessages"});
    BdApi.Webpack.waitForModule = () => Promise.resolve(undefined);
    plugin.start();
    assert.equal(plugin.chatComponent, null);
    return new Promise(resolve => setImmediate(resolve)).then(() => {
        const failures = logs.filter(entry => entry[0] === "error" && String(entry[2]).includes("stays inactive"));
        assert.ok(failures.length >= 1);
        plugin.stop();
        assert.equal(plugin.active, false);
    });
});

test("start patches memo.type when the module is present and stop unpatches", () => {
    const plugin = new Plugin({name: "ShowBlockedMessages"});
    const inner = function ChatMessages(e) { return {channelStream: e, messageGroupSpacing: 1, showNewMessagesBar: true}; };
    const memo = {$$typeof: Symbol.for("react.memo"), type: inner, compare: null};
    const exports = {A: memo};

    const patches = [];
    // Pretend the module factory source contains the markers, as Discord's does.
    BdApi.Webpack.Filters.bySource = (...markers) => (exports, module) => {
        const source = String(module?.exports?.A?.type);
        return markers.every(marker => source.includes(marker));
    };
    BdApi.Webpack.getModule = (filter, options) => {
        if (options && options.defaultExport === false && filter(exports, {exports}, 1)) return exports;
        return undefined;
    };
    BdApi.Patcher.after = (caller, module, key, callback) => {
        patches.push({caller, module, key, callback});
        return () => {};
    };
    let unpatchedFor = null;
    BdApi.Patcher.unpatchAll = caller => { unpatchedFor = caller; };

    plugin.start();
    assert.equal(plugin.chatComponent, memo);
    assert.equal(plugin.chatExportKey, "A");
    assert.equal(patches.length, 1);
    assert.equal(patches[0].caller, "ShowBlockedMessages");
    assert.equal(patches[0].module, memo);
    assert.equal(patches[0].key, "type");

    // The installed callback rewrites a render result.
    const list = element("List", {channelStream: [blockedGroup("1", [message("1", "x")])]});
    const replaced = patches[0].callback(null, [], element("Root", {children: list}));
    assert.deepEqual(replaced.props.children.props.channelStream.map(item => item.content.id), ["1"]);

    plugin.start();
    assert.equal(patches.length, 1, "starting twice does not install duplicate patches");

    plugin.stop();
    assert.equal(unpatchedFor, "ShowBlockedMessages");
    assert.equal(plugin.chatComponent, null);
});

/* ---------------------------------------------------------------- */
/* Reply previews                                                    */
/* ---------------------------------------------------------------- */

test("onReplyPreviewRender clears the blocked flag without mutating the original props", () => {
    const plugin = makePlugin();
    const props = {isReplyAuthorBlocked: true, isReplyAuthorIgnored: false, referencedMessage: {state: 1}, content: "hi"};
    const args = [props];
    plugin.onReplyPreviewRender(args);
    assert.notEqual(args[0], props);
    assert.equal(args[0].isReplyAuthorBlocked, false);
    assert.equal(args[0].content, "hi");
    assert.equal(props.isReplyAuthorBlocked, true, "caller's props object is untouched");
});

test("onReplyPreviewRender leaves ignored authors alone unless the setting is on", () => {
    const plugin = makePlugin();
    const props = {isReplyAuthorBlocked: false, isReplyAuthorIgnored: true};
    const args = [props];
    plugin.onReplyPreviewRender(args);
    assert.equal(args[0], props, "nothing to change, props untouched");

    plugin.updateSetting("revealIgnored", true);
    plugin.onReplyPreviewRender(args);
    assert.equal(args[0].isReplyAuthorIgnored, false);
});

test("onReplyPreviewRender ignores malformed arguments and is inert when inactive", () => {
    const plugin = makePlugin();
    plugin.onReplyPreviewRender(null);
    plugin.onReplyPreviewRender([null]);
    plugin.onReplyPreviewRender(["x"]);
    plugin.active = false;
    const args = [{isReplyAuthorBlocked: true}];
    plugin.onReplyPreviewRender(args);
    assert.equal(args[0].isReplyAuthorBlocked, true);
});

test("findReplyExportKey picks the plain function export with the reply props", () => {
    const component = function K(e) { return e.isReplyAuthorBlocked && e.referencedMessage; };
    const helper = function $(message, content, isReplyAuthorBlocked) { return content; };
    assert.equal(Plugin.findReplyExportKey({A: component, o: helper}), "A");
    class Legacy { render() { return this.props.isReplyAuthorBlocked && this.props.referencedMessage; } }
    Legacy.prototype.isReactComponent = {};
    assert.equal(Plugin.findReplyExportKey({A: Legacy}), null, "class components are not patched this way");
    assert.equal(Plugin.findReplyExportKey({A: {$$typeof: Symbol.for("react.memo"), type: component}}), null);
    assert.equal(Plugin.findReplyExportKey(null), null);
});

test("findDescendantFibers walks child and sibling links but not the root's siblings", () => {
    const target1 = {memoizedProps: {isReplyAuthorBlocked: true, referencedMessage: {}}};
    const target2 = {memoizedProps: {isReplyAuthorBlocked: false, referencedMessage: {}}};
    const leaf = {memoizedProps: {}};
    target1.sibling = leaf;
    const mid = {memoizedProps: {}, child: target1, sibling: target2};
    const rootSibling = {memoizedProps: {isReplyAuthorBlocked: true, referencedMessage: {}}};
    const root = {memoizedProps: {}, child: mid, sibling: rootSibling};
    const found = Plugin.findDescendantFibers(root, Plugin.isReplyPreviewFiber);
    assert.deepEqual(new Set(found), new Set([target1, target2]));
    assert.deepEqual(Plugin.findDescendantFibers(null, () => true), []);
    const loop = {memoizedProps: {}}; loop.child = loop;
    assert.ok(Plugin.findDescendantFibers(loop, () => false).length === 0, "bounded on cycles");
});

test("start also installs the reply-preview patch and stop removes both", () => {
    const plugin = new Plugin({name: "ShowBlockedMessages"});
    const inner = function ChatMessages(e) { return {channelStream: e, messageGroupSpacing: 1, showNewMessagesBar: true}; };
    const chatExports = {A: {$$typeof: Symbol.for("react.memo"), type: inner, compare: null}};
    const replyExports = {A: function K(e) { return e.isReplyAuthorBlocked && e.referencedMessage; }, o: () => {}};
    const sources = new Map([[chatExports, "channelStream:messageGroupSpacing showNewMessagesBar"], [replyExports, "isReplyAuthorBlocked contentPlaceholder isReplySpineClickable repliedAuthor"]]);

    BdApi.Webpack.Filters.bySource = (...markers) => (exports) => markers.every(marker => (sources.get(exports) ?? "").includes(marker));
    BdApi.Webpack.getModule = (filter, options) => {
        if (!options || options.defaultExport !== false) return undefined;
        for (const exports of sources.keys()) if (filter(exports, {exports}, 1)) return exports;
        return undefined;
    };
    const patches = [];
    BdApi.Patcher.after = (caller, module, key, callback) => { patches.push({kind: "after", module, key, callback}); return () => {}; };
    BdApi.Patcher.before = (caller, module, key, callback) => { patches.push({kind: "before", module, key, callback}); return () => {}; };
    let unpatched = 0;
    BdApi.Patcher.unpatchAll = () => { unpatched++; };

    plugin.start();
    assert.equal(plugin.replyModule, replyExports);
    assert.equal(plugin.replyExportKey, "A");
    const before = patches.find(p => p.kind === "before");
    assert.ok(before && before.module === replyExports && before.key === "A");
    const args = [{isReplyAuthorBlocked: true, referencedMessage: {}}];
    before.callback(null, args);
    assert.equal(args[0].isReplyAuthorBlocked, false);

    plugin.stop();
    assert.equal(unpatched, 1);
    assert.equal(plugin.replyModule, null);
});

/* ---------------------------------------------------------------- */

(async () => {
    let failed = 0;
    for (const {name, fn} of tests) {
        try {
            await fn();
            console.log(`ok   ${name}`);
        } catch (error) {
            failed++;
            console.log(`FAIL ${name}`);
            console.log(error && error.stack ? error.stack : error);
        }
    }
    console.log(`\n${tests.length - failed}/${tests.length} tests passed`);
    process.exit(failed ? 1 : 0);
})();
