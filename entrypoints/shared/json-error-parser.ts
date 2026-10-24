export interface JsonError {
  line: number;
  column: number;
  message: string;
  context: string;
}

export function parseJsonError(error: unknown, text: string): JsonError | null {
  if (!(error instanceof SyntaxError)) return null;

  let position = -1;
  let line = -1;
  let column = -1;

  const posMatch = error.message.match(/position (\d+)/);
  if (posMatch) position = parseInt(posMatch[1], 10);

  const lineColMatch = error.message.match(/line (\d+) column (\d+)/);
  if (lineColMatch) {
    line = parseInt(lineColMatch[1], 10);
    column = parseInt(lineColMatch[2], 10);
  }

  if (position >= 0 && line < 0) {
    const lines = text.substring(0, position).split('\n');
    line = lines.length;
    column = lines[lines.length - 1].length + 1;
  }

  const start = Math.max(0, (line >= 0 ? getPositionFromLineCol(text, line, column) : position) - 20);
  const end = Math.min(text.length, start + 40);
  const context = text.substring(start, end).replace(/\n/g, '↵');

  return { line: line || 1, column: column || 1, message: error.message, context };
}

/** 将 1 起始的行/列号换算为字符偏移量（json-format 错误下划线定位复用） */
export function getPositionFromLineCol(text: string, line: number, col: number): number {
  const lines = text.split('\n');
  let pos = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    pos += lines[i].length + 1;
  }
  return pos + col - 1;
}
