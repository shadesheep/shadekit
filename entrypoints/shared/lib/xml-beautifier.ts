/**
 * XML 代码格式化（移植自 vkbeautify.xml）
 */

function createShift(step: number | string): string[] {
  let space: string;

  if (isNaN(parseInt(step as string, 10))) {
    space = step as string;
  } else {
    const n = step as number;
    space = n >= 1 && n <= 12 ? ' '.repeat(n) : '    ';
  }

  const shift: string[] = ['\n'];
  for (let i = 0; i < 100; i++) {
    shift.push(shift[i] + space);
  }
  return shift;
}

/**
 * 格式化 XML 代码
 * @param text - XML 文本
 * @param step - 缩进大小，默认 4 空格
 * @returns 格式化后的 XML
 */
export function beautifyXml(text: string, step: number | string = 4): string {
  const ar = text
    .replace(/>\s{0,}</g, '><')
    .replace(/</g, '~::~<')
    .replace(/\s*xmlns:/g, '~::~xmlns:')
    .replace(/\s*xmlns=/g, '~::~xmlns=')
    .split('~::~');

  const len = ar.length;
  let deep = 0;
  let str = '';
  let inComment = false;
  const shift = createShift(step);

  for (let ix = 0; ix < len; ix++) {
    // start comment or <![CDATA[...]]> or <!DOCTYPE
    if (ar[ix].search(/<!/) > -1) {
      str += shift[deep] + ar[ix];
      inComment = true;
      if (
        ar[ix].search(/-->/) > -1 ||
        ar[ix].search(/\]>/) > -1 ||
        ar[ix].search(/!DOCTYPE/) > -1
      ) {
        inComment = false;
      }
    } else if (ar[ix].search(/-->/) > -1 || ar[ix].search(/\]>/) > -1) {
      // end comment or <![CDATA[...]]>
      str += ar[ix];
      inComment = false;
    } else if (
      ix > 0 &&
      /^<\w/.test(ar[ix - 1]) &&
      /^<\/\w/.test(ar[ix]) &&
      /^<[\w:\-.]+/.exec(ar[ix - 1])?.[0] ===
        /^<\/[\w:\-.]+/.exec(ar[ix])?.[0]?.replace('/', '')
    ) {
      // <elm></elm>
      str += ar[ix];
      if (!inComment && deep > 0) deep--;
    } else if (
      ar[ix].search(/<\w/) > -1 &&
      ar[ix].search(/<\//) === -1 &&
      ar[ix].search(/\/>/) === -1
    ) {
      // <elm>
      str = !inComment ? (str += shift[deep++] + ar[ix]) : (str += ar[ix]);
    } else if (ar[ix].search(/<\w/) > -1 && ar[ix].search(/<\//) > -1) {
      // <elm>...</elm>
      str = !inComment ? (str += shift[deep] + ar[ix]) : (str += ar[ix]);
    } else if (ar[ix].search(/<\//) > -1) {
      // </elm>
      str = !inComment
        ? (str += shift[deep > 0 ? --deep : deep] + ar[ix])
        : (str += ar[ix]);
    } else if (ar[ix].search(/\/>/) > -1) {
      // <elm/>
      str = !inComment ? (str += shift[deep] + ar[ix]) : (str += ar[ix]);
    } else if (ar[ix].search(/<\?/) > -1) {
      // <? xml ... ?>
      str += shift[deep] + ar[ix];
    } else if (ar[ix].search(/xmlns:/) > -1 || ar[ix].search(/xmlns=/) > -1) {
      // xmlns
      str += shift[deep] + ar[ix];
    } else {
      str += ar[ix];
    }
  }

  return str[0] === '\n' ? str.slice(1) : str;
}
