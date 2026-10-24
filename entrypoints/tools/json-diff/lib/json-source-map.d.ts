declare module 'json-source-map' {
  interface PointerLocation {
    line: number;
    column: number;
    pos: number;
  }

  interface Pointers {
    [key: string]: {
      key?: PointerLocation;
      value?: PointerLocation;
      valueEnd?: PointerLocation;
    };
  }

  interface ParseResult {
    data: unknown;
    pointers: Pointers;
  }

  export function parse(source: string, _reviver?: unknown): ParseResult;
  export function stringify(
    source: unknown,
    _replacer?: unknown,
    space?: string | number,
    options?: { es6?: boolean },
  ): string;
}
