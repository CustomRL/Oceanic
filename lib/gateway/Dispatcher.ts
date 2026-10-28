/** @module Dispatcher */
import type Shard from "./Shard";
import type ShardManager from "./ShardManager";
import * as DefaultDispatchEvents from "./events";
import type * as Types from "../types/namespaced";

export type DispatchEvent = Types.GatewayRaw.AnyDispatchPacket["t"];
export type DispatchEventMap = {
    [K in Types.GatewayRaw.AnyDispatchPacket as K["t"]]: K["d"];
};
export type DispatchFunction<K extends DispatchEvent = DispatchEvent> = (data: DispatchEventMap[K], shard: Shard) => void | Promise<void>;
export default class Dispatcher {
    private manager!: ShardManager;
    /** The tail of each shard's queue. Handlers read and write Redis, so each packet waits for the previous one; otherwise an update could be handled before its create. */
    private queues = new Map<number, Promise<void>>();
    events: Map<DispatchEvent, Array<DispatchFunction>> = new Map();
    constructor(manager: ShardManager) {
        Object.defineProperty(this, "manager", {
            value:        manager,
            writable:     false,
            enumerable:   false,
            configurable: false
        });

        const type = this.manager.options.dispatcher.blacklist === null ? "blacklist" :
            (this.manager.options.dispatcher.whitelist === null ? "whitelist" : "none");

        for (const [event, fn] of Object.entries(DefaultDispatchEvents) as Array<[DispatchEvent, DispatchFunction]>) {
            if (type === "none" ||
                (type === "whitelist" && this.manager.options.dispatcher.whitelist?.includes(event)) ||
                (type === "blacklist" && !this.manager.options.dispatcher.blacklist?.includes(event))) {
                this.register(event, fn);
            }
        }
    }

    private handle(data: Types.GatewayRaw.AnyDispatchPacket, shard: Shard): void {
        const event = data.t;
        if (!this.events.has(event)) return;
        const arr = this.events.get(event)!;
        const run = async (): Promise<void> => {
            for (const fn of arr) {
                try {
                    await fn(data.d, shard);
                } catch (err) {
                    // with no error listener, emitting "error" throws; in a microtask that surfaces as an uncaught error instead of stopping the queue
                    queueMicrotask(() => this.manager.client.emit("error", err as Error, shard.id));
                }
            }
        };
        this.queues.set(shard.id, (this.queues.get(shard.id) ?? Promise.resolve()).then(run));
    }

    register<K extends DispatchEvent>(event: K, fn: DispatchFunction<K>, replace = false): void {
        if (!this.events.has(event)) this.events.set(event, []);
        const arr = this.events.get(event)!;
        if (replace && arr.length !== 0) arr.splice(0, arr.length);
        arr.push(fn as never);
    }

    unregister<K extends DispatchEvent>(event: K, fn?: DispatchFunction<K>): void {
        if (!this.events.has(event)) return;
        const arr = this.events.get(event)!;
        if (fn) {
            const index = arr.indexOf(fn as never);
            if (index !== -1) arr.splice(index, 1);
        } else arr.splice(0, arr.length);
    }
}
