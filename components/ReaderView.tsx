
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronLeft, ChevronRight, Globe, Loader2, ArrowLeft, List, X, AlertCircle, Settings, Minus, Plus, Moon, Sun, Coffee, Search, Server, Key, PauseCircle, RefreshCw } from 'lucide-react';
import { ParsedBook, Segment, TargetLanguage, TocItem, AISettings } from '../types';
import { parseChapterContent } from '../services/epubParser';
import { translateSegmentsBatch } from '../services/geminiService';
import { db } from '../services/db';
import JSZip from 'jszip';

interface ReaderViewProps {
  bookId: string;
  book: ParsedBook;
  epubFile: Blob;
  onBack: () => void;
}

// Increased to save tokens on system prompts per request
const BATCH_SIZE = 30; 

interface ReaderSettings {
  fontSize: number;
  fontFamily: 'font-serif' | 'font-sans' | 'font-mono';
  theme: 'light' | 'sepia' | 'dark';
}

interface SearchResult {
    chapterIndex: number;
    chapterTitle: string;
    segmentId: string;
    snippet: string;
}

const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  fontFamily: 'font-serif',
  theme: 'light',
};

const DEFAULT_AI_SETTINGS: AISettings = {
  provider: 'gemini',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'gemini-2.5-flash'
};

const isTranslationError = (text?: string) => {
  return text?.includes("[Translation Failed]") || text?.includes("[Error: Retry Limit Exceeded]");
};

export const ReaderView: React.FC<ReaderViewProps> = ({ bookId, book, epubFile, onBack }) => {
  // Book State
  const [currentChapterIndex, setCurrentChapterIndex] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [isLoadingChapter, setIsLoadingChapter] = useState(false);
  const [targetLang, setTargetLang] = useState<TargetLanguage>(TargetLanguage.CHINESE);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [translationProgress, setTranslationProgress] = useState(0);
  const [zipInstance, setZipInstance] = useState<JSZip | null>(null);
  
  // Refs
  const currentChapterRef = useRef<string>('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingScrollRef = useRef<string | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // UI State
  const [isTocOpen, setIsTocOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<'view' | 'ai'>('view');
  const [showRetranslateConfirm, setShowRetranslateConfirm] = useState(false);

  // Search State
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);

  // Settings State
  const [settings, setSettings] = useState<ReaderSettings>(() => {
    const saved = localStorage.getItem('lingo-reader-settings');
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });

  const [aiSettings, setAiSettings] = useState<AISettings>(() => {
    const saved = localStorage.getItem('lingo-ai-settings');
    return saved ? JSON.parse(saved) : DEFAULT_AI_SETTINGS;
  });

  const currentChapter = book.chapters[currentChapterIndex];

  // Initialize Zip Engine & Restore Progress
  useEffect(() => {
    const init = async () => {
      const zip = new JSZip();
      try {
        await zip.loadAsync(epubFile);
        setZipInstance(zip);
        
        // Restore Progress
        const progress = await db.getProgress(bookId);
        if (progress) {
            if (progress.chapterIndex >= 0 && progress.chapterIndex < book.chapters.length) {
                setCurrentChapterIndex(progress.chapterIndex);
                if (progress.segmentId) {
                    pendingScrollRef.current = progress.segmentId.replace('seg-', '');
                }
            }
        }
      } catch (e) {
        console.error("Failed to load EPUB or progress", e);
      }
    };
    init();
  }, [epubFile, bookId, book.chapters.length]);

  // Sync current chapter ID
  useEffect(() => {
    if (currentChapter) {
      currentChapterRef.current = currentChapter.id;
    }
  }, [currentChapter]);

  // Persist Settings
  useEffect(() => {
    localStorage.setItem('lingo-reader-settings', JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem('lingo-ai-settings', JSON.stringify(aiSettings));
  }, [aiSettings]);

  // Reset confirmation when translation starts or stops
  useEffect(() => {
    if (!isTranslating) setShowRetranslateConfirm(false);
  }, [isTranslating]);

  // Auto-scroll to pending segment after segments load
  useEffect(() => {
    if (pendingScrollRef.current && !isLoadingChapter && segments.length > 0) {
        const scrollTargetId = `seg-${pendingScrollRef.current}`;
        
        const attemptScroll = (delay: number) => {
            setTimeout(() => {
                const element = document.getElementById(scrollTargetId);
                if (element) {
                    element.scrollIntoView({ behavior: 'auto', block: 'center' });
                    element.classList.add('bg-yellow-200/30', 'transition-colors', 'duration-1000');
                    setTimeout(() => {
                        element.classList.remove('bg-yellow-200/30');
                    }, 2000);
                }
            }, delay);
        };

        attemptScroll(0);
        attemptScroll(100);
        attemptScroll(500);

        setTimeout(() => {
            pendingScrollRef.current = null;
        }, 1000);
    }
  }, [segments, isLoadingChapter]);

  const cleanupResources = useCallback((segmentList: Segment[]) => {
    segmentList.forEach(seg => {
      if (seg.imageUrl) {
        URL.revokeObjectURL(seg.imageUrl);
      }
    });
  }, []);

  // Load Chapter Content
  useEffect(() => {
    let active = true; 

    const loadChapter = async () => {
      if (!currentChapter || !zipInstance) return;
      
      cleanupResources(segments);
      setIsLoadingChapter(true);
      setSegments([]); 
      setShowRetranslateConfirm(false);
      
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
          abortControllerRef.current = null;
          setIsTranslating(false);
          setIsStopping(false);
      }
      
      try {
        const extractedSegments = await parseChapterContent(zipInstance, currentChapter, 'full');
        
        if (!active) {
            cleanupResources(extractedSegments);
            return;
        }

        const savedTranslations = await db.getTranslations(bookId, currentChapter.href);
        
        if (!active) return;

        const mergedSegments = extractedSegments.map(seg => {
          if (savedTranslations[seg.id]) {
            return { ...seg, translatedText: savedTranslations[seg.id] };
          }
          return seg;
        });

        setSegments(mergedSegments);
      } catch (e) {
        if (active) console.error("Failed to load chapter", e);
      } finally {
        if (active) setIsLoadingChapter(false);
      }
    };

    loadChapter();
    
    return () => {
       active = false;
    };
  }, [currentChapter, book, bookId, zipInstance]);

  useEffect(() => {
      return () => {
          cleanupResources(segments);
          if (abortControllerRef.current) {
              abortControllerRef.current.abort();
          }
      };
  }, []);

  // Translation Logic
  const handleTranslate = useCallback(async (force: boolean = false) => {
    if (segments.length === 0) return;
    
    // Stop any existing process
    if (abortControllerRef.current) {
        abortControllerRef.current.abort();
    }
    
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const translationChapterId = currentChapter.id;
    setIsTranslating(true);
    setIsStopping(false);
    setTranslationProgress(0);

    // Filter: include segments that are untranslated OR have error messages OR if forced
    const segmentsToTranslate = segments.filter(s => 
      s.type === 'text' && 
      (force || !s.translatedText || isTranslationError(s.translatedText))
    );
    
    if (segmentsToTranslate.length === 0) {
        setIsTranslating(false);
        return;
    }

    const totalBatches = Math.ceil(segmentsToTranslate.length / BATCH_SIZE);
    let completedBatches = 0;
    let currentSegments = [...segments];

    try {
        for (let i = 0; i < segmentsToTranslate.length; i += BATCH_SIZE) {
          if (controller.signal.aborted) break;
          if (currentChapterRef.current !== translationChapterId) break;

          const batch = segmentsToTranslate.slice(i, i + BATCH_SIZE);
          const texts = batch.map(s => s.originalText);
          
          const batchIds = new Set(batch.map(b => b.id));
          setSegments(prev => prev.map(s => batchIds.has(s.id) ? { ...s, isLoading: true } : s));

          // Pass aiSettings AND the abort signal to service
          const translations = await translateSegmentsBatch(texts, targetLang, aiSettings, controller.signal);

          if (controller.signal.aborted) break;
          if (currentChapterRef.current !== translationChapterId) break;

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
          
          if (currentChapter) {
            await db.saveTranslations(bookId, currentChapter.href, currentSegments);
          }

          completedBatches++;
          setTranslationProgress(Math.round((completedBatches / totalBatches) * 100));

          // Small delay between batches
          if (i + BATCH_SIZE < segmentsToTranslate.length) {
            try {
                for (let d = 0; d < 5; d++) { 
                    if (controller.signal.aborted) throw new Error("Aborted");
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            } catch (e) {
                break; 
            }
          }
        }
    } catch (error: any) {
        if (error.message === "Aborted") {
            console.log("Translation stopped by user.");
        } else {
            console.error("Translation Error", error);
        }
    } finally {
        // Only reset state if WE are still the active controller
        if (abortControllerRef.current === controller) {
            // Clean up loading states if aborted
            if (controller.signal.aborted) {
                setSegments(prev => prev.map(s => s.isLoading ? { ...s, isLoading: false } : s));
            }
            setIsTranslating(false);
            setIsStopping(false);
            abortControllerRef.current = null;
        }
    }
  }, [segments, targetLang, currentChapter, bookId, aiSettings]);

  const handleStopTranslation = () => {
      if (abortControllerRef.current) {
          setIsStopping(true);
          abortControllerRef.current.abort();
      }
  };

  // Search Logic
  const performSearch = async () => {
      if (!searchQuery.trim() || !zipInstance) return;
      
      setIsSearching(true);
      setSearchResults([]);
      
      const queryLower = searchQuery.toLowerCase();
      const results: SearchResult[] = [];

      try {
          for (let i = 0; i < book.chapters.length; i++) {
              const chapter = book.chapters[i];
              const chapterSegments = await parseChapterContent(zipInstance, chapter, 'text-only');
              
              for (const seg of chapterSegments) {
                  if (seg.type === 'text' && seg.originalText.toLowerCase().includes(queryLower)) {
                      const text = seg.originalText;
                      const matchIndex = text.toLowerCase().indexOf(queryLower);
                      const start = Math.max(0, matchIndex - 30);
                      const end = Math.min(text.length, matchIndex + queryLower.length + 30);
                      const snippet = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');

                      results.push({
                          chapterIndex: i,
                          chapterTitle: chapter.title || `Chapter ${i + 1}`,
                          segmentId: seg.id,
                          snippet: snippet
                      });

                      if (results.length >= 50) break;
                  }
              }
              if (results.length >= 50) break;
          }
          setSearchResults(results);
      } catch (e) {
          console.error("Search failed", e);
      } finally {
          setIsSearching(false);
      }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
          performSearch();
      }
  };

  const handleSearchResultClick = (result: SearchResult) => {
      setCurrentChapterIndex(result.chapterIndex);
      pendingScrollRef.current = result.segmentId.replace('seg-', '');
      setIsSearchOpen(false);
  };

  // Scroll Tracking
  const handleScroll = useCallback(() => {
      if (!scrollContainerRef.current || isLoadingChapter) return;
      
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      
      saveTimeoutRef.current = setTimeout(() => {
          const container = scrollContainerRef.current;
          if (!container) return;
          
          const containerRect = container.getBoundingClientRect();
          const offset = 100; 
          
          let foundSegmentId = null;

          for (const seg of segments) {
              const el = document.getElementById(seg.id);
              if (el) {
                  const rect = el.getBoundingClientRect();
                  if (rect.bottom > containerRect.top + offset) {
                      foundSegmentId = seg.id;
                      break;
                  }
              }
          }

          if (foundSegmentId) {
             db.saveProgress(bookId, currentChapterIndex, foundSegmentId).catch(console.error);
          }

      }, 1000); 
  }, [bookId, currentChapterIndex, segments, isLoadingChapter]);


  // Navigation
  const nextChapter = useCallback(() => {
    if (currentChapterIndex < book.chapters.length - 1) {
      setCurrentChapterIndex(prev => prev + 1);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTo(0, 0);
    }
  }, [currentChapterIndex, book.chapters.length]);

  const prevChapter = useCallback(() => {
    if (currentChapterIndex > 0) {
      setCurrentChapterIndex(prev => prev - 1);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTo(0, 0);
    }
  }, [currentChapterIndex]);

  const handleTocNavigation = (href: string) => {
    const [fileHref] = href.split('#');
    const chapterIndex = book.chapters.findIndex(c => 
      c.href === fileHref || 
      c.href.endsWith(`/${fileHref}`) || 
      fileHref.endsWith(c.href)
    );
    
    if (chapterIndex !== -1) {
      setCurrentChapterIndex(chapterIndex);
      setIsTocOpen(false);
      if (scrollContainerRef.current) scrollContainerRef.current.scrollTo(0, 0);
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight') nextChapter();
      else if (e.key === 'ArrowLeft') prevChapter();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nextChapter, prevChapter]);

  // Styling Helpers
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
          hover: 'hover:bg-slate-800',
          inputBg: 'bg-slate-800',
          inputText: 'text-white'
        };
      case 'sepia':
        return {
          bg: 'bg-[#f4ecd8]',
          text: 'text-[#2c2218]', 
          headerBg: 'bg-[#f4ecd8] border-[#e3dccb]',
          border: 'border-[#e3dccb]',
          highlight: 'text-[#8f6b4e]',
          secondaryText: 'text-[#786655]',
          hover: 'hover:bg-[#e8dec5]',
          inputBg: 'bg-[#e8dec5]',
          inputText: 'text-[#2c2218]'
        };
      default: 
        return {
          bg: 'bg-white',
          text: 'text-slate-800',
          headerBg: 'bg-white border-slate-200',
          border: 'border-slate-100',
          highlight: 'text-blue-600',
          secondaryText: 'text-slate-400',
          hover: 'hover:bg-slate-100',
          inputBg: 'bg-slate-100',
          inputText: 'text-slate-800'
        };
    }
  };

  const theme = getThemeColors();

  const getTagStyles = (tag: string) => {
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
        className={`w-full text-left px-4 py-2 text-sm transition-colors truncate ${theme.hover}`}
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

  const canTranslate = segments.some(s => s.type === 'text' && (!s.translatedText || isTranslationError(s.translatedText)));
  const hasErrors = segments.some(s => s.type === 'text' && isTranslationError(s.translatedText));
  const hasTranslatedSegments = segments.some(s => s.type === 'text' && !!s.translatedText);

  if (!zipInstance) {
    return (
      <div className={`h-screen flex flex-col items-center justify-center ${theme.bg} ${theme.text}`}>
        <Loader2 className="w-8 h-8 animate-spin mb-4" />
        <p>Initializing Book Reader...</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-screen relative transition-colors duration-300 ${theme.bg} ${theme.text}`}>
      {/* Header Toolbar */}
      <header className={`sticky top-0 z-20 shadow-sm px-6 py-3 flex items-center justify-between transition-colors duration-300 ${theme.headerBg}`}>
        <div className="flex items-center gap-4">
          <button onClick={onBack} className={`p-2 rounded-full transition-colors ${theme.hover}`} title="Back to Library">
            <ArrowLeft size={20} />
          </button>
          
          <button 
             onClick={() => setIsTocOpen(true)}
             className={`p-2 rounded-full transition-colors ${theme.hover}`}
             title="Table of Contents"
          >
             <List size={20} />
          </button>

          <button 
             onClick={() => {
                 setIsSearchOpen(true);
                 setTimeout(() => searchInputRef.current?.focus(), 100);
             }}
             className={`p-2 rounded-full transition-colors ${theme.hover}`}
             title="Search Book"
          >
             <Search size={20} />
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
              title="Settings"
            >
              <Settings size={20} />
            </button>

            {isSettingsOpen && (
              <>
              <div className="fixed inset-0 z-10" onClick={() => setIsSettingsOpen(false)} />
              <div className="absolute right-0 top-full mt-2 w-80 bg-white text-slate-800 rounded-xl shadow-xl border border-slate-200 z-20 animate-in fade-in zoom-in-95 duration-100 overflow-hidden">
                
                {/* Tabs */}
                <div className="flex border-b border-slate-100">
                    <button 
                        onClick={() => setSettingsTab('view')}
                        className={`flex-1 py-2 text-sm font-medium ${settingsTab === 'view' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}
                    >
                        Appearance
                    </button>
                    <button 
                        onClick={() => setSettingsTab('ai')}
                        className={`flex-1 py-2 text-sm font-medium ${settingsTab === 'ai' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-slate-500 hover:bg-slate-50'}`}
                    >
                        AI Settings
                    </button>
                </div>

                <div className="p-4">
                  {settingsTab === 'view' ? (
                    <div className="space-y-4">
                        <div>
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

                        <div>
                        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Typeface</label>
                        <div className="flex gap-2">
                            {['font-serif', 'font-sans', 'font-mono'].map(font => (
                                <button 
                                    key={font}
                                    onClick={() => setSettings(s => ({ ...s, fontFamily: font as any }))}
                                    className={`flex-1 py-2 text-sm border rounded-md transition-colors ${settings.fontFamily === font ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                                >
                                    {font.replace('font-', '')}
                                </button>
                            ))}
                        </div>
                        </div>

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
                            style={{ backgroundColor: '#f4ecd8', color: '#2c2218' }}
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
                  ) : (
                    <div className="space-y-4">
                        <div>
                            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Provider</label>
                            <div className="grid grid-cols-2 gap-2">
                                <button 
                                    onClick={() => setAiSettings(s => ({ ...s, provider: 'gemini', model: 'gemini-2.5-flash' }))}
                                    className={`py-2 px-3 text-sm border rounded-lg text-center transition-colors ${aiSettings.provider === 'gemini' ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                                >
                                    Google Gemini
                                </button>
                                <button 
                                    onClick={() => setAiSettings(s => ({ ...s, provider: 'openai', model: 'google/gemini-2.5-flash' }))}
                                    className={`py-2 px-3 text-sm border rounded-lg text-center transition-colors ${aiSettings.provider === 'openai' ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-slate-200 hover:bg-slate-50'}`}
                                >
                                    OpenAI / Custom
                                </button>
                            </div>
                        </div>

                        {aiSettings.provider === 'gemini' ? (
                             <div className="space-y-4">
                                <div className="p-3 bg-blue-50 text-blue-800 text-xs rounded-lg border border-blue-100">
                                   <p className="font-medium mb-1">Using Google Gemini</p>
                                   <p className="opacity-80">Leave API Key empty to use the system default key.</p>
                                </div>
                                
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                        <Key size={12} /> API Key (Optional)
                                    </label>
                                    <input 
                                        type="password" 
                                        value={aiSettings.apiKey}
                                        onChange={(e) => setAiSettings(s => ({ ...s, apiKey: e.target.value }))}
                                        placeholder="Use system default or enter key"
                                        className="w-full text-sm p-2 rounded border border-slate-300 focus:border-blue-500 outline-none"
                                    />
                                </div>

                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Model Name</label>
                                    <input 
                                        type="text" 
                                        value={aiSettings.model}
                                        onChange={(e) => setAiSettings(s => ({ ...s, model: e.target.value }))}
                                        className="w-full text-sm p-2 rounded border border-slate-300 focus:border-blue-500 outline-none"
                                        placeholder="gemini-2.5-flash"
                                    />
                                </div>
                             </div>
                        ) : (
                            <div className="space-y-3">
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                        <Server size={12} /> Base URL
                                    </label>
                                    <input 
                                        type="text" 
                                        value={aiSettings.baseUrl}
                                        onChange={(e) => setAiSettings(s => ({ ...s, baseUrl: e.target.value }))}
                                        placeholder="https://openrouter.ai/api/v1"
                                        className="w-full text-sm p-2 rounded border border-slate-300 focus:border-blue-500 outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 flex items-center gap-1">
                                        <Key size={12} /> API Key
                                    </label>
                                    <input 
                                        type="password" 
                                        value={aiSettings.apiKey}
                                        onChange={(e) => setAiSettings(s => ({ ...s, apiKey: e.target.value }))}
                                        placeholder="sk-..."
                                        className="w-full text-sm p-2 rounded border border-slate-300 focus:border-blue-500 outline-none"
                                    />
                                </div>
                                <div>
                                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 block">Model Name</label>
                                    <input 
                                        type="text" 
                                        value={aiSettings.model}
                                        onChange={(e) => setAiSettings(s => ({ ...s, model: e.target.value }))}
                                        placeholder="google/gemini-2.5-flash"
                                        className="w-full text-sm p-2 rounded border border-slate-300 focus:border-blue-500 outline-none"
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                  )}
                </div>

              </div>
              </>
            )}
          </div>

          {/* Translation Controls */}
          {isTranslating ? (
             <button 
                onClick={handleStopTranslation}
                disabled={isStopping}
                className="relative overflow-hidden flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-white border border-red-100 shadow-sm hover:bg-red-50 hover:border-red-200 transition-all active:scale-95 group"
                title="Stop Translation"
             >
                <div className="flex items-center justify-center w-7 h-7 rounded-full bg-red-100 text-red-600 group-hover:scale-110 transition-transform">
                   {isStopping ? <Loader2 className="animate-spin" size={14} /> : <X size={16} strokeWidth={3} />}
                </div>
                <div className="flex flex-col items-start leading-none">
                   <span className="text-xs font-bold text-red-600 uppercase tracking-wide">{isStopping ? "Stopping" : "Stop"}</span>
                </div>
                {!isStopping && (
                    <div className="flex items-center ml-1 pl-2 border-l border-red-100">
                       <span className="text-xs font-mono font-medium text-red-500">{translationProgress}%</span>
                    </div>
                )}
             </button>
          ) : (
             <div className="flex items-center gap-2">
                {/* Primary Translate Action - Shows if there is work to do (gaps or errors) */}
                {canTranslate && (
                    <button 
                    onClick={() => handleTranslate(false)}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all shadow-sm
                        ${hasErrors 
                        ? 'bg-amber-500 text-white hover:bg-amber-600 hover:shadow-md'
                        : 'bg-blue-600 text-white hover:bg-blue-700 hover:shadow-md active:scale-95'}
                    `}
                    >
                    {hasErrors ? (
                        <>
                        <RefreshCw size={16} /> Retry Failed
                        </>
                    ) : (
                        <>
                        Translate <span className="hidden md:inline">Chapter</span>
                        </>
                    )}
                    </button>
                )}

                {/* Retranslate / Regenerate Action */}
                {hasTranslatedSegments && (
                    <button
                        type="button"
                        onClick={() => setShowRetranslateConfirm(true)}
                        className={`flex items-center gap-2 px-3 py-2 rounded-lg font-medium text-sm transition-all border
                             ${!canTranslate 
                                ? 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50 shadow-sm' // Main action style when fully translated
                                : 'border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700' // Secondary action style
                             }
                        `}
                        title="Retranslate entire chapter"
                    >
                        <RefreshCw size={16} />
                        {!canTranslate ? "Retranslate Chapter" : null}
                    </button>
                )}
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <div 
        className="flex-1 overflow-y-auto pt-4" 
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
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
                 <div id={segment.id} key={segment.id} className="flex group min-h-[2rem] transition-colors duration-500 rounded-lg p-1 -m-1">
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
                     ) : isTranslationError(segment.translatedText) ? (
                        <div className="flex flex-col items-start gap-2 text-red-600">
                            <span className="text-sm font-medium flex items-center gap-2">
                                <AlertCircle size={14} /> {segment.translatedText}
                            </span>
                            <button 
                                onClick={(e) => { e.stopPropagation(); handleTranslate(); }}
                                className="text-xs bg-red-50 hover:bg-red-100 border border-red-200 px-2 py-1 rounded flex items-center gap-1 transition-colors"
                            >
                                <RefreshCw size={10} /> Retry
                            </button>
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

      {/* Table of Contents Sidebar */}
      {isTocOpen && (
        <>
          <div 
            className="fixed inset-0 bg-black/20 backdrop-blur-[1px] z-40 animate-in fade-in duration-200"
            onClick={() => setIsTocOpen(false)}
          />
          <div className={`fixed top-0 left-0 bottom-0 w-80 max-w-[80vw] z-50 shadow-2xl transform transition-transform duration-300 animate-in slide-in-from-left ${theme.bg} flex flex-col border-r ${theme.border}`}>
            <div className={`flex items-center justify-between p-4 border-b ${theme.border}`}>
              <h2 className="font-semibold text-lg">Table of Contents</h2>
              <button 
                onClick={() => setIsTocOpen(false)}
                className={`p-2 rounded-full transition-colors ${theme.hover}`}
              >
                <X size={20} />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto py-2">
              {book.toc.length === 0 ? (
                 <div className="p-6 text-center opacity-60 italic text-sm">
                   No table of contents found.
                 </div>
              ) : (
                 book.toc.map((item, idx) => (
                   <TocItemView key={idx} item={item} />
                 ))
              )}
            </div>
          </div>
        </>
      )}

      {/* Search Overlay */}
      {isSearchOpen && (
        <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-start justify-center pt-20 px-4 animate-in fade-in duration-200" onClick={() => setIsSearchOpen(false)}>
            <div 
              className={`w-full max-w-2xl rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[70vh] ${theme.bg} border ${theme.border}`}
              onClick={e => e.stopPropagation()}
            >
               <div className={`flex items-center gap-3 p-4 border-b ${theme.border}`}>
                  <Search className="opacity-40" size={20} />
                  <input 
                    ref={searchInputRef}
                    type="text" 
                    className={`flex-1 bg-transparent border-none outline-none text-lg placeholder:opacity-40 ${theme.text}`}
                    placeholder="Search in book..."
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={handleSearchKeyDown}
                  />
                  {isSearching && <Loader2 className="animate-spin opacity-50" size={20} />}
                  <button onClick={() => setIsSearchOpen(false)} className={`p-1 rounded-full ${theme.hover}`}><X size={20} className="opacity-50" /></button>
               </div>
               
               <div className="flex-1 overflow-y-auto p-2">
                  {searchResults.map((result, i) => (
                      <button 
                        key={i} 
                        onClick={() => handleSearchResultClick(result)} 
                        className={`w-full text-left p-3 rounded-lg mb-1 transition-colors block group ${theme.hover}`}
                      >
                          <div className={`text-xs opacity-50 mb-1 flex justify-between`}>
                            <span>{result.chapterTitle}</span>
                          </div>
                          <div className="text-sm font-medium truncate leading-snug" dangerouslySetInnerHTML={{ __html: result.snippet.replace(new RegExp(searchQuery, 'gi'), match => `<span class="bg-yellow-200 text-slate-900 rounded px-0.5">${match}</span>`) }} />
                      </button>
                  ))}
                  {!isSearching && searchResults.length === 0 && searchQuery && (
                      <div className="p-12 text-center opacity-50">
                        <p>No results found for "{searchQuery}"</p>
                      </div>
                  )}
                  {!isSearching && !searchQuery && (
                      <div className="p-12 text-center opacity-40 text-sm">
                        Type to search across all chapters
                      </div>
                  )}
               </div>
            </div>
        </div>
      )}

      {/* Retranslate Confirmation Modal */}
      {showRetranslateConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
            <div 
                className="absolute inset-0 bg-black/30 backdrop-blur-sm" 
                onClick={() => setShowRetranslateConfirm(false)} 
            />
            <div className="relative bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm border border-slate-100 scale-100 animate-in zoom-in-95 duration-200">
                <h3 className="text-lg font-bold text-slate-800 mb-2">Retranslate Chapter?</h3>
                <p className="text-slate-600 mb-6 leading-relaxed">
                    This will overwrite all existing translations in this chapter. Are you sure?
                </p>
                <div className="flex justify-end gap-3">
                    <button 
                        onClick={() => setShowRetranslateConfirm(false)} 
                        className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={() => {
                            handleTranslate(true);
                            setShowRetranslateConfirm(false);
                        }} 
                        className="px-4 py-2 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm flex items-center gap-2"
                    >
                        <RefreshCw size={16} /> Retranslate
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};
