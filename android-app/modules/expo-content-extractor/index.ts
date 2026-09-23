import { requireNativeModule } from 'expo-modules-core';

export type ExtractedPdfPage = {
  page: number;
  text: string;
};

type ExpoContentExtractorModule = {
  extractPdfPagesAsync(uri: string): Promise<ExtractedPdfPage[]>;
  recognizeImageTextAsync(uri: string): Promise<string>;
};

export default requireNativeModule<ExpoContentExtractorModule>('ExpoContentExtractor');
