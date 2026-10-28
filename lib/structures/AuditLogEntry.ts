/** @module AuditLogEntry */
import Base from "./Base";
import type * as Types from "../types/namespaced";
import type { AuditLogActionTypes } from "../Constants";
import type Client from "../Client";

/** Represents a guild audit log entry. */
export default class AuditLogEntry extends Base {
    /** The [type](https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events) of this action. */
    actionType: AuditLogActionTypes;
    /** See the [audit log documentation](https://discord.com/developers/docs/resources/audit-log#audit-log-change-object) for more information. */
    changes?: Array<Types.AuditLog.AuditLogChange>;
    /** Additional info for specific event types */
    options?: Types.AuditLog.AuditLogEntryOptions;
    /** The reason for the change. */
    reason?: string;
    /** The ID of what was targeted (webhook, user, role, etc). */
    targetID: string | null;
    /** The ID of the user or application that made the changes. */
    userID: string | null;
    constructor(data: Types.AuditLog.RawAuditLogEntry, client: Client) {
        super(data.id, client);
        this.actionType = data.action_type;
        this.changes = data.changes;
        this.options = {
            applicationID:                 data.options?.application_id,
            autoModerationRuleName:        data.options?.auto_moderation_rule_name,
            autoModerationRuleTriggerType: data.options?.auto_moderation_rule_trigger_type,
            channelID:                     data.options?.channel_id,
            count:                         data.options?.count,
            deleteMemberDays:              data.options?.delete_member_days,
            id:                            data.options?.id,
            integrationType:               data.options?.integration_type,
            membersRemoved:                data.options?.members_removed,
            messageID:                     data.options?.message_id,
            roleName:                      data.options?.role_name,
            status:                        data.options?.status,
            type:                          data.options?.type
        };
        this.reason = data.reason;
        this.targetID = data.target_id;
        this.userID = data.user_id;
    }
}
