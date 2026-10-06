/**
 * captions/presets.js — one-click caption looks.
 *
 * A preset sets the LOOK (style + motion); it never touches your words,
 * position, or grouping. Tiles in the Style tab are drawn by the real
 * renderer, so a preset looks exactly like its tile.
 */
export const PRESETS = [
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

export function findPreset(id) {
  for (const p of PRESETS) if (p.id === id) return p;
  return null;
}
