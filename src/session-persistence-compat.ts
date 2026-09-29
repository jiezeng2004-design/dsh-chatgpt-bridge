import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionHandleReadResult } from '@deepseek-ai/dsh-session-persistence';

type Inspection = { meta: SessionHeader; events: readonly SessionEvent[] };
type ReadHandle = {
  header: SessionHeader;
  read(): Promise<SessionHandleReadResult | readonly SessionEvent[]>;
  close(): Promise<void>;
};

/** Read current lifecycle-owned handles, retaining older read-only adapters. */
export async function inspectPersistedSession(persistence: {
  inspect?: (id: SessionId) => Promise<Inspection>;
  open?: (id: SessionId, access: 'read') => Promise<ReadHandle>;
}, id: SessionId): Promise<Inspection> {
  if (typeof persistence.open === 'function') {
    const handle = await persistence.open(id, 'read');
    try {
      const result = await handle.read();
      // V3 returns ownership metadata alongside the event slice. Never pass
      // the envelope to consumers expecting an event log, or acquire a writer.
      const events = 'events' in result ? result.events : result;
      if (!Array.isArray(events)) throw new Error('Unsupported DSH session read result');
      return { meta: handle.header, events };
    } finally {
      await handle.close();
    }
  }
  if (typeof persistence.inspect === 'function') return persistence.inspect(id);
  throw new Error('Unsupported DSH session persistence API');
}

export function persistedHeader(row: SessionHeader | { readonly header: SessionHeader }): SessionHeader {
  return 'header' in row ? row.header : row;
}

export function sessionEvents(session: {
  snapshotEvents?: () => readonly SessionEvent[];
  events?: readonly SessionEvent[];
}): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents();
  if (session.events !== undefined) return session.events;
  throw new Error('Unsupported DSH session event API');
}
