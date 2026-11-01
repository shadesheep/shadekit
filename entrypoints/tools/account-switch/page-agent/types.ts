export type Target =
  | string
  | { css: string }
  | { ariaLabel: string }
  | { label: string }
  | { name: string }
  | { placeholder: string }
  | { text: string };

export interface FrameScope {
  frameId?: number;
  frameUrl?: string;
}

export type SettleCondition =
  | { type: "formGone" }
  | { type: "urlChanged" }
  | { type: "url"; glob: string }
  | { type: "selector"; target: Target }
  | { type: "cookie"; name: string }
  | { type: "storage"; area: "local" | "session"; key: string }
  | { type: "fixed"; ms: number }
  | { type: "any"; of: SettleCondition[] }
  | { type: "all"; of: SettleCondition[] };

export type AuthRange = "all" | "none" | string[];

export interface TargetCandidate {
  target: Target;
  count: number;
  rank: number;
  note: string;
}

export interface AuthStorageSelection {
  local: string[];
  session: string[];
}
