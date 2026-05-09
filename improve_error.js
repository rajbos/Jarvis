const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Find and update the groups:create handler to improve error message
const oldHandler = `  ipcMain.handle('groups:create', (_event, name: string) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'Name is required' };
    }
    try {
      const id = createGroup(db, name.trim());
      saveDatabase();
      return { ok: true, id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  });`;

const newHandler = `  ipcMain.handle('groups:create', (_event, name: string) => {
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: 'Name is required' };
    }
    try {
      const id = createGroup(db, name.trim());
      saveDatabase();
      return { ok: true, id };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Improve error message for UNIQUE constraint
      if (msg.includes('UNIQUE constraint failed') && msg.includes('groups.name')) {
        return { ok: false, error: 'A group with this name already exists. Please use a different name.' };
      }
      return { ok: false, error: msg };
    }
  });`;

if (content.includes(oldHandler)) {
  content = content.replace(oldHandler, newHandler);
  fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
  console.log('Error handling improved for groups:create');
} else {
  console.error('Could not find handler');
}
