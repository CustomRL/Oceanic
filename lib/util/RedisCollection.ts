/** @module RedisCollection */
import type Client from "../Client";
import type Base from "../structures/Base";

export interface RedisCollectionOptions {
    /** Store the payload's nested `user` under its own key (via the client's users cache), and join it back on read. */
    joinUser?: boolean;
    /** In seconds, how long an entry is kept after its last write. */
    ttl?: number;
}

/**
 * This is an internal class. A cache kept in Redis: one hash per entity, holding each top-level field of the raw payload JSON-encoded.
 * Writes are not awaited; commands on a single connection run in order, so a later read sees an earlier write.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default class RedisCollection<M extends Record<string, any>, C extends Base> {
    /**
     * @hidden Set while an object read from Redis is rebuilt. The constructors update other caches from nested data (authors, members, referenced messages);
     * that data is as old as the entry, so those writes are skipped instead of overwriting newer data.
     */
    static reading = false;
    private _client!: Client;
    private _construct: (data: M) => C;
    private _options: RedisCollectionOptions;
    prefix: string;
    constructor(client: Client, prefix: string, construct: (data: M) => C, options: RedisCollectionOptions = {}) {
        Object.defineProperty(this, "_client", { value: client });
        this._construct = construct;
        this._options = options;
        this.prefix = prefix;
    }

    private async read(key: string): Promise<Record<string, unknown> | undefined> {
        const hash = await this._client.options.redis.client.hGetAll(key);
        const keys = Object.keys(hash);
        if (keys.length === 0) {
            return undefined;
        }
        return Object.fromEntries(keys.map(k => [k, JSON.parse(hash[k]) as unknown]));
    }

    async delete(id: string): Promise<boolean> {
        return (await this._client.options.redis.client.del(this.prefix + id)) > 0;
    }

    async get(id: string): Promise<C | undefined> {
        const [data, user] = await Promise.all([
            this.read(this.prefix + id),
            this._options.joinUser ? this.read(this._client.users.prefix + id) : undefined
        ]);
        if (!data || (this._options.joinUser && !user)) {
            return undefined;
        }
        if (user) {
            data.user = user;
        }
        RedisCollection.reading = true;
        try {
            return this._construct(data as M);
        } finally {
            RedisCollection.reading = false;
        }
    }

    async has(id: string): Promise<boolean> {
        return (await this._client.options.redis.client.exists(this.prefix + id)) > 0;
    }

    /** @hidden Builds an object from `value`, and merges the fields present into the stored entry. */
    update(value: Partial<M> & { id?: string; }): C {
        const item = this._construct(value as M);
        this.write(item.id, value);
        return item;
    }

    /** @hidden Merges the fields present in `data` into the stored entry, without building an object. */
    write(id: string, data: Partial<M>): void {
        if (RedisCollection.reading) {
            return;
        }
        const fields: Record<string, string> = {};
        for (const [field, value] of Object.entries(data)) {
            if (value !== undefined && !(this._options.joinUser && field === "user")) {
                fields[field] = JSON.stringify(value);
            }
        }
        const key = this.prefix + id;
        const redis = this._client.options.redis.client;
        redis.hSet(key, fields).catch((err: Error) => this._client.emit("error", err));
        if (this._options.ttl) {
            redis.expire(key, this._options.ttl).catch((err: Error) => this._client.emit("error", err));
        }
    }
}
