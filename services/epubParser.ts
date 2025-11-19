import JSZip from 'jszip';
import { ParsedBook, ChapterRef, Segment, TocItem } from '../types';

/**
 * Parses a raw .epub file (Blob) into a structured object.
 * OPTIMIZED: Does NOT unzip all files. Only reads metadata and structure.
 */
export const parseEpub = async (file: File | Blob): Promise<ParsedBook> => {
  const zip = new JSZip();
  // This loads the zip directory structure, but does not decompress data yet
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
        title: `Chapter ${index + 1}`, 
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

  // 4. Extract Cover Image (Only this one file is unzipped now)
  let coverUrl: string | undefined;
  const coverMeta = opfDoc.querySelector('meta[name="cover"]');
  if (coverMeta) {
      const coverId = coverMeta.getAttribute("content");
      if (coverId && manifest[coverId]) {
          const coverPath = opfDir + manifest[coverId];
          const coverBlob = await loadedZip.file(coverPath)?.async("blob");
          if (coverBlob) {
              coverUrl = URL.createObjectURL(coverBlob);
          }
      }
  }

  return { metadata, chapters, toc, coverUrl };
};

// Helper: Resolve relative paths
const resolvePath = (baseFile: string, relativePath: string): string => {
  if (!relativePath) return '';
  relativePath = decodeURIComponent(relativePath);

  const stack = baseFile.split('/');
  stack.pop(); // Remove current filename

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

    return { label, href: fullHref, subitems };
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
 * Parses chapter content using the provided JSZip instance to load resources on demand.
 * @param mode 'full' loads images as Blobs (UI blocking). 'text-only' skips images (faster, for search).
 */
export const parseChapterContent = async (
    zip: JSZip, 
    chapter: ChapterRef, 
    mode: 'full' | 'text-only' = 'full'
): Promise<Segment[]> => {
  const file = zip.file(chapter.href);
  if (!file) return [];

  const text = await file.async("string");
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xhtml+xml"); 

  const segments: Segment[] = [];
  const blockTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'blockquote', 'div'];
  
  let currentText = '';
  let currentTag = 'p';
  let segmentCounter = 0;

  // Map to store image tasks: segmentIndex -> imagePath
  const pendingImages: { index: number; path: string }[] = [];

  const getDeterministicId = () => {
    segmentCounter++;
    return `seg-${segmentCounter}`;
  };

  const flushText = () => {
    if (currentText.trim().length > 0) {
      segments.push({
        id: getDeterministicId(),
        type: 'text',
        tagName: currentTag,
        originalText: currentText.trim(),
        isLoading: false
      });
    }
    currentText = '';
    currentTag = 'p';
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      currentText += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      // Image Handling
      if (tag === 'img' || tag === 'image' || tag === 'svg') {
        flushText();

        // If text-only mode, we skip image processing entirely
        if (mode === 'text-only') return;

        let src = el.getAttribute('src') || el.getAttribute('href');
        if (tag === 'svg') {
            const innerImage = el.querySelector('image');
            if (innerImage) {
                src = innerImage.getAttribute('href') || innerImage.getAttribute('xlink:href');
            }
        }
        if (!src) src = el.getAttribute('xlink:href');

        const alt = el.getAttribute('alt') || el.getAttribute('title') || 'Image';
        
        if (src) {
           const absolutePath = resolvePath(chapter.href, src);
           // Push placeholder segment
           segments.push({
             id: getDeterministicId(),
             type: 'image',
             tagName: 'img',
             originalText: alt,
             isLoading: false
           });
           // Queue image load
           pendingImages.push({ index: segments.length - 1, path: absolutePath });
        }
      } else if (blockTags.includes(tag)) {
        flushText();
        currentTag = tag;
        node.childNodes.forEach(walk);
        flushText();
      } else if (tag === 'br') {
        currentText += '\n';
      } else {
        node.childNodes.forEach(walk);
      }
    }
  };

  doc.body.childNodes.forEach(walk);
  flushText();

  // Post-process: Load images in parallel ONLY if full mode
  if (mode === 'full') {
    await Promise.all(pendingImages.map(async (task) => {
        const imageBlob = await zip.file(task.path)?.async("blob");
        if (imageBlob) {
        segments[task.index].imageUrl = URL.createObjectURL(imageBlob);
        } else {
            console.warn("Image not found in zip:", task.path);
        }
    }));
  }

  return segments;
};