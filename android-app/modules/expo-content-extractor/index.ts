import { requireNativeModule } from 'expo-modules-core';

export type ExtractedPdfPage = {
  page: number;
  text: string;
};

type ExpoContentExtractorModule = {
  inspectPdfAsync(uri:string,token:string):Promise<ExtractedPdfPage[]>;
  cancelDocumentTask(token:string):void;
  renderPdfPageAsync(uri:string,page:number,width:number):Promise<{uri:string;width:number;height:number;pages:number}>;
  sanitizeDocumentHtmlAsync(html:string,aliases:Record<string,string>):Promise<string>;
  extractPdfPagesAsync(uri: string): Promise<ExtractedPdfPage[]>;
  recognizeImageTextAsync(uri: string): Promise<string>;
};

export default requireNativeModule<ExpoContentExtractorModule>('ExpoContentExtractor');
