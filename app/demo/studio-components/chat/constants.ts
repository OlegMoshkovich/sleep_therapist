import type { DrawerId } from "../RightDrawer";

/** Simulation conversations are titled "Simulation · …"; this prefix separates
 *  them from hand-typed chats (they show in the Simulation panel, not the sidebar). */
export const SIM_TITLE_PREFIX = "Simulation · ";

export const TTS_PREF_KEY = "sleep-studio-tts-autoplay";
/** v2: black & white is the default; old key auto-wrote "0" for greige. */
export const MONO_PREF_KEY = "sleep-studio-mono-theme-v2";
/** Rounded UI chrome (pills, soft bubbles). Default ON — explicit "0" keeps sharp corners. */
export const ROUND_PREF_KEY = "sleep-studio-round-ui";
/** Mobile bottom-sheet: which tab to reopen the drawer on. Remembered across
 *  opens/reloads; defaults to Model Setup the very first time. */
export const MOBILE_DRAWER_TAB_KEY = "sleep-studio-mobile-drawer-tab";

/** The function panels shown as drawer tabs on desktop. Opening any one of them
 *  opens the whole set (see openDrawer) so all tabs are visible. */
export const PANEL_TABS: DrawerId[] = [
  "modelsetup",
  "observability",
  "simulation" /*, "expert", "upload" */,
];

/** Panels that expose internal wiring (model/prompt setup, step-by-step traces).
 *  Only admins may see or open these; non-admins get the plain chat surface. */
export const ADMIN_ONLY_DRAWERS: DrawerId[] = ["modelsetup", "observability", "simulation"];
