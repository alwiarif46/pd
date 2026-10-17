import { startService } from '@pd/service-kit';
import { SERVICE_ID, buildApp } from './app.js';

await startService({ id: SERVICE_ID, build: buildApp });
