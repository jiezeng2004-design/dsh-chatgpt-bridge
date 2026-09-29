import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence';
type Inspection = {
    meta: SessionHeader;
    events: readonly SessionEvent[];
};
type ReadHandle = {
    header: SessionHeader;
    read(): Promise<SessionHandleReadResult | readonly SessionEvent[]>;
    close(): Promise<void>;
};
/** Read current lifecycle-owned handles, retaining older read-only adapters. */
export declare function inspectPersistedSession(persistence: {
    inspect?: (id: SessionId) => Promise<Inspection>;
    open?: (id: SessionId, access: 'read') => Promise<ReadHandle>;
}, id: SessionId): Promise<Inspection>;
export declare function persistedHeader(row: SessionHeader | {
    readonly header: SessionHeader;
}): SessionHeader;
export declare function sessionEvents(session: {
    snapshotEvents?: () => readonly SessionEvent[];
    events?: readonly SessionEvent[];
}): readonly SessionEvent[];
export {};
