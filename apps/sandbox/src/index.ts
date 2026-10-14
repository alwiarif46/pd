import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

const OCR_PAGE_LIMIT = 500;
const OCR_MIN_CHARS = 50;

type Encryption = 'none' | 'owner_password' | 'user_password';
type ExtractMethod = 'pdf_text' | 'ocr' | 'docx_pdf' | 'docx_text_fallback' | 'xlsx';

interface SandboxPage {
  pageNo: number;
  text: string;
  ocrUsed: boolean;
}

interface SandboxResult {
  success: boolean;
  error?: string;
  pages: SandboxPage[];
  metadata: {
    pageCount: number;
    hasTextLayer: boolean;
    encryption: Encryption;
    pagesEstimated: boolean;
    extractMethod: ExtractMethod;
  };
}

function writeResult(outputDir: string, result: SandboxResult): void {
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, 'result.json'), JSON.stringify(result, null, 2));
}

function fail(outputDir: string, error: string, encryption: Encryption = 'none'): never {
  writeResult(outputDir, {
    success: false,
    error,
    pages: [],
    metadata: {
      pageCount: 0,
      hasTextLayer: false,
      encryption,
      pagesEstimated: false,
      extractMethod: 'pdf_text',
    },
  });
  process.exit(0);
}

function run(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function encryptionOf(filePath: string): Encryption {
  const checked = run('qpdf', ['--requires-password', filePath]);
  if (checked.status === 0) {
    return 'user_password';
  }
  if (checked.status === 3) {
    return 'owner_password';
  }
  if (checked.status === 2) {
    return 'none';
  }
  throw new Error(`qpdf could not read encryption: ${checked.stderr || checked.stdout}`);
}

function pageCountOf(filePath: string): number {
  const info = run('pdfinfo', [filePath]);
  const match = info.stdout.match(/^Pages:\s+(\d+)/m);
  if (!match) {
    throw new Error(`pdfinfo did not report a page count: ${info.stderr}`);
  }
  return Number(match[1]);
}

function textOnPage(filePath: string, pageNo: number): string {
  const extracted = run('pdftotext', ['-layout', '-f', String(pageNo), '-l', String(pageNo), filePath, '-']);
  if (extracted.status !== 0) {
    throw new Error(`pdftotext failed on page ${pageNo}: ${extracted.stderr}`);
  }
  return extracted.stdout;
}

function ocrPages(filePath: string, pages: number[], workDir: string): string {
  const outputPdf = join(workDir, 'ocr.pdf');
  const listed = pages.join(',');
  const ocr = run('ocrmypdf', ['--jobs', '2', '--pages', listed, '--skip-text', filePath, outputPdf]);
  if (ocr.status !== 0) {
    throw new Error(`ocrmypdf failed: ${ocr.stderr}`);
  }
  return outputPdf;
}

function extractPdf(filePath: string, outputDir: string, method: ExtractMethod): SandboxResult {
  const encryption = encryptionOf(filePath);
  if (encryption === 'user_password') {
    fail(outputDir, 'This PDF needs a password to open. Upload an unlocked copy.', encryption);
  }

  let source = filePath;
  if (encryption === 'owner_password') {
    source = join(outputDir, 'unlocked.pdf');
    const decrypted = run('qpdf', ['--password=', '--decrypt', filePath, source]);
    if (decrypted.status !== 0) {
      fail(outputDir, `Could not open an owner-password PDF: ${decrypted.stderr}`, encryption);
    }
  }

  const pageCount = pageCountOf(source);
  const pages: SandboxPage[] = [];
  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    pages.push({ pageNo, text: textOnPage(source, pageNo), ocrUsed: false });
  }

  const needsOcr = pages.filter((page) => page.text.trim().length < OCR_MIN_CHARS).map((page) => page.pageNo);
  if (needsOcr.length > 0 && pageCount > OCR_PAGE_LIMIT) {
    fail(outputDir, `This file has ${pageCount} pages. OCR is refused above ${OCR_PAGE_LIMIT} pages.`, encryption);
  }

  let extractMethod = method;
  if (needsOcr.length > 0) {
    const ocrPdf = ocrPages(source, needsOcr, outputDir);
    for (const pageNo of needsOcr) {
      const page = pages[pageNo - 1];
      page.text = textOnPage(ocrPdf, pageNo);
      page.ocrUsed = true;
    }
    extractMethod = 'ocr';
  }

  const hasTextLayer = pages.some((page) => page.text.trim().length >= OCR_MIN_CHARS && !page.ocrUsed);
  return {
    success: true,
    pages,
    metadata: {
      pageCount,
      hasTextLayer,
      encryption,
      pagesEstimated: false,
      extractMethod,
    },
  };
}

async function extractDocx(filePath: string, outputDir: string): Promise<SandboxResult> {
  const converted = run('soffice', [
    '--headless',
    '--convert-to',
    'pdf',
    '--outdir',
    outputDir,
    filePath,
  ]);
  const pdfName = `${basename(filePath, extname(filePath))}.pdf`;
  const pdfPath = join(outputDir, pdfName);
  if (converted.status === 0) {
    return extractPdf(pdfPath, outputDir, 'docx_pdf');
  }

  const extracted = await mammoth.extractRawText({ path: filePath });
  return {
    success: true,
    pages: [{ pageNo: 1, text: extracted.value, ocrUsed: false }],
    metadata: {
      pageCount: 1,
      hasTextLayer: true,
      encryption: 'none',
      pagesEstimated: true,
      extractMethod: 'docx_text_fallback',
    },
  };
}

function extractXlsx(filePath: string): SandboxResult {
  const book = XLSX.read(readFileSync(filePath), { type: 'buffer' });
  const pages = book.SheetNames.map((name, index) => ({
    pageNo: index + 1,
    text: XLSX.utils.sheet_to_csv(book.Sheets[name]),
    ocrUsed: false,
  }));
  return {
    success: true,
    pages,
    metadata: {
      pageCount: pages.length,
      hasTextLayer: true,
      encryption: 'none',
      pagesEstimated: false,
      extractMethod: 'xlsx',
    },
  };
}

const inputFile = process.argv[2];
const outputDir = process.argv[3];

if (!inputFile || !outputDir) {
  console.error('Usage: node dist/index.js <input-file> <output-dir>');
  process.exit(1);
}

const extension = extname(inputFile).toLowerCase();

try {
  let result: SandboxResult;
  if (extension === '.docx') {
    result = await extractDocx(inputFile, outputDir);
  } else if (extension === '.xlsx') {
    result = extractXlsx(inputFile);
  } else if (extension === '.pdf') {
    result = extractPdf(inputFile, outputDir, 'pdf_text');
  } else {
    fail(outputDir, `Unsupported file type: ${extension || 'unknown'}`);
  }
  writeResult(outputDir, result);
} catch (error) {
  const message = error instanceof Error ? error.message : 'Sandbox processing failed';
  fail(outputDir, message);
}
