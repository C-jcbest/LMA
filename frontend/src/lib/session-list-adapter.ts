import type { RemoteThreadListAdapter } from '@assistant-ui/react';
import { createAssistantStream } from 'assistant-stream';
import type { LmaClient, Session } from '@/services/api';

const PAGE_SIZE = 20;

function threadMetadata(session: Session) {
  return {
    status: session.archived ? ('archived' as const) : ('regular' as const),
    remoteId: session.id,
    externalId: session.id,
    title: session.name.trim(),
    lastMessageAt: new Date(session.updated_at),
  };
}

export function createSessionListAdapter(client: LmaClient, stationUuid?: string): RemoteThreadListAdapter {
  return {
    async list(params) {
      const offset = params?.after === undefined ? 0 : Number(params.after);
      const sessions = await client.listSessions({ limit: PAGE_SIZE + 1, offset, ...(stationUuid ? { stationUuid } : {}) });
      return {
        threads: sessions.slice(0, PAGE_SIZE).map(threadMetadata),
        nextCursor: sessions.length > PAGE_SIZE ? String(offset + PAGE_SIZE) : undefined,
      };
    },
    async initialize() {
      const session = await client.createSession(stationUuid);
      return { remoteId: session.id, externalId: session.id };
    },
    async fetch(id) {
      return threadMetadata(await client.getSession(id));
    },
    async rename(id, title) {
      const name = title.trim();
      if (!name) return;
      await client.updateSession(id, { name });
    },
    async delete(id) {
      await client.deleteSession(id);
    },
    async archive(id) {
      await client.updateSession(id, { archived: true });
    },
    async unarchive(id) {
      await client.updateSession(id, { archived: false });
    },
    async generateTitle(id, messages) {
      return createAssistantStream(async (controller) => {
        const user = messages.find((message) => message.role === 'user');
        const text = user?.content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
          .trim();
        if (!text) return;
        try {
          const title = await client.generateTitle(text);
          await client.updateSession(id, { name: title });
          controller.appendText(title);
        } catch {
          console.warn('会话标题生成失败，保留服务端已确认的标题。');
        }
      });
    },
  };
}
