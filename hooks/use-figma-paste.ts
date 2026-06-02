'use client';

/**
 * Unified Paste Hook
 *
 * Intercepts the browser paste event to:
 * 1. Check for Figma plugin clipboard data → convert and insert layers
 * 2. Fall back to normal Ycode internal clipboard paste
 *
 * This runs on the paste event (not keydown) so we have access to
 * clipboardData for detecting the Figma payload.
 */

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { YCODE_FIGMA_SIGNATURE, isYcodeFigmaPayload } from '@/lib/figma/types';
import type { YcodeFigmaPayload } from '@/lib/figma/types';
import type { Layer } from '@/types';
import { useFontsStore } from '@/stores/useFontsStore';

interface UseFigmaPasteOptions {
  enabled: boolean;
  insertFigmaLayers: (layers: Layer[]) => void;
  onNormalPaste: () => void;
}

interface FontResolution {
  /** Lowercased family names that resolve to an installed/built-in font. */
  available: Set<string>;
  /** Families newly installed from Google during this import. */
  installed: string[];
  /** Families we couldn't resolve — left unset so layers use the default font. */
  unavailable: string[];
}

/**
 * Resolve the fonts used by an imported design BEFORE conversion runs.
 *
 * Installs any family that exists on Google Fonts, and returns the set of
 * families that actually resolve to a usable font. Families that can't be
 * resolved are reported back so the converter can skip them (rather than
 * emitting a dangling `font-[...]` class that silently renders as the default)
 * and the user can be told which fonts need manual handling.
 */
async function resolveFonts(families: string[]): Promise<FontResolution> {
  const store = useFontsStore.getState();
  await store.loadFonts();
  await store.loadGoogleFontsCatalog();

  const catalog = useFontsStore.getState().googleFontsCatalog;
  const available = new Set<string>();
  const installed: string[] = [];
  const unavailable: string[] = [];

  for (const family of families) {
    if (useFontsStore.getState().getFontByFamily(family)) {
      available.add(family.toLowerCase());
      continue;
    }

    const match = catalog.find(
      (f) => f.family.toLowerCase() === family.toLowerCase()
    );

    if (match) {
      try {
        await useFontsStore.getState().addGoogleFont(match);
        available.add(family.toLowerCase());
        installed.push(family);
        continue;
      } catch {
        /* fall through to unavailable */
      }
    }

    unavailable.push(family);
  }

  return { available, installed, unavailable };
}

/**
 * Returns the parsed payload, the string `'truncated'` when Figma data is
 * present but unparseable (clipboard truncation on large selections), or null
 * when there's no Figma data at all.
 */
function extractFigmaPayload(clipboardData: DataTransfer): YcodeFigmaPayload | 'truncated' | null {
  let sawSignature = false;

  const html = clipboardData.getData('text/html');
  if (html) {
    const match = html.match(/data-ycode-figma="([^"]*)"/);
    if (match?.[1]) {
      sawSignature = true;
      try {
        const decoded = decodeURIComponent(match[1]);
        const parsed = JSON.parse(decoded);
        if (isYcodeFigmaPayload(parsed)) return parsed;
      } catch { /* not valid / truncated */ }
    }
  }

  const text = clipboardData.getData('text/plain');
  if (text?.includes(YCODE_FIGMA_SIGNATURE)) {
    sawSignature = true;
    try {
      const parsed = JSON.parse(text);
      if (isYcodeFigmaPayload(parsed)) return parsed;
    } catch { /* not valid / truncated */ }
  }

  return sawSignature ? 'truncated' : null;
}

export function useFigmaPaste({
  enabled,
  insertFigmaLayers,
  onNormalPaste,
}: UseFigmaPasteOptions) {
  const isProcessingRef = useRef(false);

  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    if (!enabled || isProcessingRef.current) return;

    const target = e.target as HTMLElement;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }

    e.preventDefault();

    if (!e.clipboardData) {
      onNormalPaste();
      return;
    }

    const result = extractFigmaPayload(e.clipboardData);

    if (result === 'truncated') {
      // Signature was present but the JSON didn't parse — the clipboard almost
      // certainly truncated a large selection.
      console.error('[FigmaPaste] Figma payload present but unparseable (likely truncated/too large)');
      toast.error('Figma data was incomplete', {
        description: 'The selection may be too large to copy. Try copying a smaller section or fewer frames.',
      });
      return;
    }

    if (!result) {
      onNormalPaste();
      return;
    }

    const payload = result;

    isProcessingRef.current = true;

    const toastId = toast.loading('Importing from Figma...');

    try {
      const { convertFigmaToLayers, extractFontFamilies } = await import('@/lib/figma/converter');
      const { FigmaMaterializer } = await import('@/lib/figma/materializer');
      const { figmaDebug, figmaDebugStash } = await import('@/lib/figma/debug');

      // Stash the payload so a failed import can be inspected via
      // window.__ycodeFigmaLastPayload in the console.
      figmaDebugStash('LastPayload', payload);
      figmaDebug('payload received', { bytes: JSON.stringify(payload).length });

      // Resolve fonts first so the converter only assigns families it can
      // actually render. Unresolvable fonts are reported back to the user.
      const fontFamilies = extractFontFamilies(payload);
      let fonts: FontResolution = { available: new Set(), installed: [], unavailable: [] };
      if (fontFamilies.length > 0) {
        try {
          fonts = await resolveFonts(fontFamilies);
        } catch (err) {
          console.warn('[FigmaPaste] font resolution error:', err);
        }
      }

      const materializer = new FigmaMaterializer();
      const layers = await convertFigmaToLayers(payload, materializer, fonts.available);

      if (layers.length === 0) {
        toast.error('No valid layers found in Figma data', { id: toastId });
        return;
      }

      insertFigmaLayers(layers);

      const { summary } = materializer;
      const detailParts: string[] = [];
      if (summary.components > 0) detailParts.push(`${summary.components} component${summary.components !== 1 ? 's' : ''}`);
      if (summary.layerStyles > 0) detailParts.push(`${summary.layerStyles} style${summary.layerStyles !== 1 ? 's' : ''}`);
      if (summary.colorVariables > 0) detailParts.push(`${summary.colorVariables} color variable${summary.colorVariables !== 1 ? 's' : ''}`);
      if (fonts.installed.length > 0) detailParts.push(`${fonts.installed.length} font${fonts.installed.length !== 1 ? 's' : ''}`);

      toast.success('Imported from Figma', {
        id: toastId,
        description: detailParts.length > 0 ? `Created ${detailParts.join(' · ')}` : undefined,
      });

      // Tell the user about fonts we couldn't resolve so they know why some
      // text uses the default font and can upload/replace them if needed.
      if (fonts.unavailable.length > 0) {
        const names = fonts.unavailable.join(', ');
        toast.warning(
          `Using default font for ${fonts.unavailable.length} unavailable font${fonts.unavailable.length !== 1 ? 's' : ''}`,
          {
            description: `Not on Google Fonts: ${names}. Upload them under Fonts to match the design.`,
          },
        );
      }
    } catch (error) {
      console.error('Figma import failed:', error);
      toast.error('Failed to import from Figma', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [enabled, insertFigmaLayers, onNormalPaste]);

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('paste', handlePaste, true);
    return () => document.removeEventListener('paste', handlePaste, true);
  }, [enabled, handlePaste]);
}
