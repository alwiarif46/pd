#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Sandbox entry point - processes a single file
// This runs in a container with no network and no secrets

const inputFile = process.argv[2];
const outputDir = process.argv[3];

if (!inputFile || !outputDir) {
  console.error('Usage: node dist/index.js <input-file> <output-dir>');
  process.exit(1);
}

console.log('Sandbox processing:', inputFile);

// TODO: Implement file processing:
// 1. Check encryption type (qpdf)
// 2. Check page count (pdfinfo)
// 3. Convert DOCX to PDF (LibreOffice headless)
// 4. Extract text per page (pdftotext)
// 5. OCR pages with no text layer (OCRmyPDF --jobs 2)
// 6. Output JSON with page text and page images

// Placeholder output
const result = {
  success: true,
  pages: [],
  metadata: {
    pageCount: 0,
    hasTextLayer: false,
  },
};

const outputFile = join(outputDir, 'result.json');
writeFileSync(outputFile, JSON.stringify(result, null, 2));

console.log('Sandbox complete');
