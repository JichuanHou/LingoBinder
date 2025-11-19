import JSZip from 'jszip';
import { ParsedBook, ChapterRef, Segment, TocItem } from '../types';

/**
 * Parses a raw .epub file (Blob) into a structured object.
 */
export const parseEpub = async (file: File): Promise<ParsedBook> => {
  const zip = new JSZip();
  const loadedZip = await zip.loadAsync(file);

  // 1. Find the OPF file path from META-INF/container.xml
  const containerXml = await loadedZip.file("META-INF/container.xml")?.async("string");
  if (!containerXml) throw new Error("Invalid EPUB: Missing META-INF/container.xml");

  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, "application/xml");
  const rootfile = containerDoc.querySelector("rootfile");
  const opfPath = rootfile?.getAttribute("full-path");

  if (!opfPath) throw new Error("Invalid EPUB: Could not find OPF path");

  // 2. Parse OPF to get manifest and spine
  const opfContent = await loadedZip.file(opfPath)?.async("string");
  if (!opfContent) throw new Error("Invalid EPUB: OPF file missing");

  const opfDoc = parser.parseFromString(opfContent, "application/xml");
  
  // Extract Metadata
  const metadata = {
    title: opfDoc.querySelector("metadata title")?.textContent || "Unknown Title",
    creator: opfDoc.querySelector("metadata creator")?.textContent || "Unknown Author",
    language: opfDoc.querySelector("metadata language")?.textContent || "en",
  };

  // Map manifest items (id -> href)
  const manifest: Record<string, string> = {};
  opfDoc.querySelectorAll("manifest item").forEach((item) => {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (id && href) manifest[id] = href;
  });

  // Get Spine (Reading Order)
  const chapters: ChapterRef[] = [];
  const spineItems = opfDoc.querySelectorAll("spine itemref");
  const opfDir = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);

  spineItems.forEach((item, index) => {
    const idRef = item.getAttribute("idref");
    if (idRef && manifest[idRef]) {
      let href = manifest[idRef];
      // Normalize path relative to zip root
      const fullPath = opfDir + href;
      
      chapters.push({
        id: idRef,
        href: fullPath,
        title: `Chapter ${index + 1}`, // Titles are hard to extract reliably without NCX parsing, simplifying for now
        order: index
      });
    }
  });

  // 3. Parse TOC (NCX) if available
  let toc: TocItem[] = [];
  const spine = opfDoc.querySelector("spine");
  const tocId = spine?.getAttribute("toc");
  let tocHref = "";

  if (tocId && manifest[tocId]) {
    tocHref = manifest[tocId];
  }

  // If no explicit TOC in spine, look for ncx in manifest
  if (!tocHref) {
    const ncxItem = Array.from(opfDoc.querySelectorAll("manifest item")).find(item => 
      item.getAttribute("media-type") === "application/x-dtbncx+xml"
    );
    if (ncxItem) {
      tocHref = ncxItem.getAttribute("href") || "";
    }
  }

  if (tocHref) {
    const fullTocPath = opfDir + tocHref;
    const tocContent = await loadedZip.file(fullTocPath)?.async("string");
    if (tocContent) {
      toc = parseNcx(tocContent, fullTocPath);
    }
  }

  // Store all files in memory blobs for easy access
  const files: Record<string, Blob> = {};
  for (const fileName in loadedZip.files) {
    const content = await loadedZip.file(fileName)?.async("blob");
    if (content) files[fileName] = content;
  }

  return { metadata, chapters, toc, files };
};

// Helper: Resolve relative paths (e.g., "../Images/img.jpg" relative to "Text/Section01.xhtml")
const resolvePath = (baseFile: string, relativePath: string): string => {
  if (!relativePath) return '';
  
  // Decode URI to handle %20 spaces etc
  relativePath = decodeURIComponent(relativePath);

  const stack = baseFile.split('/');
  stack.pop(); // Remove current filename from base to get directory

  const parts = relativePath.split('/');
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      stack.pop();
    } else {
      stack.push(part);
    }
  }
  return stack.join('/');
};

// Helper: Parse NCX XML content
const parseNcx = (xml: string, tocPath: string): TocItem[] => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "application/xml");
  
  const parseNavPoint = (node: Element): TocItem | null => {
    const label = node.querySelector("navLabel > text")?.textContent || "Untitled";
    const content = node.querySelector("content");
    const src = content?.getAttribute("src");
    
    if (!src) return null;

    const fullHref = resolvePath(tocPath, src);

    const subitems: TocItem[] = [];
    Array.from(node.children).forEach(child => {
      if (child.tagName.toLowerCase() === 'navpoint') {
        const item = parseNavPoint(child);
        if (item) subitems.push(item);
      }
    });

    return {
      label,
      href: fullHref,
      subitems
    };
  };

  const navMap = doc.querySelector("navMap");
  const items: TocItem[] = [];

  if (navMap) {
    Array.from(navMap.children).forEach(child => {
      if (child.tagName.toLowerCase() === 'navpoint') {
        const item = parseNavPoint(child);
        if (item) items.push(item);
      }
    });
  }

  return items;
};

/**
 * Converts an HTML string from a chapter into a list of alignable Segments.
 * Handles Text and Images.
 */
export const parseChapterContent = async (book: ParsedBook, chapter: ChapterRef): Promise<Segment[]> => {
  const blob = book.files[chapter.href];
  if (!blob) return [];

  const text = await blob.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xhtml+xml"); 

  const segments: Segment[] = [];
  const blockTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'div'];
  
  // Temporary buffer for accumulating text within a block
  let currentText = '';
  let currentTag = 'p';

  const flushText = () => {
    if (currentText.trim().length > 0) {
      segments.push({
        id: Math.random().toString(36).substr(2, 9),
        type: 'text',
        tagName: currentTag,
        originalText: currentText.trim(),
        isLoading: false
      });
    }
    currentText = '';
    currentTag = 'p';
  };

  const walk = (node: Node, parentTag: string) => {
    if (node.nodeType === Node.TEXT_NODE) {
      // Accumulate text
      currentText += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      if (tag === 'img' || tag === 'image' || tag === 'svg') {
        // 1. Flush any pending text before the image
        flushText();

        // 2. Handle Image & Resolve Source
        let src = el.getAttribute('src') || el.getAttribute('href');
        
        // Special handling for SVG wrappers (Common in Cover pages)
        if (tag === 'svg') {
            const innerImage = el.querySelector('image');
            if (innerImage) {
                src = innerImage.getAttribute('href') || 
                      innerImage.getAttribute('xlink:href') || 
                      innerImage.getAttribute('src');
            }
        }

        // Fallback for direct xlink:href usage on the element itself
        if (!src) {
            src = el.getAttribute('xlink:href');
        }

        const alt = el.getAttribute('alt') || el.getAttribute('title') || 'Image';
        
        if (src) {
           // Resolve path relative to current chapter file
           const absolutePath = resolvePath(chapter.href, src);
           const imageBlob = book.files[absolutePath];
           
           if (imageBlob) {
             const imageUrl = URL.createObjectURL(imageBlob);
             segments.push({
               id: Math.random().toString(36).substr(2, 9),
               type: 'image',
               tagName: 'img',
               originalText: alt, // Use originalText for alt text
               imageUrl: imageUrl,
               isLoading: false
             });
           } else {
             console.warn(`Image not found: ${absolutePath} (src: ${src})`);
           }
        }
      } else if (blockTags.includes(tag)) {
        // It's a block element
        flushText(); // Flush previous content
        
        // Update current tag context for the upcoming text
        currentTag = tag; 
        
        // Process children
        node.childNodes.forEach(child => walk(child, tag));
        
        // Flush after block ends (creates the segment for this block)
        flushText();
      } else if (tag === 'br') {
        currentText += '\n';
      } else {
        // Inline elements (span, b, i, etc.) -> just traverse children
        node.childNodes.forEach(child => walk(child, parentTag));
      }
    }
  };

  doc.body.childNodes.forEach(node => walk(node, 'div'));
  flushText(); // Final flush

  return segments;
};