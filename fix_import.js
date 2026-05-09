const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/groups/handler.ts', 'utf8');

// Update the import to include parseRuddrPaths
const oldImport = `  parseRuddrNames,
} from '../../services/groups';`;
const newImport = `  parseRuddrNames,
  parseRuddrPaths,
} from '../../services/groups';`;

content = content.replace(oldImport, newImport);
fs.writeFileSync('src/plugins/groups/handler.ts', content, 'utf8');
console.log('parseRuddrPaths added to import');
