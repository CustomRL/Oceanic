// Drives the real dispatcher handlers with raw gateway payloads against a real Redis, and checks what lands there.
// Run `npm run prepare` first; this imports the built library.
import assert from "node:assert/strict";
import { createClient } from "redis";
import { Client, ClientApplication, ExtendedUser, Member, Message, Shard } from "../esm.mjs";

const redis = createClient({ url: process.env.REDIS_URL ?? "redis://localhost:6380" });
redis.on("error", err => console.error("redis:", err));
await redis.connect();

const client = new Client({
    auth:    "Bot placeholder",
    gateway: { intents: ["GUILDS", "GUILD_MEMBERS", "GUILD_MESSAGES"] },
    redis:   { client: redis, messageTTL: 600 }
});
const errors = [];
client.on("error", err => errors.push(err));

const keys = [];
let seq = 0n;
// unique snowflakes per run, so nothing collides with other data or earlier runs
const snowflake = () => String(((BigInt(Date.now()) - 1420070400000n) << 22n) | (BigInt(process.pid & 0x3FF) << 12n) | (seq++ & 0xFFFn));
const rawUser = (id, username) => ({ id, username, discriminator: "0", global_name: null, avatar: null, bot: false });
const userKey = id => `oceanic:user:${id}`;
const memberKey = (guildID, id) => `oceanic:member:${guildID}:${id}`;
const messageKey = id => `oceanic:message:${id}`;

const shard = new Shard(0, client.shards);
shard.send = () => {};
const dispatcher = client.shards.dispatcher;
const dispatch = (t, d) => dispatcher["handle"]({ op: 0, s: 1, t, d }, shard);
const drain = () => dispatcher["queues"].get(shard.id);
const once = event => new Promise(resolve => client.once(event, (...args) => resolve(args)));
const hgetall = async key => Object.fromEntries(Object.entries(await redis.hGetAll(key)).map(([k, v]) => [k, JSON.parse(v)]));

const botID = snowflake(), guildID = snowflake(), channelID = snowflake();
keys.push(userKey(botID), memberKey(guildID, botID));
client["_application"] = new ClientApplication({ id: botID, flags: 0 }, client);
client["_user"] = new ExtendedUser({ ...rawUser(botID, "bot_1"), bot: true, mfa_enabled: false, verified: true, flags: 0, locale: "en-US", email: null }, client);

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
}

try {
    await check("GUILD_CREATE caches the guild and keeps the client member in memory", async () => {
        dispatch("GUILD_CREATE", {
            id: guildID, name: "guild_1", icon: null, splash: null, discovery_splash: null, owner_id: botID, afk_channel_id: null, afk_timeout: 300,
            verification_level: 0, default_message_notifications: 0, explicit_content_filter: 0, features: [], mfa_level: 0, application_id: null,
            system_channel_id: null, system_channel_flags: 0, rules_channel_id: null, vanity_url_code: null, description: null, banner: null,
            premium_tier: 0, preferred_locale: "en-US", public_updates_channel_id: null, nsfw_level: 0, premium_progress_bar_enabled: false,
            safety_alerts_channel_id: null, emojis: [], stickers: [], joined_at: new Date().toISOString(), large: false, member_count: 1,
            roles:    [{ id: guildID, name: "@everyone", color: 0, hoist: false, position: 0, permissions: "1024", managed: false, mentionable: false, flags: 0, colors: { primary_color: 0, secondary_color: null, tertiary_color: null } }],
            channels: [{ id: channelID, type: 0, name: "channel_1", position: 0, permission_overwrites: [], nsfw: false, topic: null, last_message_id: null, rate_limit_per_user: 0, parent_id: null, flags: 0 }],
            members:  [{ user: rawUser(botID, "bot_1"), roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 }],
            threads: [], presences: [], voice_states: [], stage_instances: [], guild_scheduled_events: [], soundboard_sounds: []
        });
        await drain();
        const guild = client.guilds.get(guildID);
        assert.ok(guild, "guild cached");
        assert.equal(guild.clientMember.id, botID);
        assert.ok(guild.permissionsOf(botID).has("VIEW_CHANNEL"), "permissionsOf(client id) stays synchronous");
        assert.equal(await redis.exists(memberKey(guildID, botID)), 1);
    });

    const authorID = snowflake();
    keys.push(userKey(authorID), memberKey(guildID, authorID));
    const rawMessage = (id, content) => ({
        id, channel_id: channelID, guild_id: guildID, author: rawUser(authorID, "user_1"), content, timestamp: new Date().toISOString(),
        edited_timestamp: null, tts: false, mention_everyone: false, mentions: [], mention_roles: [], attachments: [], embeds: [], pinned: false, type: 0,
        member: { roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 }
    });

    await check("MESSAGE_CREATE -> MESSAGE_UPDATE -> MESSAGE_DELETE", async () => {
        const id = snowflake();
        keys.push(messageKey(id));
        dispatch("MESSAGE_CREATE", rawMessage(id, "first"));
        await drain();
        assert.equal((await hgetall(messageKey(id))).content, "first");
        assert.ok(await redis.ttl(messageKey(id)) > 0, "message has a TTL");
        assert.equal((await hgetall(userKey(authorID))).username, "user_1", "author written as a user");
        assert.equal((await hgetall(memberKey(guildID, authorID))).user, undefined, "member stored without its user");

        const updated = once("messageUpdate");
        dispatch("MESSAGE_UPDATE", { ...rawMessage(id, "second"), edited_timestamp: new Date().toISOString() });
        const [message, oldMessage] = await updated;
        assert.equal(oldMessage.content, "first");
        assert.equal(message.content, "second");
        assert.equal((await hgetall(messageKey(id))).content, "second");

        const deleted = once("messageDelete");
        dispatch("MESSAGE_DELETE", { id, channel_id: channelID, guild_id: guildID });
        const [cached] = await deleted;
        assert.ok(cached instanceof Message, "messageDelete carries the cached message");
        assert.equal(cached.content, "second");
        assert.equal(await redis.exists(messageKey(id)), 0);
    });

    await check("MESSAGE_DELETE_BULK delivers cached messages", async () => {
        const ids = [snowflake(), snowflake()];
        keys.push(...ids.map(messageKey));
        dispatch("MESSAGE_CREATE", rawMessage(ids[0], "bulk"));
        const deleted = once("messageDeleteBulk");
        dispatch("MESSAGE_DELETE_BULK", { ids, channel_id: channelID, guild_id: guildID });
        const [messages] = await deleted;
        assert.ok(messages[0] instanceof Message);
        assert.equal(messages[0].content, "bulk");
        assert.ok(!(messages[1] instanceof Message), "uncached message stays partial");
        assert.equal(await redis.exists(messageKey(ids[0])), 0);
    });

    await check("GUILD_MEMBER_ADD -> partial GUILD_MEMBER_UPDATE merges -> GUILD_MEMBER_REMOVE", async () => {
        const id = snowflake(), roleID = snowflake();
        keys.push(userKey(id), memberKey(guildID, id));
        const joinedAt = "2020-01-01T00:00:00.000Z";
        dispatch("GUILD_MEMBER_ADD", { guild_id: guildID, user: rawUser(id, "user_2"), nick: "old", roles: [], joined_at: joinedAt, deaf: false, mute: false, flags: 0, pending: false });
        await drain();
        assert.equal((await hgetall(memberKey(guildID, id))).nick, "old");

        const updated = once("guildMemberUpdate");
        dispatch("GUILD_MEMBER_UPDATE", { guild_id: guildID, user: rawUser(id, "user_2"), nick: "new", roles: [roleID] });
        const [, oldMember] = await updated;
        assert.equal(oldMember.nick, "old");
        const stored = await hgetall(memberKey(guildID, id));
        assert.equal(stored.nick, "new");
        assert.deepEqual(stored.roles, [roleID]);
        assert.equal(stored.joined_at, joinedAt, "fields absent from the update are kept");
        const member = await client.guilds.get(guildID).members.get(id);
        assert.equal(member.joinedAt.toISOString(), joinedAt);
        assert.equal(member.user.username, "user_2", "member read joins its user");

        const removed = once("guildMemberRemove");
        dispatch("GUILD_MEMBER_REMOVE", { guild_id: guildID, user: rawUser(id, "user_2") });
        const [removedMember] = await removed;
        assert.ok(removedMember instanceof Member);
        assert.equal(removedMember.nick, "new");
        assert.equal(await redis.exists(memberKey(guildID, id)), 0);
        assert.equal(await redis.exists(userKey(id)), 1, "the user outlives the member");
    });

    await check("GUILD_MEMBERS_CHUNK with cacheOnly writes to Redis and accumulates nothing", async () => {
        let nonce;
        shard.send = (op, data) => { nonce = data.nonce; };
        const result = shard.requestGuildMembers(guildID, { cacheOnly: true, timeout: 10000 });
        const chunk = index => {
            const members = [snowflake(), snowflake(), snowflake()].map(id => {
                keys.push(userKey(id), memberKey(guildID, id));
                return { user: rawUser(id, `user_${id}`), roles: [], joined_at: new Date().toISOString(), deaf: false, mute: false, flags: 0 };
            });
            dispatch("GUILD_MEMBERS_CHUNK", { guild_id: guildID, members, chunk_index: index, chunk_count: 2, nonce });
            return members;
        };
        const first = chunk(0);
        await drain();
        const request = shard["_requestMembersPromise"][nonce];
        assert.equal(request.members.length, 0, "no members held");
        assert.equal(request.received, 3);
        const second = chunk(1);
        assert.equal(await result, 6);
        for (const m of [...first, ...second]) {
            assert.equal(await redis.exists(memberKey(guildID, m.user.id)), 1);
            assert.equal(await redis.exists(userKey(m.user.id)), 1);
        }
    });

    await check("dispatch is ordered per shard", async () => {
        const id = snowflake();
        keys.push(messageKey(id));
        const olds = [];
        const listener = (message, oldMessage) => olds.push(oldMessage?.content);
        client.on("messageUpdate", listener);
        dispatch("MESSAGE_CREATE", rawMessage(id, "create"));
        dispatch("MESSAGE_UPDATE", rawMessage(id, "update 1"));
        dispatch("MESSAGE_UPDATE", rawMessage(id, "update 2"));
        await drain();
        client.off("messageUpdate", listener);
        assert.deepEqual(olds, ["create", "update 1"], "each update sees the state left by the previous packet");
        assert.equal((await hgetall(messageKey(id))).content, "update 2");
        assert.equal((await client.getChannel(channelID).messages.get(id)).content, "update 2");
    });

    await check("a throwing handler is emitted as error and the queue continues", async () => {
        dispatcher.register("RATE_LIMITED", () => {
            throw new Error("handler failure");
        }, true);
        const id = snowflake();
        keys.push(messageKey(id));
        dispatch("RATE_LIMITED", {});
        dispatch("MESSAGE_CREATE", rawMessage(id, "after error"));
        await drain();
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(errors.splice(0).map(e => e.message).join(), "handler failure");
        assert.equal((await hgetall(messageKey(id))).content, "after error");
    });

    await check("cached data survives a new client", async () => {
        const restarted = new Client({ redis: { client: redis } });
        assert.equal((await restarted.users.get(authorID)).username, "user_1");
    });

    assert.deepEqual(errors, [], "no Redis write errors");
    console.log(`\n${passed} checks passed`);
} catch (err) {
    console.error(err, errors);
    process.exitCode = 1;
} finally {
    if (keys.length !== 0) {
        await redis.del(keys);
    }
    await redis.quit();
}
