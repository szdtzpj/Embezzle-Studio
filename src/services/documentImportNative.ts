import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativeOcrScript = 'Latin' | 'Chinese';

export interface NativePdfPageText {
  pageNumber: number;
  text: string;
}

export interface NativePdfTextResult {
  pageCount: number;
  pages: NativePdfPageText[];
  hasTextLayer: boolean;
  warnings?: string[];
}

export interface NativePdfRenderedPage {
  uri: string;
  width: number;
  height: number;
}

export interface NativeOcrBlock {
  text: string;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
}

export interface NativeOcrResult {
  text: string;
  blocks?: NativeOcrBlock[];
}

export interface DocumentImportNativeModule {
  readonly isPdfSupported?: boolean;
  readonly isOcrSupported?: boolean;
  extractPdfText?: (
    uri: string,
    options?: { maxPages?: number; maxCharacters?: number }
  ) => Promise<NativePdfTextResult>;
  renderPdfPage?: (
    uri: string,
    pageNumber: number,
    dpi?: number
  ) => Promise<NativePdfRenderedPage>;
  recognizeImageText?: (
    uri: string,
    script?: NativeOcrScript
  ) => Promise<NativeOcrResult>;
}

/**
 * Optional on purpose: Web, Expo Go, iOS builds without the local module, and
 * old installed versions must degrade to an explicit provider-OCR choice
 * instead of crashing or silently sending an image to a service.
 */
export function getDocumentImportNativeModule(): DocumentImportNativeModule | null {
  if (Platform.OS === 'web') return null;
  try {
    return requireOptionalNativeModule<DocumentImportNativeModule>('EmbezzleDocumentImport');
  } catch {
    return null;
  }
}
