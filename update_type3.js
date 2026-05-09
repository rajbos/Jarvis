const fs = require('fs');

// Read the file
let content = fs.readFileSync('src/plugins/types.ts', 'utf8');

// Replace the interface - handle both LF and CRLF
const oldInterface = 'export interface RuddrProjectMatch {\r\n  name: string;\r\n  score: number;\r\n}';
const newInterface = 'export interface RuddrProjectMatch {\r\n  name: string;\r\n  path: string;\r\n  score: number;\r\n}';

if (content.includes(oldInterface)) {
  content = content.replace(oldInterface, newInterface);
  fs.writeFileSync('src/plugins/types.ts', content, 'utf8');
  console.log('RuddrProjectMatch type updated');
} else {
  // Try with LF only
  const oldInterfaceLF = 'export interface RuddrProjectMatch {\n  name: string;\n  score: number;\n}';
  const newInterfaceLF = 'export interface RuddrProjectMatch {\n  name: string;\n  path: string;\n  score: number;\n}';
  if (content.includes(oldInterfaceLF)) {
    content = content.replace(oldInterfaceLF, newInterfaceLF);
    fs.writeFileSync('src/plugins/types.ts', content, 'utf8');
    console.log('RuddrProjectMatch type updated (LF)');
  } else {
    console.error('Could not find interface in either format');
  }
}
