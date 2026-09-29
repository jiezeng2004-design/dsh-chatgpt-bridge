/** The last turn/end reason in the log, if any. */
export function lastTurnEnd(events) {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (event.type === 'turn/end') {
            return { turn: event.data.turn, reason: event.data.reason };
        }
    }
    return undefined;
}
/** Derive the bridge status from a DSH state snapshot. */
export function deriveStatus(input) {
    if (input.pendingApprovals > 0)
        return 'waiting_for_approval';
    if (input.pendingQuestions > 0)
        return 'waiting_for_user';
    if (input.agentStatus === 'running')
        return 'running';
    if (input.hasPendingInbox)
        return 'queued';
    const last = lastTurnEnd(input.events);
    if (last === undefined)
        return input.live === false ? 'unknown' : 'idle';
    switch (last.reason.kind) {
        case 'completed':
            return 'completed';
        case 'error':
            return 'failed';
        case 'aborted':
            return 'cancelled';
        default:
            return last.reason.kind; // blocked | max-tokens | interrupted | forked
    }
}
/**
 * Fold durable approval audit events. Used when the Web api-proxy (not this
 * process's parked map) owns the answerer.
 */
export function undecidedApprovals(events) {
    const asked = new Map();
    const decided = new Set();
    for (const event of events) {
        const data = event.data;
        if (event.type === 'approval/decided' && typeof data?.id === 'string') {
            decided.add(data.id);
        }
        else if (event.type === 'approval/asked' && typeof data?.id === 'string' && typeof data.toolName === 'string') {
            asked.set(data.id, {
                id: data.id,
                toolName: data.toolName,
                ...(data.callId === undefined ? {} : { callId: data.callId }),
                ...(data.reason === undefined ? {} : { reason: data.reason }),
            });
        }
    }
    return [...asked.values()].filter((item) => !decided.has(item.id));
}
/**
 * Open ask_user_question calls. Questions are not durable session events;
 * the in-flight tool call is the only log signal when the Web provider owns the slot.
 */
export function openAskUserQuestions(events) {
    const open = new Map();
    for (const event of events) {
        if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
            open.set(event.data.callId, { callId: event.data.callId, arguments: event.data.arguments });
        }
        else if (event.type === 'tool/result') {
            const callId = event.data.message?.source?.callId;
            if (callId !== undefined)
                open.delete(callId);
        }
    }
    return [...open.values()];
}
/**
 * Fold the durable 'agent/inbox/spliced' events to recover pending-message
 * counts for a session that is not live (its Inbox projection is not
 * replayed into memory). Mirrors the Inbox splice semantics.
 */
export function foldPendingMessages(events) {
    const lists = { 'next-turn': [], 'next-step': [] };
    for (const event of events) {
        if (event.type !== 'agent/inbox/spliced')
            continue;
        const { target, start, removedCount, inserted } = event.data;
        const list = lists[target];
        const clamp = Math.max(0, Math.min(start, list.length));
        const remove = removedCount === undefined ? list.length - clamp : Math.min(removedCount, list.length - clamp);
        list.splice(clamp, remove, ...inserted.map((message) => message.id));
    }
    return { nextTurn: lists['next-turn'].length, nextStep: lists['next-step'].length };
}
