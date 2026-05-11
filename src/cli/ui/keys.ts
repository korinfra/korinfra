/**
 * Reserved shortcut contract (G-5).
 * Every screen must validate its action keys against this map.
 * The same key cannot have two different meanings on the same screen.
 */

/**
 * The focus owner determines which layer handles keyboard input at any moment.
 * Parent screens must ignore keys when a child focus owner is active.
 */
export type FocusOwner = 'global' | 'table' | 'result' | 'tools' | 'followup' | 'modal';

/**
 * The current input mode of the app shell, used to gate global shortcuts such
 * as the command palette.  Command screens should call `onInputModeChange`
 * while local text inputs are focused so the shell knows not to intercept keys.
 */
export type InputMode =
  | 'none'
  | 'menu-search'
  | 'ask-ai'
  | 'command-palette'
  | 'field'
  | 'secret'
  | 'modal';

/** A key definition that separates the display label from the physical matchers. */
interface KeyDef {
  /** Human-readable label shown in hints (e.g. `'Shift+/'`). */
  label: string;
  /** All raw `input` strings or key names this binding accepts. */
  aliases: readonly string[];
}

export const RESERVED_KEYS = {
  /** Primary / select / details / apply */
  enter: { label: 'Enter', aliases: ['Enter'] } satisfies KeyDef,
  /** Back / cancel */
  back: { label: 'Esc/b', aliases: ['Escape', 'b'] } satisfies KeyDef,
  /** Quit */
  quit: { label: 'q', aliases: ['q'] } satisfies KeyDef,
  /** Run again / retry only */
  runAgain: { label: 'r', aliases: ['r'] } satisfies KeyDef,
  /** Scan or status only where obvious */
  scan: { label: 's', aliases: ['s'] } satisfies KeyDef,
  /** Report / save report */
  report: { label: 'p', aliases: ['p'] } satisfies KeyDef,
  /** Fix or refresh with AI */
  fix: { label: 'f', aliases: ['f'] } satisfies KeyDef,
  /** Doctor / download / diff / delete (explicit label required) */
  doctor: { label: 'd', aliases: ['d'] } satisfies KeyDef,
  /** Open file / path */
  open: { label: 'o', aliases: ['o'] } satisfies KeyDef,
  /** Copy / config */
  copy: { label: 'c', aliases: ['c'] } satisfies KeyDef,
  /** Generate / suggest tags */
  generate: { label: 'g', aliases: ['g'] } satisfies KeyDef,
  /** Ask AI */
  ask: { label: '/', aliases: ['/'] } satisfies KeyDef,
  /** Command palette */
  palette: { label: ':', aliases: [':'] } satisfies KeyDef,
  /**
   * Help overlay.
   * Physical key: `?` (Shift+/ on most keyboards).
   * Also accepts F1 where supported by the terminal.
   */
  help: { label: '?', aliases: ['?'] } satisfies KeyDef,
  /** Expand (ErrorBox only — do not use as primary action elsewhere) */
  expand: { label: 'e', aliases: ['e'] } satisfies KeyDef,
  /** Mark / space for multi-select */
  mark: { label: 'Space', aliases: [' '] } satisfies KeyDef,
  /** Tab — toggle between panels */
  tab: { label: 'Tab', aliases: ['Tab'] } satisfies KeyDef,
  /** Mark / recommendations */
  markRec: { label: 'm', aliases: ['m'] } satisfies KeyDef,
  /** Apply */
  apply: { label: 'a', aliases: ['a'] } satisfies KeyDef,
  /** List / history list */
  list: { label: 'l', aliases: ['l'] } satisfies KeyDef,
  /** Init / install */
  init: { label: 'i', aliases: ['i'] } satisfies KeyDef,
  /** Refresh with AI / uninstall */
  refresh: { label: 'u', aliases: ['u'] } satisfies KeyDef,
  /** History */
  history: { label: 'h', aliases: ['h'] } satisfies KeyDef,
  /** Sort / order (recommend screen) */
  sortOrder: { label: 'j', aliases: ['j'] } satisfies KeyDef,
  /** Pricing status toggle (doctor screen) */
  pricingStatus: { label: 't', aliases: ['t'] } satisfies KeyDef,
} as const;


/**
 * Flat set of every physical key string that is reserved by the G-5 key
 * contract.  Use this to guard against accidental collisions when registering
 * screen-local shortcuts.
 */
export const RESERVED_KEYS_SET = new Set<string>(
  Object.values(RESERVED_KEYS).flatMap((def) => def.aliases),
);

