import type { Client } from 'pg';

/** Reconnect the dedicated PostgreSQL LISTEN client and notify consumers of each gap. */
export async function listenForNotifications(
  createListener: () => Client, channel: string,
  callbacks: {connected(): void; disconnected(): void; message(payload: string | undefined): void},
): Promise<() => void> {
  let current: Client | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const disconnect = () => {
    callbacks.disconnected();
  };

  function scheduleReconnect() {
    reconnect = setTimeout(() => {
      void listen().catch(scheduleReconnect);
    }, 1000);
    reconnect.unref();
  }

  async function listen() {
    if (stopped) return;
    const client = createListener();
    current = client;
    const lost = () => {
      if (current !== client) return;
      current = undefined;
      void client.end().catch(() => {});
      disconnect();
      if (!stopped) scheduleReconnect();
    };
    client.on('error', lost);
    client.once('end', lost);
    client.on('notification', ({ channel: received, payload }) => {
      if (received !== channel) return;
      callbacks.message(payload);
    });
    try {
      await client.connect();
      if (current !== client) return;
      // Quoting permits the identifier while escaping any quote defensively.
      await client.query('LISTEN "' + channel.replaceAll('"', '""') + '"');
    } catch (error) {
      if (current === client) {
        current = undefined;
        void client.end().catch(() => {});
        throw error;
      }
    }
    if (current === client) callbacks.connected();
  }

  await listen();
  return () => {
    stopped = true;
    clearTimeout(reconnect);
    disconnect();
    const client = current;
    current = undefined;
    void client?.end().catch(() => {});
  };
}
