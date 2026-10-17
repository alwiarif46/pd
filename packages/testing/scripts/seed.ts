import { runSeedCli } from '../src/seed-cli.js';

process.exitCode = await runSeedCli(process.argv.slice(2), process.env, (line) => console.log(line));
