import React, { useState, useEffect, useRef } from 'react';
import { ReaderView } from './components/ReaderView';
import { parseEpub } from './services/epubParser';
import { ParsedBook, LibraryBook } from './types';
import { db } from './services/db';
import { Plus, BookOpen, Trash2, Loader2, Upload } from 'lucide-react';

const App: React.FC = () => {
  // View State
  const [currentView, setCurrentView] = useState<'library' | 'reader'>('library');
  
  // Data State
  const [library, setLibrary] = useState<LibraryBook[]>([]);
  const [selectedBookId, setSelectedBookId] = useState<string | null>(null);
  const [activeBook, setActiveBook] = useState<ParsedBook | null>(null);
  const [activeBookBlob, setActiveBookBlob] = useState<Blob | null>(null);
  
  // Loading State
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(true);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [isOpeningBook, setIsOpeningBook] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delete Modal State
  const [bookToDelete, setBookToDelete] = useState<{id: string, title: string} | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initial Load
  useEffect(() => {
    refreshLibrary();
  }, []);

  const refreshLibrary = async () => {
    setIsLoadingLibrary(true);
    try {
      const books = await db.getBooks();
      // Sort by added date descending
      setLibrary(books.sort((a, b) => b.addedAt - a.addedAt));
    } catch (e) {
      console.error("Failed to load library", e);
      setError("Failed to load your library.");
    } finally {
      setIsLoadingLibrary(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || !e.target.files[0]) return;
    
    const file = e.target.files[0];
    setIsProcessingFile(true);
    setError(null);
    
    try {
      // OPTIMIZED: Now parseEpub only extracts metadata, not full content.
      const parsed = await parseEpub(file);
      
      // Prepare cover blob
      let coverBlob: Blob | undefined;
      if (parsed.coverUrl) {
        const resp = await fetch(parsed.coverUrl);
        coverBlob = await resp.blob();
        // Clean up URL
        URL.revokeObjectURL(parsed.coverUrl);
      }

      const newBook: LibraryBook = {
        id: crypto.randomUUID(),
        title: parsed.metadata.title,
        author: parsed.metadata.creator,
        cover: coverBlob,
        addedAt: Date.now(),
      };

      // Store in DB
      await db.addBook(newBook, file);
      
      // Update UI
      await refreshLibrary();
      
    } catch (err) {
      console.error(err);
      setError("Failed to parse EPUB file. Is it a valid EPUB?");
    } finally {
      setIsProcessingFile(false);
      // Reset input
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const openBook = async (bookId: string) => {
    setIsOpeningBook(true);
    setError(null);
    try {
      const fileBlob = await db.getBookFile(bookId);
      if (!fileBlob) throw new Error("Book file not found in storage.");
      
      // Fast structure parse
      const parsed = await parseEpub(fileBlob as File); 
      
      setActiveBook(parsed);
      setActiveBookBlob(fileBlob);
      setSelectedBookId(bookId);
      setCurrentView('reader');
    } catch (err) {
      console.error(err);
      setError("Failed to open book. The file might be corrupted.");
    } finally {
      setIsOpeningBook(false);
    }
  };

  const confirmDelete = async () => {
    if (!bookToDelete) return;
    
    try {
      setError(null);
      await db.deleteBook(bookToDelete.id);
      await refreshLibrary();
    } catch (err) {
      console.error("Failed to delete book:", err);
      setError("Could not delete the book. Please try again.");
    } finally {
      setBookToDelete(null);
    }
  };

  const handleBackToLibrary = () => {
    setActiveBook(null);
    setActiveBookBlob(null);
    setSelectedBookId(null);
    setCurrentView('library');
  };

  if (currentView === 'reader' && activeBook && activeBookBlob && selectedBookId) {
    return (
      <ReaderView 
        bookId={selectedBookId} 
        book={activeBook} 
        epubFile={activeBookBlob}
        onBack={handleBackToLibrary} 
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 relative">
      
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4 flex justify-between items-center sticky top-0 z-10 shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2">
            <BookOpen className="text-blue-600" /> LingoBinder
          </h1>
        </div>
        <button 
          onClick={() => fileInputRef.current?.click()}
          disabled={isProcessingFile}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2 disabled:opacity-70"
        >
          {isProcessingFile ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          Add Book
        </button>
        <input 
          ref={fileInputRef}
          type="file"
          accept=".epub,application/epub+zip"
          onChange={handleFileSelect}
          className="hidden"
        />
      </div>

      {/* Library Grid */}
      <main className="max-w-6xl mx-auto p-6 md:p-8">
        
        {error && (
            <div className="mb-6 p-4 bg-red-50 text-red-600 border border-red-100 rounded-lg flex items-center gap-2">
              <AlertCircle className="w-5 h-5" /> {error}
            </div>
        )}

        {isLoadingLibrary ? (
           <div className="flex flex-col items-center justify-center h-64 text-slate-400">
             <Loader2 className="w-10 h-10 animate-spin mb-4" />
             <p>Loading library...</p>
           </div>
        ) : library.length === 0 ? (
           <div className="flex flex-col items-center justify-center h-96 text-center border-2 border-dashed border-slate-200 rounded-2xl bg-white/50">
              <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-4 text-blue-500">
                <Upload size={32} />
              </div>
              <h2 className="text-xl font-semibold text-slate-700 mb-2">Your library is empty</h2>
              <p className="text-slate-500 max-w-sm mb-6">
                Upload an EPUB book to start reading with AI-powered dual translations.
              </p>
              <button 
                onClick={() => fileInputRef.current?.click()}
                className="text-blue-600 font-medium hover:underline"
              >
                Upload your first book
              </button>
           </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
             {library.map((book) => (
               <div 
                 key={book.id} 
                 className="group bg-white rounded-xl border border-slate-200 shadow-sm hover:shadow-md hover:border-blue-300 transition-all cursor-pointer flex flex-col overflow-hidden relative"
                 onClick={() => openBook(book.id)}
               >
                  {/* Cover */}
                  <div className="aspect-[2/3] bg-slate-100 relative overflow-hidden">
                    {book.cover ? (
                      <img 
                        src={URL.createObjectURL(book.cover)} 
                        alt={`Cover for ${book.title}`}
                        className="w-full h-full object-cover transition-transform group-hover:scale-105"
                        onLoad={(e) => URL.revokeObjectURL((e.target as HTMLImageElement).src)}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-slate-300 bg-slate-100">
                        <BookOpen size={48} />
                      </div>
                    )}
                    
                    {/* Overlay while opening */}
                    {isOpeningBook && selectedBookId === book.id && (
                       <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10">
                         <Loader2 className="text-blue-600 animate-spin" />
                       </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="p-4 flex-1 flex flex-col">
                    <h3 className="font-semibold text-slate-800 line-clamp-2 mb-1" title={book.title}>{book.title}</h3>
                    <p className="text-sm text-slate-500 line-clamp-1 mb-3">{book.author}</p>
                    <div className="mt-auto text-xs text-slate-400 flex justify-between items-center">
                       <span>{new Date(book.addedAt).toLocaleDateString()}</span>
                       <button 
                         onClick={(e) => {
                            e.stopPropagation();
                            setBookToDelete({ id: book.id, title: book.title });
                         }}
                         className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-full transition-colors -mr-2"
                         title="Delete Book"
                       >
                         <Trash2 size={18} />
                       </button>
                    </div>
                  </div>
               </div>
             ))}
          </div>
        )}
      </main>

      {/* Delete Confirmation Modal */}
      {bookToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div 
            className="absolute inset-0 bg-black/30 backdrop-blur-sm" 
            onClick={() => setBookToDelete(null)} 
          />
          <div className="relative bg-white rounded-xl shadow-2xl p-6 w-full max-w-sm overflow-hidden border border-slate-100 scale-100 animate-in zoom-in-95 duration-200">
             <h3 className="text-lg font-bold text-slate-800 mb-2">Delete Book?</h3>
             <p className="text-slate-600 mb-6 leading-relaxed">
               Are you sure you want to delete <span className="font-semibold text-slate-900">"{bookToDelete.title}"</span>? This action cannot be undone.
             </p>
             <div className="flex justify-end gap-3">
               <button 
                 onClick={() => setBookToDelete(null)} 
                 className="px-4 py-2 text-slate-600 font-medium hover:bg-slate-100 rounded-lg transition-colors"
               >
                 Cancel
               </button>
               <button 
                 onClick={confirmDelete} 
                 className="px-4 py-2 bg-red-600 text-white font-medium rounded-lg hover:bg-red-700 transition-colors shadow-sm flex items-center gap-2"
               >
                 <Trash2 size={16} /> Delete
               </button>
             </div>
          </div>
        </div>
      )}

      <div className="fixed bottom-4 right-4 text-[10px] text-slate-400 pointer-events-none">
         Powered by Gemini 2.5 Flash
      </div>
    </div>
  );
};

export default App;

function AlertCircle(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      {...props}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" x2="12" y1="8" y2="12" />
      <line x1="12" x2="12.01" y1="16" y2="16" />
    </svg>
  )
}