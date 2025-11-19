
export interface Segment {
  id: string;
  type: 'text' | 'image';
  tagName: string; // p, h1, h2, div, img, etc.
  originalText: string; // Text content for text segments, alt text for images
  imageUrl?: string;    // Blob URL for images
  translatedText?: string;
  isLoading: boolean;
}

export interface BookMetadata {
  title: string;
  creator: string;
  language: string;
}

export interface ChapterRef {
  id: string;
  href: string;
  title: string;
  order: number;
}

export interface TocItem {
  label: string;
  href: string;
  subitems: TocItem[];
}

export interface ParsedBook {
  metadata: BookMetadata;
  coverUrl?: string;
  chapters: ChapterRef[];
  toc: TocItem[]; // Hierarchical Table of Contents
}

export interface LibraryBook {
  id: string;
  title: string;
  author: string;
  cover?: Blob;
  addedAt: number;
}

export enum TargetLanguage {
  SPANISH = 'Spanish',
  FRENCH = 'French',
  GERMAN = 'German',
  CHINESE = 'Chinese (Simplified)',
  JAPANESE = 'Japanese',
  KOREAN = 'Korean',
  ITALIAN = 'Italian',
  PORTUGUESE = 'Portuguese',
  RUSSIAN = 'Russian',
  HINDI = 'Hindi'
}

export type AIProvider = 'gemini' | 'openai';

export interface AISettings {
  provider: AIProvider;
  apiKey: string; // For OpenAI / Custom
  baseUrl: string; // For OpenAI / Custom
  model: string;
}

// Gemini API Types
export interface TranslationRequest {
  texts: string[];
  targetLanguage: string;
}
