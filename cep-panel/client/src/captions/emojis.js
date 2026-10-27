/**
 * captions/emojis.js — viral keyword-to-emoji matching engine.
 *
 * 100% offline, native Unicode emoji mappings for high-retention video hooks.
 * Supports built-in viral keywords, plural/tense normalization, and custom
 * user-defined keyword mappings stored in localStorage.
 */

export const EMOJI_DICT = {
  // Financial & Wealth
  money: '💰',
  cash: '💵',
  dollar: '💵',
  dollars: '💵',
  buck: '💵',
  bucks: '💵',
  cent: '🪙',
  cents: '🪙',
  coin: '🪙',
  coins: '🪙',
  rich: '🤑',
  wealth: '💰',
  wealthy: '💰',
  millionaire: '🤑',
  billionaire: '🤑',
  profit: '📈',
  profits: '📈',
  revenue: '📈',
  income: '📈',
  invest: '📊',
  investing: '📊',
  investor: '📊',
  stock: '📈',
  stocks: '📈',
  crypto: '🪙',
  bitcoin: '🪙',
  expensive: '🏷️',
  cheap: '🏷️',
  cost: '💸',
  pay: '💳',
  payment: '💳',
  price: '🏷️',
  bank: '🏦',
  fund: '💼',
  funding: '💼',
  gold: '🪙',
  diamond: '💎',
  diamonds: '💎',
  gem: '💎',

  // Growth, Speed & Energy
  growth: '🚀',
  grow: '🌱',
  growing: '🌱',
  scale: '🚀',
  scaling: '🚀',
  rocket: '🚀',
  launch: '🚀',
  speed: '⚡',
  fast: '⚡',
  faster: '⚡',
  quick: '⚡',
  quickly: '⚡',
  boost: '🚀',
  explode: '💥',
  explosion: '💥',
  explosive: '💥',
  power: '⚡',
  powerful: '⚡',
  energy: '⚡',
  fire: '🔥',
  hot: '🔥',
  lit: '🔥',
  burn: '🔥',
  magic: '✨',
  spark: '✨',
  star: '⭐',
  stars: '⭐',

  // Mind, Ideas & Secrets
  brain: '🧠',
  mind: '🧠',
  think: '🤔',
  thinking: '🤔',
  thought: '💡',
  idea: '💡',
  ideas: '💡',
  genius: '🧠',
  smart: '🤓',
  intelligent: '🧠',
  learn: '📚',
  learning: '📚',
  study: '📖',
  secret: '🤫',
  secrets: '🤫',
  whisper: '🤫',
  hack: '⚡',
  hacks: '⚡',
  trick: '🪄',
  strategy: '🎯',
  tactic: '🎯',
  focus: '🎯',
  target: '🎯',
  goal: '🥅',
  plan: '📋',
  rule: '📏',
  rules: '📏',

  // Emotion & Reaction
  crazy: '🤪',
  insane: '🤯',
  shock: '😱',
  shocking: '😱',
  wow: '😲',
  omg: '😱',
  love: '❤️',
  heart: '❤️',
  hate: '😡',
  angry: '🤬',
  happy: '😄',
  sad: '😢',
  cry: '😭',
  laugh: '😂',
  funny: '🤣',
  lol: '😂',
  cool: '😎',
  chill: '🥶',
  cold: '🧊',
  freeze: '❄️',
  sick: '🤢',
  dead: '💀',
  skull: '💀',
  bye: '👋',
  hello: '👋',

  // Caution, Warning & Errors
  stop: '🛑',
  halt: '🛑',
  danger: '⚠️',
  dangerous: '⚠️',
  warning: '⚠️',
  warn: '⚠️',
  alert: '🚨',
  emergency: '🚨',
  mistake: '❌',
  mistakes: '❌',
  wrong: '❌',
  fail: '📉',
  failed: '📉',
  failure: '📉',
  lose: '📉',
  loser: '👎',
  problem: '⚠️',
  bad: '👎',
  risk: '🎲',
  trap: '🪤',

  // Success, Win & Status
  win: '🏆',
  winner: '🏆',
  winning: '🏆',
  victory: '✌️',
  trophy: '🏆',
  champion: '🥇',
  medal: '🥇',
  first: '🥇',
  number1: '🥇',
  crown: '👑',
  king: '👑',
  queen: '👑',
  boss: '💼',
  leader: '👑',
  celebrate: '🎉',
  celebration: '🎉',
  party: '🥳',
  hundred: '💯',
  perfect: '💯',
  yes: '✅',
  correct: '✅',
  check: '✔️',
  done: '✅',

  // Social, Media & Creator
  video: '🎬',
  movie: '🎥',
  film: '🎞️',
  camera: '📸',
  photo: '📷',
  picture: '🖼️',
  audio: '🎧',
  music: '🎵',
  song: '🎶',
  sound: '🔊',
  voice: '🗣️',
  mic: '🎙️',
  podcast: '🎙️',
  phone: '📱',
  mobile: '📱',
  computer: '💻',
  laptop: '💻',
  screen: '🖥️',
  subscribe: '🔔',
  bell: '🔔',
  like: '👍',
  share: '📲',
  follow: '➕',
  follower: '👥',
  followers: '👥',
  chat: '💬',
  message: '✉️',
  email: '📧',
  mail: '📬',

  // Time & Measurement
  time: '⏰',
  clock: '⏰',
  hour: '⏳',
  hours: '⏳',
  minute: '⏱️',
  minutes: '⏱️',
  second: '⏱️',
  seconds: '⏱️',
  calendar: '📅',
  day: '☀️',
  night: '🌙',
  now: '🚨',
  late: '⏰',
  early: '🌅',
  future: '🔮',
  history: '📜',

  // Attention & Senses
  look: '👀',
  see: '👀',
  eye: '👁️',
  eyes: '👀',
  watch: '👀',
  hear: '👂',
  listen: '👂',
  key: '🔑',
  lock: '🔒',
  unlock: '🔓',
  door: '🚪',
  search: '🔍',
  find: '🔎',
  question: '❓',
  help: '🆘',
};

export const CUSTOM_EMOJI_KEY = 'editflow_custom_emojis';

/**
 * Clean a word for matching: lowercases and strips edge punctuation.
 */
export function cleanKeyword(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/^[^a-z0-9#]+/i, '')
    .replace(/[^a-z0-9#]+$/i, '')
    .trim();
}

/**
 * Load user custom keyword overrides from localStorage.
 */
export function loadCustomEmojis() {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(CUSTOM_EMOJI_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch (_) {
    return {};
  }
}

/**
 * Save a custom keyword-to-emoji mapping.
 */
export function saveCustomEmoji(keyword, emoji) {
  const k = cleanKeyword(keyword);
  if (!k || !emoji) return false;
  const customs = loadCustomEmojis();
  customs[k] = String(emoji).trim();
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(CUSTOM_EMOJI_KEY, JSON.stringify(customs)); } catch (_) {}
  }
  return true;
}

/**
 * Remove a custom keyword mapping.
 */
export function deleteCustomEmoji(keyword) {
  const k = cleanKeyword(keyword);
  if (!k) return false;
  const customs = loadCustomEmojis();
  if (customs[k]) {
    delete customs[k];
    if (typeof localStorage !== 'undefined') {
      try { localStorage.setItem(CUSTOM_EMOJI_KEY, JSON.stringify(customs)); } catch (_) {}
    }
    return true;
  }
  return false;
}

/**
 * Find an emoji suggestion for a word token.
 * Checks user custom overrides first, then built-in viral dictionary,
 * with light English stem/suffix fallback.
 */
export function getEmojiSuggestion(text) {
  const raw = cleanKeyword(text);
  if (!raw || raw.length < 2) return null;

  const customs = loadCustomEmojis();
  if (customs[raw]) return customs[raw];
  if (EMOJI_DICT[raw]) return EMOJI_DICT[raw];

  // Plural / possessive normalization: "dollars" -> "dollar", "growth's" -> "growth"
  if (raw.endsWith("'s") && raw.length > 3) {
    const stem = raw.slice(0, -2);
    if (customs[stem]) return customs[stem];
    if (EMOJI_DICT[stem]) return EMOJI_DICT[stem];
  }
  if (raw.endsWith('s') && !raw.endsWith('ss') && raw.length > 3) {
    const singular = raw.slice(0, -1);
    if (customs[singular]) return customs[singular];
    if (EMOJI_DICT[singular]) return EMOJI_DICT[singular];
  }
  // Suffixes: "-ing" -> base (e.g. "growing" -> "grow")
  if (raw.endsWith('ing') && raw.length > 5) {
    const base = raw.slice(0, -3);
    if (customs[base]) return customs[base];
    if (EMOJI_DICT[base]) return EMOJI_DICT[base];
  }
  // Suffixes: "-ed" -> base (e.g. "boosted" -> "boost")
  if (raw.endsWith('ed') && raw.length > 4) {
    const base = raw.slice(0, -2);
    if (customs[base]) return customs[base];
    if (EMOJI_DICT[base]) return EMOJI_DICT[base];
  }

  return null;
}

/**
 * Scan an array of words and return all suggestion opportunities:
 * [{ index, word: w.text, emoji }]
 */
export function findAllSuggestions(words) {
  const out = [];
  (words || []).forEach((w, i) => {
    if (!w || !w.text) return;
    if (w.emoji) return; // already has an emoji attached
    const sugg = getEmojiSuggestion(w.text);
    if (sugg) {
      out.push({ index: i, word: w.text, emoji: sugg });
    }
  });
  return out;
}
