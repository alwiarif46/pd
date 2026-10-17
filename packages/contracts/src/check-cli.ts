import { checkContracts } from './check.js';

const problems = checkContracts();
for (const p of problems) console.error(`${p.file}: ${p.message}`);
if (problems.length > 0) process.exit(1);
console.log('contracts ok');
