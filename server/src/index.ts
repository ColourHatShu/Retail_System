import 'dotenv/config';
import { createApp } from './app';
import { closePool, initDatabase } from './db';

const PORT = Number(process.env.PORT) || 5000;

async function main(): Promise<void> {
  await initDatabase();

  const server = createApp().listen(PORT, () => {
    console.log(`[Retail POS Server] running on http://localhost:${PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[Retail POS Server] ${signal} received, shutting down`);
    server.close(() => {
      closePool().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: Error) => {
  console.error('[Retail POS Server] failed to start:', err.message);
  process.exit(1);
});
