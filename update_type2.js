const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/types.ts', 'utf8');

// Split by lines and find the interface
const lines = content.split('\n');
let inInterface = false;
let interfaceStart = -1;

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('export interface RuddrProjectMatch')) {
    interfaceStart = i;
    inInterface = true;
  } else if (inInterface && lines[i] === '}') {
    // Found the end of the interface
    // Insert path field before score
    if (lines[i-1].includes('score:')) {
      lines.splice(i, 0, '  path: string;');
      content = lines.join('\n');
      fs.writeFileSync('src/plugins/types.ts', content, 'utf8');
      console.log('RuddrProjectMatch type updated with path field');
      process.exit(0);
    }
    inInterface = false;
  }
}

console.error('Could not update interface');
