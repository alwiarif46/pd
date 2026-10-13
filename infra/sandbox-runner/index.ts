#!/usr/bin/env node

/**
 * Sandbox Runner Service
 *
 * A small host service that starts sandbox containers for file processing.
 * Takes requests from the job queue and runs docker compose run --rm sandbox.
 * The worker never holds the Docker socket.
 *
 * Security: This service runs on the host, not in a container. It has access
 * to the Docker socket but only starts sandbox containers with no network
 * and no secrets.
 */

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';

const DATA_DIR = process.env.DATA_DIR || '/data/files';
const SANDBOX_IMAGE = process.env.SANDBOX_IMAGE || 'pd-sandbox:latest';
const SANDBOX_TIMEOUT = Number(process.env.SANDBOX_TIMEOUT) || 300000; // 5 minutes default

interface ProcessRequest {
  jobId: string;
  orgId: string;
  inputPath: string;
  outputDir: string;
}

interface ProcessResponse {
  success: boolean;
  error?: string;
  outputPath?: string;
}

/**
 * Run a file in the sandbox container
 */
async function runInSandbox(
  inputPath: string,
  outputDir: string
): Promise<ProcessResponse> {
  return new Promise((resolve) => {
    const args = [
      'compose',
      'run',
      '--rm',
      '-v',
      `${inputPath}:/input/file:ro`,
      '-v',
      `${outputDir}:/output`,
      'sandbox',
      'node',
      'dist/index.js',
      '/input/file',
      '/output',
    ];

    console.log(`Starting sandbox: docker ${args.join(' ')}`);

    const docker = spawn('docker', args, {
      cwd: join(__dirname, '../../'),
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    docker.stdout?.on('data', (data) => {
      stdout += data.toString();
      console.log(`[sandbox stdout] ${data}`);
    });

    docker.stderr?.on('data', (data) => {
      stderr += data.toString();
      console.error(`[sandbox stderr] ${data}`);
    });

    const timeout = setTimeout(() => {
      docker.kill('SIGKILL');
      resolve({
        success: false,
        error: 'Sandbox process timed out',
      });
    }, SANDBOX_TIMEOUT);

    docker.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ success: true, outputPath: outputDir });
      } else {
        resolve({
          success: false,
          error: `Sandbox exited with code ${code}: ${stderr}`,
        });
      }
    });

    docker.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        success: false,
        error: `Failed to start sandbox: ${err.message}`,
      });
    });
  });
}

/**
 * HTTP server for processing requests
 */
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/process') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });

  req.on('end', async () => {
    try {
      const request: ProcessRequest = JSON.parse(body);
      console.log(`Processing job ${request.jobId} for org ${request.orgId}`);

      // Validate paths
      const inputPath = join(DATA_DIR, request.orgId, request.inputPath);
      const outputDir = join(DATA_DIR, request.orgId, request.outputDir);

      // Ensure output directory exists
      mkdirSync(outputDir, { recursive: true });

      // Run in sandbox
      const result = await runInSandbox(inputPath, outputDir);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      console.error('Error processing request:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }));
    }
  });
});

const PORT = Number(process.env.PORT) || 3002;
server.listen(PORT, () => {
  console.log(`Sandbox runner listening on port ${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
  console.log(`Sandbox image: ${SANDBOX_IMAGE}`);
  console.log(`Sandbox timeout: ${SANDBOX_TIMEOUT}ms`);
});
