// Worker-thread entry for local-session-usage.ts. The session parser loads the
// Copilot CLI's session-store.db (90+ MB, rewritten by the CLI all the time) into
// sql.js whenever its mtime changes, which blocks whichever thread runs it for
// seconds. Running it here keeps that off Electron's main thread.
import { parentPort } from 'worker_threads';

interface Request {
  id: number;
  filePath: string;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports -- see local-session-usage.ts: node10 resolution can't see the package's exports subpath
const lib = require('@rajbos/ai-engineering-fluency/session') as {
  analyzeSessionFile: (filePath: string) => Promise<unknown>;
};

parentPort?.on('message', (msg: Request) => {
  lib.analyzeSessionFile(msg.filePath).then(
    (usage) => parentPort?.postMessage({ id: msg.id, usage }),
    (err: unknown) => parentPort?.postMessage({ id: msg.id, error: err instanceof Error ? err.message : String(err) }),
  );
});
