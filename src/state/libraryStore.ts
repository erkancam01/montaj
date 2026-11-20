// Parça kütüphanesi durumu (tasarım kütüphanesi): klasörler ve öğeler. Projeden bağımsızdır; kalıcılık ve
// dosya içerikleri services/io/library.ts'te (ayrı IndexedDB deposu). Burada yalnız bellek içi liste tutulur.
import { create } from 'zustand';

export interface LibFolder {
  id: string;
  name: string;
  /** Üst klasör; kökte null */
  parentId: string | null;
}

export interface LibItem {
  id: string;
  /** Dosya adı (uzantıyla) */
  name: string;
  size: number;
  folderId: string | null;
  addedAt: number;
  /** Küçük resim (data URL); üretilemediyse null, henüz üretilmediyse undefined */
  thumb?: string | null;
}

export interface LibraryIndex {
  folders: LibFolder[];
  items: LibItem[];
}

interface LibraryState extends LibraryIndex {
  loaded: boolean;
  /** Küçük resmi üretilmekte olan öğeler */
  busy: Record<string, true>;
  setIndex(ix: LibraryIndex): void;
  setBusy(id: string, on: boolean): void;
}

export const useLibrary = create<LibraryState>((set) => ({
  folders: [],
  items: [],
  loaded: false,
  busy: {},
  setIndex: (ix) => set({ folders: ix.folders, items: ix.items, loaded: true }),
  setBusy: (id, on) =>
    set((s) => {
      const busy = { ...s.busy };
      if (on) busy[id] = true;
      else delete busy[id];
      return { busy };
    }),
}));

/** Klasörün kendisi ve tüm alt klasörlerinin id'leri */
export function folderSubtree(folders: LibFolder[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Kökten klasöre giden yol (kök hariç) */
export function folderPath(folders: LibFolder[], id: string | null): LibFolder[] {
  const path: LibFolder[] = [];
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const f = folders.find((x) => x.id === cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }
  return path;
}
