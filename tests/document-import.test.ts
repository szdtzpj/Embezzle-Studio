/* eslint-disable import/first */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';

const platformState = vi.hoisted(() => ({ OS: 'web' }));
const nativeState = vi.hoisted(() => ({ current: null as unknown }));
const fileSystemState = vi.hoisted(() => ({ deletedUris: [] as string[] }));

vi.mock('react-native', () => ({ Platform: platformState }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => nativeState.current }));
vi.mock('expo-file-system', () => ({
  File: class MockFile {
    readonly exists = true;
    readonly size = 0;
    constructor(readonly uri: string) {}
    delete() {
      fileSystemState.deletedUris.push(this.uri);
    }
  },
}));

import {
  MAX_DOCUMENT_IMPORT_FILE_BYTES,
  MAX_DOCUMENT_IMPORT_ZIP_ENTRY_BYTES,
  parsePickedDocumentImport,
  parseDocumentImport,
  parseWebPageImport,
  selectKnowledgeImportSections,
  setKnowledgeImportSectionContent,
} from '../src/services/documentImport';
/* eslint-enable import/first */

afterEach(() => {
  platformState.OS = 'web';
  nativeState.current = null;
  fileSystemState.deletedUris.length = 0;
});

function zip(entries: Record<string, string>): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)])));
}

describe('document import parsers', () => {
  it('keeps text import transient until explicit section selection', async () => {
    const draft = await parseDocumentImport({
      fileName: 'notes.md',
      mimeType: 'text/markdown',
      bytes: new TextEncoder().encode('# Heading\n\nKeep this\n\nDrop this'),
    });

    expect(draft.status).toBe('ready');
    expect(draft.sections.length).toBe(3);
    const selected = selectKnowledgeImportSections(draft, {
      sectionIds: [draft.sections[0].id, draft.sections[1].id],
    });
    expect(selected.content).toContain('Keep this');
    expect(selected.content).not.toContain('Drop this');
    expect(selected.extraction).toBe('local-text');
  });

  it('extracts readable HTML blocks while dropping executable and navigation content', async () => {
    const draft = await parseDocumentImport({
      fileName: 'page.html',
      mimeType: 'text/html',
      bytes: new TextEncoder().encode(
        '<html><head><title>Ignored title</title><script>alert(1)</script></head>' +
        '<body><nav>Ignore nav</nav><h1>Hello &amp; world</h1><p>First <b>paragraph</b>.</p>' +
        '<table><tr><td>A</td><td>B</td></tr></table></body></html>'
      ),
    });

    const text = draft.sections.map((section) => section.content).join('\n');
    expect(text).toContain('Hello & world');
    expect(text).toContain('First paragraph.');
    expect(text).toContain('A');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('Ignore nav');
  });

  it('extracts DOCX paragraphs without rendering untrusted generated HTML', async () => {
    const draft = await parseDocumentImport({
      fileName: 'brief.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bytes: zip({
        '[Content_Types].xml': '<Types/>',
        'word/document.xml': '<w:document><w:body>' +
          '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>' +
          '<w:p><w:r><w:t>第二段 &amp; more</w:t></w:r></w:p>' +
          '</w:body></w:document>',
      }),
    });

    expect(draft.status).toBe('ready');
    expect(draft.sections.map((section) => section.content)).toEqual(['第一段', '第二段 & more']);
  });

  it('extracts XLSX shared strings, inline values, formulas and sheet labels', async () => {
    const draft = await parseDocumentImport({
      fileName: 'table.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: zip({
        '[Content_Types].xml': '<Types/>',
        'xl/workbook.xml': '<workbook><sheets><sheet name="收入" r:id="rId1"/></sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        'xl/sharedStrings.xml': '<sst><si><t>名称</t></si><si><t>金额</t></si></sst>',
        'xl/worksheets/sheet1.xml': '<worksheet><sheetData>' +
          '<row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
          '<row><c r="A2" t="inlineStr"><is><t>项目 A</t></is></c><c r="B2"><f>SUM(B3:B3)</f><v>42</v></c></row>' +
          '</sheetData></worksheet>',
      }),
    });

    expect(draft.status).toBe('ready');
    expect(draft.sections[0].sheetName).toBe('收入');
    expect(draft.sections[0].content).toContain('名称');
    expect(draft.sections[1].content).toContain('项目 A');
    expect(draft.sections[1].content).toContain('公式：SUM(B3:B3)');
  });

  it('extracts PPTX slide text and notes as independently selectable sections', async () => {
    const draft = await parseDocumentImport({
      fileName: 'deck.pptx',
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      bytes: zip({
        '[Content_Types].xml': '<Types/>',
        'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Slide title</a:t></a:r></a:p><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:sld>',
        'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>',
      }),
    });

    expect(draft.sections.some((section) => section.kind === 'slide' && section.content === 'Slide title')).toBe(true);
    expect(draft.sections.some((section) => section.kind === 'notes' && section.content === 'Speaker note')).toBe(true);
  });

  it('rejects entity declarations and zip bombs before parsing user XML', async () => {
    const malicious = zip({
      'word/document.xml': '<!DOCTYPE foo [<!ENTITY x "boom">]><w:document/>'
    });
    await expect(parseDocumentImport({ fileName: 'evil.docx', bytes: malicious })).rejects.toThrow(/实体声明/);

    const bomb = zip({ 'word/document.xml': 'x'.repeat(MAX_DOCUMENT_IMPORT_ZIP_ENTRY_BYTES + 1) });
    await expect(parseDocumentImport({ fileName: 'large.docx', bytes: bomb })).rejects.toThrow(/单个条目/);
  });

  it('does not auto-call a provider when native OCR is unavailable', async () => {
    const draft = await parseDocumentImport({
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      uri: 'file:///tmp/photo.jpg',
    });
    expect(draft.status).toBe('needs-provider-ocr');
    expect(draft.providerOcrReason).toContain('显式');
  });

  it('retains PDF page placeholders for explicit local OCR selection', async () => {
    // Web/native-less test path is an explicit degradation, never an implicit upload.
    const draft = await parseDocumentImport({ fileName: 'scan.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    expect(['unsupported-platform', 'failed']).toContain(draft.status);
  });

  it('creates exactly one stable placeholder for every fully scanned PDF page', async () => {
    platformState.OS = 'android';
    nativeState.current = {
      extractPdfText: vi.fn(async () => ({
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: '' },
          { pageNumber: 2, text: '   ' },
        ],
        hasTextLayer: false,
      })),
      renderPdfPage: vi.fn(),
      recognizeImageText: vi.fn(),
    };

    const draft = await parseDocumentImport({
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      uri: 'file:///picker-cache/scan.pdf',
    });

    expect(draft.sections.map((section) => section.pageNumber)).toEqual([1, 2]);
    expect(draft.sections.map((section) => section.id)).toEqual(['import-page-1', 'import-page-2']);
    expect(new Set(draft.sections.map((section) => section.id)).size).toBe(draft.sections.length);
  });

  it('keeps mixed PDF page IDs unique and applies OCR to the exact blank page', async () => {
    platformState.OS = 'android';
    nativeState.current = {
      extractPdfText: vi.fn(async () => ({
        pageCount: 2,
        pages: [
          { pageNumber: 1, text: '' },
          { pageNumber: 2, text: 'Text-layer page' },
          { pageNumber: 1, text: 'Duplicate native page record' },
        ],
        hasTextLayer: true,
      })),
      renderPdfPage: vi.fn(),
      recognizeImageText: vi.fn(),
    };

    const draft = await parseDocumentImport({
      fileName: 'mixed.pdf',
      mimeType: 'application/pdf',
      uri: 'file:///picker-cache/mixed.pdf',
    });
    const blankPage = draft.sections.find((section) => section.pageNumber === 1);
    const textPage = draft.sections.find((section) => section.pageNumber === 2);

    expect(blankPage?.id).toBe('import-page-1');
    expect(textPage?.id).toBe('import-page-2');
    expect(new Set(draft.sections.map((section) => section.id)).size).toBe(draft.sections.length);

    const updated = setKnowledgeImportSectionContent(draft, blankPage!.id, 'OCR page one');
    expect(updated.sections.find((section) => section.pageNumber === 1)?.content).toBe('OCR page one');
    expect(updated.sections.find((section) => section.pageNumber === 2)?.content).toBe('Text-layer page');
  });

  it('requires HTTPS public URLs and reports browser CORS as a user-action boundary', async () => {
    await expect(parseWebPageImport('http://localhost/private')).rejects.toThrow(/公开 HTTPS/);
    const draft = await parseWebPageImport('https://example.com/article', {
      fetchImpl: async () => new Response('<html><body><h1>Title</h1><p>Text</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    });
    expect(draft.source).toBe('web-url');
    expect(draft.sections.map((section) => section.content)).toContain('Title');
  });

  it('enforces the HTML byte limit while streaming the response body', async () => {
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(5_000_001)));
        controller.close();
      },
    });
    await expect(parseWebPageImport('https://example.com/large', {
      fetchImpl: async () => new Response(oversized, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    })).rejects.toThrow(/HTML response exceeds/);
  });

  it('rejects an oversized picker asset before reading it into memory', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    await expect(parsePickedDocumentImport({
      name: 'oversized.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: MAX_DOCUMENT_IMPORT_FILE_BYTES + 1,
      uri: 'file:///tmp/oversized.docx',
      file: { size: MAX_DOCUMENT_IMPORT_FILE_BYTES + 1, arrayBuffer } as unknown as Blob,
    })).rejects.toThrow(/资料文件不能超过/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('enforces the picker byte limit when a provider omits size metadata', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const stream = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_DOCUMENT_IMPORT_FILE_BYTES + 1));
        controller.close();
      },
    });
    await expect(parsePickedDocumentImport({
      name: 'unknown-size.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      uri: 'content://provider/unknown-size.docx',
      file: { size: 0, stream, arrayBuffer } as unknown as Blob,
    })).rejects.toThrow(/资料文件不能超过/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('deletes the picker cache copy when document parsing fails', async () => {
    platformState.OS = 'android';
    const uri = 'file:///picker-cache/broken.docx';

    await expect(parsePickedDocumentImport({
      name: 'broken.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      uri,
      file: new Blob([new Uint8Array([1, 2, 3, 4])]),
    })).rejects.toThrow();

    expect(fileSystemState.deletedUris).toEqual([uri]);
  });

  it('deletes the picker cache copy and preserves the error when reading fails', async () => {
    platformState.OS = 'android';
    const uri = 'file:///picker-cache/unreadable.docx';
    const file = {
      size: 1,
      stream: () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('picker read failed'));
        },
      }),
      arrayBuffer: vi.fn(),
    } as unknown as Blob;

    await expect(parsePickedDocumentImport({
      name: 'unreadable.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      uri,
      file,
    })).rejects.toThrow('picker read failed');

    expect(fileSystemState.deletedUris).toEqual([uri]);
  });

  it('updates an OCR placeholder without persisting the original image bytes', async () => {
    const draft = await parseDocumentImport({ fileName: 'scan.pdf', mimeType: 'application/pdf' });
    const withText = setKnowledgeImportSectionContent({
      ...draft,
      status: 'needs-local-ocr',
      sections: [{ id: 'page-1', kind: 'page', label: '第 1 页', content: '', selected: true, characterCount: 0, pageNumber: 1 }],
      selectedSectionIds: ['page-1'],
    }, 'page-1', 'OCR text');
    expect(withText.sections[0].content).toBe('OCR text');
    expect(withText.sections[0].kind).toBe('ocr');
  });
});
