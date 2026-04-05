type DocumentKind = 'pdf' | 'xlsx' | 'text' | 'email' | 'unsupported';

export const SUPPORTED_DOCUMENT_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv', '.txt', '.md', '.eml'] as const;

export function detectDocumentKind(filename: string): DocumentKind {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  if (lower.endsWith('.eml')) return 'email';
  if (lower.endsWith('.txt') || lower.endsWith('.csv') || lower.endsWith('.md')) return 'text';
  return 'unsupported';
}

export async function extractDocumentText(filename: string, buffer: Buffer): Promise<string> {
  const kind = detectDocumentKind(filename);

  if (kind === 'pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const parsed = await pdfParse(buffer);
    return ensureReadableText(String(parsed.text ?? ''), filename, 'document');
  }

  if (kind === 'xlsx') {
    const XLSX = await import('xlsx');
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const parts: string[] = [];

    for (const sheetName of workbook.SheetNames ?? []) {
      const worksheet = workbook.Sheets[sheetName];
      if (!worksheet) continue;
      const csv = XLSX.utils.sheet_to_csv(worksheet, { blankrows: false });
      const compact = csv.trim();
      if (compact) parts.push(`# ${sheetName}\n${compact}`);
    }

    return ensureReadableText(parts.join('\n\n'), filename, 'spreadsheet');
  }

  if (kind === 'text') {
    return ensureReadableText(buffer.toString('utf8'), filename, 'document');
  }

  if (kind === 'email') {
    const raw = buffer.toString('utf8');
    const boundaryMatch = raw.match(/\r?\n\r?\n/);
    const boundaryIndex = boundaryMatch?.index ?? -1;
    const headerBlock = boundaryIndex >= 0 ? raw.slice(0, boundaryIndex) : '';
    const body = boundaryIndex >= 0 ? raw.slice(boundaryIndex + boundaryMatch![0].length) : raw;
    const subject = (headerBlock.match(/^Subject:\s*(.*)$/im)?.[1] ?? '').trim();
    const from = (headerBlock.match(/^From:\s*(.*)$/im)?.[1] ?? '').trim();
    const cleanedBody = body
      .split(/\r?\n/)
      .filter(line => !/^>/.test(line))
      .join('\n')
      .trim();
    const parts = [subject ? `Subject: ${subject}` : '', from ? `From: ${from}` : '', cleanedBody].filter(Boolean);
    return ensureReadableText(parts.join('\n\n'), filename, 'email');
  }

  throw new Error(
    `Unsupported document format for "${filename}". Supported formats are PDF, XLSX, XLS, CSV, TXT, Markdown, and EML.`,
  );
}

function ensureReadableText(text: string, filename: string, kindLabel: string): string {
  const normalized = (text || '').trim();
  if (!normalized) {
    throw new Error(`The ${kindLabel} "${filename}" does not contain any readable text.`);
  }
  return normalized;
}
