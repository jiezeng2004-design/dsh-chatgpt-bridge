/**
 * Duck-typed DSH host api-proxy. Used only when the Web surface shares this
 * process (`ctx.apiProxy`). Observes mux frames and settles via respond() —
 * the same path the Web UI uses. Does not wrap userQuestions.ask.
 */
import { randomUUID } from 'node:crypto';
/**
 * True when this process's loader already lists the Web api-gateway row,
 * even if that plugin has not started yet. Used so we do not steal the
 * single userQuestions slot during boot and crash api-proxy.
 */
export function compositionHasWebGateway(ctx) {
    const loader = (ctx.get('loader') ?? ctx.loader);
    if (loader === undefined)
        return false;
    const seen = [];
    if (loader.entries !== undefined) {
        for (const entry of loader.entries())
            seen.push(entry);
    }
    if (loader.store !== undefined) {
        for (const entry of Object.values(loader.store))
            seen.push(entry);
    }
    for (const entry of seen) {
        const id = entry.id ?? entry.options?.id;
        const name = entry.options?.name ?? '';
        if (id === 'api-gateway' || id === 'typert-gateway' || name === '@deepseek-ai/dsh-host-apiproxy' || name === '@deepseek-ai/dsh-api-gateway')
            return true;
    }
    return false;
}
export function asApiProxy(value) {
    if (value === null || typeof value !== 'object')
        return undefined;
    const candidate = value;
    if (typeof candidate.respond !== 'function')
        return undefined;
    if (candidate.events === undefined || typeof candidate.events.mux !== 'function')
        return undefined;
    return candidate;
}
export function startMuxMirror(api, handlers, signal, onError) {
    void (async () => {
        try {
            for await (const envelope of api.events.mux({ rpcId: randomUUID(), payload: {} }, signal)) {
                if (signal.aborted)
                    return;
                if (envelope === null || typeof envelope !== 'object')
                    continue;
                const payload = envelope.payload;
                if (payload === undefined || typeof payload.type !== 'string')
                    continue;
                const sessionId = payload.sessionId ?? '';
                switch (payload.type) {
                    case 'approval/requested':
                        if (typeof envelope.rpcId === 'string' && typeof payload.approvalId === 'string' && typeof payload.toolName === 'string') {
                            handlers.onApprovalRequested({
                                rpcId: envelope.rpcId,
                                sessionId,
                                approvalId: payload.approvalId,
                                toolName: payload.toolName,
                                ...(payload.callId === undefined ? {} : { callId: payload.callId }),
                                ...(payload.reason === undefined ? {} : { reason: payload.reason }),
                            });
                        }
                        break;
                    case 'approval/resolved':
                        if (typeof payload.approvalId === 'string')
                            handlers.onApprovalResolved(sessionId, payload.approvalId);
                        break;
                    case 'question/requested':
                        if (typeof envelope.rpcId === 'string' && Array.isArray(payload.questions)) {
                            handlers.onQuestionRequested({
                                rpcId: envelope.rpcId,
                                sessionId,
                                questions: payload.questions,
                            });
                        }
                        break;
                    case 'question/resolved':
                        if (typeof payload.questionRpcId === 'string')
                            handlers.onQuestionResolved(sessionId, payload.questionRpcId);
                        break;
                    default:
                        break;
                }
            }
        }
        catch (error) {
            if (signal.aborted)
                return;
            onError?.(error instanceof Error ? error.message : String(error));
        }
    })();
}
export async function respondApproval(api, rpcId, sessionId, approvalId, outcome) {
    return api.respond({
        type: 'client-response',
        rpcId,
        result: { ok: true, value: { sessionId, approvalId, outcome } },
    });
}
export async function respondQuestion(api, rpcId, sessionId, answer) {
    return api.respond({
        type: 'client-response',
        rpcId,
        result: { ok: true, value: { sessionId, answer } },
    });
}
export async function cancelQuestion(api, rpcId) {
    return api.respond({
        type: 'client-response',
        rpcId,
        result: { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } },
    });
}
