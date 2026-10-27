/**
 * captions/presets.js — one-click caption looks.
 *
 * A preset sets the LOOK (style + motion); it never touches your words,
 * position, or grouping. Tiles in the Style tab are drawn by the real
 * renderer, so a preset looks exactly like its tile.
 */
export const PRESETS = [
  {
    id: 'hormozi', name: 'Hormozi Pop',
    style: { fontFamily: 'Montserrat', fontWeight: 900, textCase: 'upper', color: '#ffffff',
             activeColor: '#39ff14', strokeWidth: 8, strokeColor: '#000000', shadow: true,
             shadowColor: '#000000', shadowOpacity: 0.85, shadowBlur: 6, shadowDistance: 6,
             background: 'none', hlBoxColor: '#ffe600', bgRadius: 0.35, bgPad: 0.28,
             emphasis: 'color', emphasisColor: '#ffe600' },
    motion: { preset: 'pop', duration: 0.22, intensity: 1.2, easing: 'back_out', highlight: 'box', spokenDim: false },
    grouping: { maxWords: 3, maxLines: 1 },
  },
  {
    id: 'mrbeast', name: 'MrBeast Dynamic',
    style: { fontFamily: 'Anton', fontWeight: 400, textCase: 'upper', color: '#ffffff',
             activeColor: '#00f0ff', strokeWidth: 8, strokeColor: '#000000', shadow: true,
             shadowColor: '#000000', shadowOpacity: 0.95, shadowBlur: 0, shadowDistance: 8,
             background: 'none', emphasis: 'color', emphasisColor: '#ffea00' },
    motion: { preset: 'bounce', duration: 0.26, intensity: 1.1, easing: 'back_out', highlight: 'color', spokenDim: false },
    grouping: { maxWords: 2, maxLines: 1 },
  },
  {
    id: 'ali_abdaal', name: 'Ali Abdaal',
    style: { fontFamily: 'Inter', fontWeight: 700, textCase: 'as_is', color: '#ffffff',
             activeColor: '#ffffff', strokeWidth: 0, shadow: true, shadowColor: '#000000',
             shadowOpacity: 0.4, shadowBlur: 14, shadowDistance: 2, background: 'box',
             bgColor: '#111827', bgOpacity: 0.78, bgRadius: 0.55, bgPad: 0.24,
             emphasis: 'color', emphasisColor: '#60a5fa' },
    motion: { preset: 'fade_up', duration: 0.28, distance: 0.2, easing: 'expo_out', highlight: 'none', spokenDim: false },
    grouping: { maxWords: 5, maxLines: 2 },
  },
  {
    id: 'urdu_nastaliq', name: 'Nastaliq Elegant',
    style: { fontFamily: 'Noto Nastaliq Urdu', fontWeight: 700, textCase: 'as_is', color: '#ffffff',
             activeColor: '#f59e0b', strokeWidth: 0, shadow: true, shadowColor: '#000000',
             shadowOpacity: 0.8, shadowBlur: 18, shadowDistance: 6, background: 'none',
             emphasis: 'color', emphasisColor: '#fbbf24' },
    motion: { preset: 'fade_up', duration: 0.32, distance: 0.25, easing: 'expo_out', highlight: 'color', spokenDim: false },
    grouping: { maxWords: 4, maxLines: 1 },
  },
  {
    id: 'neon_cyber', name: 'Cyberpunk Glow',
    style: { fontFamily: 'Montserrat', fontWeight: 900, textCase: 'upper', color: '#ffffff',
             activeColor: '#00f0ff', strokeWidth: 4, strokeColor: '#ff0055', shadow: true,
             shadowColor: '#00f0ff', shadowOpacity: 0.85, shadowBlur: 20, shadowDistance: 0,
             background: 'none', emphasis: 'color', emphasisColor: '#ffe600' },
    motion: { preset: 'pop', duration: 0.22, intensity: 1.1, easing: 'expo_out', highlight: 'color', spokenDim: false },
    grouping: { maxWords: 3, maxLines: 1 },
  },
  {
    id: 'clean', name: 'Clean',
    style: { fontFamily: 'Montserrat', fontWeight: 800, textCase: 'as_is', color: '#ffffff',
             strokeWidth: 0, shadow: true, shadowColor: '#000000', shadowOpacity: 0.6, shadowBlur: 16,
             shadowDistance: 4, background: 'none', emphasis: 'color', emphasisColor: '#ffd84d' },
    motion: { preset: 'fade_up', duration: 0.28, distance: 0.35, easing: 'expo_out', highlight: 'none', spokenDim: false },
  },
  {
    id: 'bold_pop', name: 'Bold Pop',
    style: { fontFamily: 'Montserrat', fontWeight: 900, textCase: 'upper', color: '#ffffff',
             activeColor: '#ffd84d', strokeWidth: 7, strokeColor: '#000000', shadow: true,
             shadowColor: '#000000', shadowOpacity: 0.7, shadowBlur: 10, shadowDistance: 6,
             background: 'none', emphasis: 'color', emphasisColor: '#3ddc84' },
    motion: { preset: 'pop', duration: 0.25, intensity: 1, easing: 'expo_out', highlight: 'color', spokenDim: false },
  },
  {
    id: 'karaoke', name: 'Karaoke',
    style: { fontFamily: 'Poppins', fontWeight: 800, textCase: 'as_is', color: '#ffffff',
             activeColor: '#ffd84d', strokeWidth: 0, shadow: true, shadowColor: '#000000',
             shadowOpacity: 0.65, shadowBlur: 14, shadowDistance: 4, background: 'none', emphasis: 'color',
             emphasisColor: '#ff6b6b' },
    motion: { preset: 'karaoke', duration: 0.2, easing: 'ease_out', highlight: 'color', spokenDim: true },
  },
  {
    id: 'boxed', name: 'Boxed',
    style: { fontFamily: 'Inter', fontWeight: 800, textCase: 'as_is', color: '#ffffff',
             strokeWidth: 0, shadow: false, background: 'box', bgColor: '#000000', bgOpacity: 0.62,
             bgRadius: 0.4, bgPad: 0.24, emphasis: 'color', emphasisColor: '#ffd84d' },
    motion: { preset: 'slide_up', duration: 0.3, distance: 0.25, easing: 'expo_out', highlight: 'none', spokenDim: false },
  },
  {
    id: 'highlight_box', name: 'Highlight',
    style: { fontFamily: 'Montserrat', fontWeight: 800, textCase: 'upper', color: '#ffffff',
             strokeWidth: 0, shadow: true, shadowColor: '#000000', shadowOpacity: 0.55, shadowBlur: 12,
             shadowDistance: 4, background: 'none', hlBoxColor: '#6d4aff', bgRadius: 0.45, bgPad: 0.22,
             emphasis: 'color', emphasisColor: '#ffd84d' },
    motion: { preset: 'fade_up', duration: 0.22, distance: 0.2, easing: 'expo_out', highlight: 'box', spokenDim: false },
  },
  {
    id: 'headline', name: 'Headline',
    style: { fontFamily: 'Anton', fontWeight: 400, textCase: 'upper', color: '#ffffff',
             strokeWidth: 0, shadow: true, shadowColor: '#000000', shadowOpacity: 0.75, shadowBlur: 0,
             shadowDistance: 6, background: 'none', emphasis: 'color', emphasisColor: '#ffd84d',
             activeColor: '#ffd84d' },
    motion: { preset: 'bounce', duration: 0.3, intensity: 0.8, easing: 'expo_out', highlight: 'none', spokenDim: false },
  },
  {
    id: 'minimal', name: 'Minimal',
    style: { fontFamily: 'Inter', fontWeight: 700, textCase: 'as_is', color: '#ffffff',
             strokeWidth: 0, shadow: true, shadowColor: '#000000', shadowOpacity: 0.45, shadowBlur: 18,
             shadowDistance: 2, background: 'none', emphasis: 'color', emphasisColor: '#ffffff' },
    motion: { preset: 'fade', duration: 0.3, easing: 'ease_out', highlight: 'none', spokenDim: false },
  },
  {
    id: 'pill', name: 'Pills',
    style: { fontFamily: 'Poppins', fontWeight: 700, textCase: 'as_is', color: '#ffffff',
             strokeWidth: 0, shadow: false, background: 'pills', bgColor: '#0a1a2e', bgOpacity: 0.85,
             bgRadius: 1, bgPad: 0.22, emphasis: 'color', emphasisColor: '#5c8cf0' },
    motion: { preset: 'pop', duration: 0.25, intensity: 0.6, easing: 'expo_out', highlight: 'none', spokenDim: false },
  },
];

export const USER_PRESETS_KEY = 'editflow_user_presets';

export function loadUserPresets() {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(USER_PRESETS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

export function saveUserPreset(preset) {
  if (!preset || !preset.name) return null;
  const list = loadUserPresets();
  const id = preset.id || ('user_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  const newPreset = {
    id,
    name: String(preset.name).trim(),
    isUser: true,
    style: Object.assign({}, preset.style || {}),
    motion: Object.assign({}, preset.motion || {}),
    grouping: Object.assign({}, preset.grouping || {}),
    layout: Object.assign({}, preset.layout || {}),
  };
  const existingIdx = list.findIndex((p) => p.id === id);
  if (existingIdx !== -1) {
    list[existingIdx] = newPreset;
  } else {
    list.push(newPreset);
  }
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(list)); } catch (_) {}
  }
  return newPreset;
}

export function deleteUserPreset(id) {
  if (!id) return false;
  const list = loadUserPresets();
  const filtered = list.filter((p) => p.id !== id);
  if (filtered.length !== list.length) {
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(USER_PRESETS_KEY, JSON.stringify(filtered)); } catch (_) {}
    }
    return true;
  }
  return false;
}

export function getAllPresets() {
  return [...PRESETS, ...loadUserPresets()];
}

export function findPreset(id) {
  for (const p of getAllPresets()) if (p.id === id) return p;
  return null;
}
