import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, Globe, Loader2, ArrowLeft, List, X, AlertCircle, Settings, Minus, Plus, Moon, Sun, Coffee } from 'lucide-react';
import { ParsedBook, Segment, TargetLanguage, TocItem } from '../types';
import { parseChapterContent } from '../services/epubParser';
import { translateSegmentsBatch } from '../services/geminiService';

interface ReaderViewProps {
  book: ParsedBook;
  onBack: () => void;
}

const BATCH_SIZE = 10; // Number of paragraphs to translate at once

// Settings Interfaces
interface ReaderSettings {
  fontSize: number;
  fontFamily: 'font-serif' | 'font-sans' | 'font-mono';
  theme: 'light' | 'sepia' | 'dark';
}

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'font-serif',
  theme: 'light',
};

export const ReaderView: React.FC<ReaderViewProps> = ({ book, onBack }) => {
  // Book State
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [targetLang, setTargetLang] = useState<TargetLanguage>(TargetLanguage.CHINESE);
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState(0);
  
  // Caching & Refs
  const chapterCache = useRef<Record<string, Segment[]>>({});
  const currentChapterRef = useRef<string>('');

  // UI State
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Settings State
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    const saved = localStorage.getItem('lingo-reader-settings');
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });

  const currentChapter = book.chapters[currentChapterIndex];

  // Sync current chapter ID to ref for race-condition checks
  useEffect(() => {
    if (currentChapter) {
      currentChapterRef.current = currentChapter.id;
    }
  }, [currentChapter]);

  // Persist Settings
  useEffect(() => {
    localStorage.setItem('lingo-reader-settings', JSON.stringify(settings));
  }, [settings]);

  // Load Chapter Content
  useEffect(() => {
    const loadChapter = async () => {
      if (!currentChapter) return;
      
      // 1. Check Cache
      if (chapterCache.current[currentChapter.href]) {
        setSegments(chapterCache.current[currentChapter.href]);
        setIsLoadingChapter(false);
        return;
      }

      // 2. Parse if not cached
      setIsLoadingChapter(true);
      setSegments([]);
      
      try {
        const extractedSegments = await parseChapterContent(book, currentChapter);
        setSegments(extractedSegments);
        // Cache the initial untranslated state
        chapterCache.current[currentChapter.href] = extractedSegments;
      } catch (e) {
        console.error("Failed to load chapter", e);
      } finally {
        setIsLoadingChapter(false);
      }
    };

    loadChapter();
  }, [currentChapter, book]);

  // Translation Logic
  const handleTranslate = useCallback(async () => {
    if (segments.length === 0) return;
    
    // Store the ID of the chapter we started translating
    const translationChapterId = currentChapter.id;

    setIsTranslating(true);
    setTranslationProgress(0);

    const segmentsToTranslate = segments.filter(s => s.type === 'text' && !s.translatedText);
    
    const totalBatches = Math.ceil(segmentsToTranslate.length / BATCH_SIZE);
    let completedBatches = 0;
    let currentSegments = [...segments];

    for (let i = 0; i < segmentsToTranslate.length; i += BATCH_SIZE) {
      // Safety Check: Stop if user switched chapters
      if (currentChapterRef.current !== translationChapterId) {
        break;
      }

      const batch = segmentsToTranslate.slice(i, i + BATCH_SIZE);
      const texts = batch.map(s => s.originalText);
      
      // Mark as loading in UI
      const batchIds = new Set(batch.map(b => b.id));
      setSegments(prev => prev.map(s => batchIds.has(s.id) ? { ...s, isLoading: true } : s));

      // Call API
      const translations = await translateSegmentsBatch(texts, targetLang);

      // Safety Check again after async call
      if (currentChapterRef.current !== translationChapterId) {
        break;
      }

      // Update segments with results
      currentSegments = currentSegments.map(s => {
        if (batchIds.has(s.id)) {
          const indexInBatch = batch.findIndex(b => b.id === s.id);
          return { 
            ...s, 
            translatedText: translations[indexInBatch], 
            isLoading: false 
          };
        }
        return s;
      });

      setSegments([...currentSegments]); 
      
      // Update Cache with new translations
      if (currentChapter) {
        chapterCache.current[currentChapter.href] = [...currentSegments];
      }

      completedBatches++;
      setTranslationProgress(Math.round((completedBatches / totalBatches) * 100));
    }

    setIsTranslating(false);
  }, [segments, targetLang, currentChapter]);

  // Navigation
  const nextChapter = useCallback(() => {
    if (currentChapterIndex < book.chapters.length - 1) {
      setCurrentChapterIndex(prev => prev + 1);
      window.scrollTo(0, 0);
    }
  }, [currentChapterIndex, book.chapters.length]);

  const prevChapter = useCallback(() => {
    if (currentChapterIndex > 0) {
      setCurrentChapterIndex(prev => prev - 1);
      window.scrollTo(0, 0);
    }
  }, [currentChapterIndex]);

  const handleTocNavigation = (href: string) => {
    const fileHref = href.split('#')[0];
    const chapterIndex = book.chapters.findIndex(c => c.href === fileHref || c.href.endsWith(fileHref));
    
    if (chapterIndex !== -1) {
      setCurrentChapterIndex(chapterIndex);
      setIsTocOpen(false);
      window.scrollTo(0, 0);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === 'ArrowRight') nextChapter();
      else if (e.key === 'ArrowLeft') prevChapter();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextChapter, prevChapter]);

  // --- Styling Helpers ---

  const getThemeColors = () => {
    switch (settings.theme) {
      case 'dark':
        return {
          bg: 'bg-slate-900',
          text: 'text-slate-300',
          headerBg: 'bg-slate-900 border-slate-800',
          border: 'border-slate-800',
          highlight: 'text-blue-400',
          secondaryText: 'text-slate-500',
          hover: 'hover:bg-slate-800'
        };
      case 'sepia':
        return {
          bg: 'bg-[#f4ecd8]',
          text: 'text-[#2c2218]', // Darker brown for better readability
          headerBg: 'bg-[#f4ecd8] border-[#e3dccb]',
          border: 'border-[#e3dccb]',
          highlight: 'text-[#8f6b4e]',
          secondaryText: 'text-[#786655]',
          hover: 'hover:bg-[#e8dec5]'
        };
      default: // light
        return {
          bg: 'bg-white',
          text: 'text-slate-800',
          headerBg: 'bg-white border-slate-200',
          border: 'border-slate-100',
          highlight: 'text-blue-600',
          secondaryText: 'text-slate-400',
          hover: 'hover:bg-slate-100'
        };
    }
  };

  const theme = getThemeColors();

  const getTagStyles = (tag: string) => {
    // Base styles without colors (colors handled by container)
    switch (tag) {
      case 'h1': return 'text-3xl font-bold mb-6 mt-8 leading-tight';
      case 'h2': return 'text-2xl font-bold mb-4 mt-6 leading-tight';
      case 'h3': return 'text-xl font-semibold mb-3 mt-4';
      case 'li': return 'list-disc ml-4 mb-2';
      case 'blockquote': return `border-l-4 pl-4 italic my-4 opacity-80 ${theme.border}`;
      default: return 'mb-4 leading-relaxed';
    }
  };

  const TocItemView: React.FC<{ item: TocItem, level?: number }> = ({ item, level = 0 }) => (
    <div className="w-full">
      <button 
        onClick={() => handleTocNavigation(item.href)}
        className={`w-full text-left px-4 py-2 text-sm transition-colors truncate ${theme.hover} ${level > 0 ? 'pl-' + (4 + level * 4) : ''}`}
        style={{ paddingLeft: `${1 + level}rem`, color: 'inherit' }}
        title={item.label}
      >
        {item.label}
      </button>
      {item.subitems.length > 0 && (
        <div>
          {item.subitems.map((sub, idx) => <TocItemView key={idx} item={sub} level={level + 1} />)}
        </div>
      )}
    </div>
  );

  return (
    <div className={`flex flex-col h-screen relative transition-colors duration-300 ${theme.bg} ${theme.text}`}>
      {/* Header Toolbar */}
      <header className={`sticky top-0 z-20 shadow-sm px-6 py-3 flex items-center justify-between transition-colors duration-300 ${theme.headerBg}`}>
        <div className="flex items-center gap-4">
          <button onClick={onBack} className={`p-2 rounded-full transition-colors ${theme.hover}`} title="Back">
            <ArrowLeft size={20} />
          </button>
          
          <button 
             onClick={() => setIsTocOpen(true)}
             className={`p-2 rounded-full transition-colors ${theme.hover}`}
             title="Table of Contents"
          >
             <List size={20} />
          </button>

          <div className="flex flex-col">
            <h1 className="font-semibold max-w-[150px] md:max-w-xs truncate text-sm md:text-base" title={book.metadata.title}>
              {book.metadata.title}
            </h1>
            <span className={`text-xs opacity-70`}>Chapter {currentChapterIndex + 1} of {book.chapters.length}</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Language Selector */}
          <div className={`hidden md:flex items-center gap-2 rounded-lg p-1 px-2 border ${theme.border}`}>
            <Globe size={14} className="opacity-60" />
            <select 
              value={targetLang} 
              onChange={(e) => setTargetLang(e.target.value as TargetLanguage)}
              className={`bg-transparent border-none text-sm focus:ring-0 py-1 pr-4 cursor-pointer outline-none ${theme.text}`}
              disabled={isTranslating}
            >
              {Object.values(TargetLanguage).map(lang => (
                <option key={lang} value={lang} className="text-slate-900 bg-white">{lang}</option>
              ))}
            </select>
          </div>
          
          {/* Settings Toggle */}
          <div className="relative">
            <button 
              onClick={() => setIsSettingsOpen(!isSettingsOpen)}
              className={`p-2 rounded-full transition-colors ${isSettingsOpen ? 'bg-blue-100 text-blue-600' : theme.hover}`}
              title="Appearance Settings"
            >
              <Settings size={20} />
            </button>

            {isSettingsOpen && (
              <>
              <div className="fixed inset-0 z-10" onClick={() => setIsSettingsOpen(false)} />
              <div className="absolute right-0 top-full mt-2 w-72 bg-white text-slate-800 rounded-xl shadow-xl border border-slate-200 p-4 z-20 animate-in fade-in zoom-in-95 duration-100">
                
                {/* Font Size */}
                <div className="mb-4">
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Font Size</label>
                  <div className="flex items-center justify-between bg-slate-100 rounded-lg p-1">
                    <button 
                      onClick={() => setSettings(s => ({ ...s, fontSize: Math.max(12, s.fontSize - 2) }))}
                      className="p-2 hover:bg-white rounded shadow-sm text-slate-600 disabled:opacity-50"
                      disabled={settings.fontSize <= 12}
                    >
                      <Minus size={16} />
                    </button>
                    <span className="font-medium text-sm w-12 text-center">{settings.fontSize}px</span>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, fontSize: Math.min(32, s.fontSize + 2) }))}
                      className="p-2 hover:bg-white rounded shadow-sm text-slate-600 disabled:opacity-50"
                      disabled={settings.fontSize >= 32}
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>

                {/* Font Family */}
                <div className="mb-4">
                   <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Typeface</label>
                   <div className="flex gap-2">
                      <button 
                        onClick={() => setSettings(s => ({ ...s, fontFamily: 'font-serif' }))}
                        className={`flex-1 py-2 text-sm font-serif border rounded-md transition-colors ${settings.fontFamily === 'font-serif' ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        Serif
                      </button>
                      <button 
                        onClick={() => setSettings(s => ({ ...s, fontFamily: 'font-sans' }))}
                        className={`flex-1 py-2 text-sm font-sans border rounded-md transition-colors ${settings.fontFamily === 'font-sans' ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        Sans
                      </button>
                      <button 
                        onClick={() => setSettings(s => ({ ...s, fontFamily: 'font-mono' }))}
                        className={`flex-1 py-2 text-sm font-mono border rounded-md transition-colors ${settings.fontFamily === 'font-mono' ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                      >
                        Mono
                      </button>
                   </div>
                </div>

                {/* Theme */}
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Theme</label>
                  <div className="flex gap-2">
                    <button 
                      onClick={() => setSettings(s => ({ ...s, theme: 'light' }))}
                      className={`flex-1 py-3 rounded-md border flex justify-center transition-all ${settings.theme === 'light' ? 'ring-2 ring-blue-500 border-transparent' : 'border-slate-200'}`}
                      style={{ backgroundColor: '#ffffff', color: '#333' }}
                      title="Light"
                    >
                      <Sun size={20} />
                    </button>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, theme: 'sepia' }))}
                      className={`flex-1 py-3 rounded-md border flex justify-center transition-all ${settings.theme === 'sepia' ? 'ring-2 ring-blue-500 border-transparent' : 'border-[#e3dccb]'}`}
                      style={{ backgroundColor: '#f4ecd8', color: '#5b4636' }}
                      title="Sepia"
                    >
                      <Coffee size={20} />
                    </button>
                    <button 
                      onClick={() => setSettings(s => ({ ...s, theme: 'dark' }))}
                      className={`flex-1 py-3 rounded-md border flex justify-center transition-all ${settings.theme === 'dark' ? 'ring-2 ring-blue-500 border-transparent' : 'border-slate-700'}`}
                      style={{ backgroundColor: '#1e293b', color: '#cbd5e1' }}
                      title="Dark"
                    >
                      <Moon size={20} />
                    </button>
                  </div>
                </div>

              </div>
              </>
            )}
          </div>

          {/* Translate Button */}
          <button 
            onClick={handleTranslate}
            disabled={isTranslating || segments.every(s => s.translatedText || s.type !== 'text')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all shadow-sm
              ${isTranslating 
                ? 'bg-slate-100 text-slate-400 cursor-not-allowed' 
                : 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-md active:scale-95'}
            `}
          >
            {isTranslating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span className="hidden md:inline">Translating</span> {translationProgress}%
              </>
            ) : (
              <>Translate <span className="hidden md:inline">Chapter</span></>
            )}
          </button>
        </div>
      </header>

      {/* Table of Contents Sidebar */}
      {isTocOpen && (
        <div className="fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={() => setIsTocOpen(false)} />
          <div className={`relative w-80 shadow-2xl flex flex-col h-full animate-in slide-in-from-left duration-200 ${theme.bg} ${theme.text}`}>
            <div className={`p-4 border-b flex items-center justify-between ${theme.border}`}>
              <h2 className="font-semibold flex items-center gap-2">
                <List size={18} /> Table of Contents
              </h2>
              <button onClick={() => setIsTocOpen(false)} className={`p-1 rounded ${theme.hover}`}>
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto py-2">
               {book.toc.length > 0 ? (
                 book.toc.map((item, idx) => <TocItemView key={idx} item={item} />)
               ) : (
                 <div className="p-4 opacity-50 text-sm text-center">
                   No Table of Contents found.<br/>
                   Please use the arrow buttons to navigate.
                 </div>
               )}
            </div>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-[1600px] mx-auto p-6 md:p-10">
          {isLoadingChapter ? (
            <div className="flex flex-col items-center justify-center h-64 opacity-50">
              <Loader2 className="w-10 h-10 animate-spin mb-4" />
              <p>Loading chapter content...</p>
            </div>
          ) : segments.length === 0 ? (
             <div className="flex flex-col items-center justify-center h-64 opacity-50">
                <AlertCircle className="w-12 h-12 mb-4 opacity-50" />
                <p className="text-lg font-medium">No content found in this chapter.</p>
                <p className="text-sm mt-2 max-w-md text-center">
                  This page might be empty or contain formatting that is not yet supported.
                </p>
             </div>
          ) : (
            <div className="space-y-8">
               {/* Content Rows */}
               {segments.map((segment) => (
                 <div key={segment.id} className="flex group min-h-[2rem]">
                   {/* Original Text Side */}
                   <div className="w-1/2 pr-6">
                     {segment.type === 'image' && segment.imageUrl ? (
                       <div className="mb-4 flex justify-center">
                         <img 
                           src={segment.imageUrl} 
                           alt={segment.originalText} 
                           className="max-w-full h-auto rounded-lg shadow-sm max-h-[500px]" 
                         />
                       </div>
                     ) : (
                       <div 
                          className={`${getTagStyles(segment.tagName)} ${settings.fontFamily}`}
                          style={{ fontSize: `${settings.fontSize}px` }}
                       >
                         {segment.originalText}
                       </div>
                     )}
                   </div>

                   {/* Translated Text Side */}
                   <div className={`w-1/2 pl-6 border-l ${theme.border} relative`}>
                     {segment.type === 'image' ? (
                       null
                     ) : segment.isLoading ? (
                       <div className="h-full flex items-center opacity-50 animate-pulse">
                         <span className={`text-xs rounded px-2 py-1 border ${theme.border}`}>Translating...</span>
                       </div>
                     ) : segment.translatedText ? (
                        <div 
                           className={`${getTagStyles(segment.tagName)} ${settings.fontFamily} ${theme.text}`}
                           style={{ fontSize: `${settings.fontSize}px` }}
                        >
                          {segment.translatedText}
                        </div>
                     ) : (
                       <div className="h-full flex items-center opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                          {/* Empty placeholder */}
                       </div>
                     )}
                   </div>
                 </div>
               ))}

               {/* Bottom Navigation */}
               <div className={`flex items-center justify-between pt-12 border-t mt-12 ${theme.border}`}>
                 <button 
                   onClick={prevChapter}
                   disabled={currentChapterIndex === 0}
                   className={`flex items-center gap-2 transition-colors disabled:opacity-30 ${theme.hover} px-3 py-2 rounded-lg`}
                 >
                   <ChevronLeft /> Previous Chapter
                 </button>
                 
                 <div className={`text-sm ${theme.secondaryText}`}>
                   {currentChapterIndex + 1} / {book.chapters.length}
                 </div>

                 <button 
                   onClick={nextChapter}
                   disabled={currentChapterIndex === book.chapters.length - 1}
                   className={`flex items-center gap-2 transition-colors disabled:opacity-30 ${theme.hover} px-3 py-2 rounded-lg`}
                 >
                   Next Chapter <ChevronRight />
                 </button>
               </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};