/**
 * Panic-hotkey helpers, shared by the settings screen (recording a shortcut)
 * and the main process (labels). Loaded with require() in Node and as a plain
 * <script> in the control window.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MemeDropHotkey = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_HOTKEY = 'CommandOrControl+Shift+X';

  // KeyboardEvent.code → Electron accelerator key (layout-independent).
  const CODE_TO_KEY = {
    Space: 'Space',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Enter: 'Enter',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backquote: '`',
    Pause: 'Pause',
    ScrollLock: 'Scrolllock',
    PrintScreen: 'PrintScreen',
    NumpadAdd: 'numadd',
    NumpadSubtract: 'numsub',
    NumpadMultiply: 'nummult',
    NumpadDivide: 'numdiv',
    NumpadDecimal: 'numdec',
  };

  const LONE_KEYS_OK = /^(F([1-9]|1[0-9]|2[0-4])|Pause|Scrolllock)$/; // fine without a modifier

  function codeToKey(code) {
    if (!code) return null;
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1];
    m = /^Digit([0-9])$/.exec(code);
    if (m) return m[1];
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return `num${m[1]}`;
    m = /^F([0-9]{1,2})$/.exec(code);
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 24) return `F${m[1]}`;
    return CODE_TO_KEY[code] || null;
  }

  /**
   * Turn a keydown event into an accelerator like "Control+Alt+P".
   * Returns { accelerator } when complete, { pending: true } while only
   * modifiers are held, or { error } for combos that would be a bad idea.
   */
  function eventToAccelerator(e) {
    if (['Control', 'Shift', 'Alt', 'Meta', 'OS'].includes(e.key)) return { pending: true };
    const key = codeToKey(e.code);
    if (!key) return { error: "That key can't be used for a shortcut. Try a letter, number or F-key." };
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const strong = e.ctrlKey || e.altKey || e.metaKey;
    if (!strong && !LONE_KEYS_OK.test(key)) {
      return { error: 'Hold Ctrl or Alt too, so normal typing still works (e.g. Ctrl+Shift+X).' };
    }
    if (e.ctrlKey && e.altKey && key === 'Delete') return { error: 'Ctrl+Alt+Delete belongs to Windows.' };
    return { accelerator: [...mods, key].join('+') };
  }

  /** "CommandOrControl+Shift+X" → "Ctrl+Shift+X" (or "Cmd+Shift+X" on a Mac). */
  function acceleratorLabel(accelerator, platform) {
    const mac = platform === 'darwin';
    return String(accelerator || '')
      .split('+')
      .map((part) => {
        switch (part) {
          case 'CommandOrControl':
          case 'CmdOrCtrl':
            return mac ? 'Cmd' : 'Ctrl';
          case 'Control':
          case 'Ctrl':
            return 'Ctrl';
          case 'Super':
          case 'Meta':
            return mac ? 'Cmd' : 'Win';
          case 'Alt':
          case 'Option':
            return mac ? 'Option' : 'Alt';
          case 'Scrolllock':
            return 'Scroll Lock';
          default:
            return /^num\d$/.test(part) ? `Num ${part.slice(3)}` : part;
        }
      })
      .join('+');
  }

  /** Cheap sanity check for accelerators that came from settings/IPC. */
  function isPlausibleAccelerator(value) {
    if (typeof value !== 'string' || value.length > 60) return false;
    const parts = value.split('+');
    if (parts.length < 1 || parts.length > 5) return false;
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    const okMods = ['CommandOrControl', 'CmdOrCtrl', 'Control', 'Ctrl', 'Alt', 'Shift', 'Super', 'Meta'];
    if (!mods.every((m) => okMods.includes(m))) return false;
    const strong = mods.some((m) => m !== 'Shift');
    if (!strong && !LONE_KEYS_OK.test(key)) return false;
    return /^([A-Z0-9]|F\d{1,2}|num\d|numadd|numsub|nummult|numdiv|numdec|Space|Tab|Backspace|Delete|Insert|Enter|Home|End|PageUp|PageDown|Up|Down|Left|Right|Pause|Scrolllock|PrintScreen|[-=[\]\\;',./`])$/.test(key);
  }

  return { DEFAULT_HOTKEY, eventToAccelerator, acceleratorLabel, isPlausibleAccelerator, codeToKey };
});
