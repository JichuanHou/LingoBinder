import React, { useState } from 'react';
import { FileUpload } from './components/FileUpload';
import { ReaderView } from './components/ReaderView';
import { parseEpub } from './services/epubParser';
import { ParsedBook } from './types';

const App: React.FC = () => {
  const [book, setBook] = useState<ParsedBook | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFileSelect = async (file: File) => {
    try {
      setIsProcessing(true);
      setError(null);
      
      const parsedBook = await parseEpub(file);
      setBook(parsedBook);
    } catch (err) {
      console.error(err);
      setError("Failed to parse EPUB file. Please ensure it is a valid, non-DRM EPUB.");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleBack = () => {
    setBook(null);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900">
      {!book ? (
        <div className="flex flex-col items-center justify-center min-h-screen pb-20">
          <FileUpload onFileSelect={handleFileSelect} isProcessing={isProcessing} />
          {error && (
            <div className="mt-6 p-4 bg-red-50 text-red-600 border border-red-100 rounded-lg text-sm max-w-md text-center">
              {error}
            </div>
          )}
          <div className="absolute bottom-6 text-slate-400 text-xs">
            Powered by Google Gemini 2.5 Flash
          </div>
        </div>
      ) : (
        <ReaderView book={book} onBack={handleBack} />
      )}
    </div>
  );
};

export default App;