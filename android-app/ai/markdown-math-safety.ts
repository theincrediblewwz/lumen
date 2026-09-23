export type MarkdownMathRepair = {
  text: string;
  repairCount: number;
};

const MARKDOWN_MATH_SPAN = /\$\$[\s\S]*?\$\$|\$(?!\$)(?:[^$\r\n]|\r(?=(?:ho|ight|angle|ceil|floor|vert|Vert|brace|brack|paren|mathrm|rm)\b)|\n(?=(?:abla|eq|e|eg|ot|u)\b))*?\$/gu;

export function repairMarkdownMathJsonEscapes(value: string): MarkdownMathRepair {
  let repairCount = 0;
  const text = value.replace(MARKDOWN_MATH_SPAN, (span) => {
    let repaired = span;
    [repaired, repairCount] = replaceAndCount(repaired, /\u0008/gu, '\\b', repairCount);
    [repaired, repairCount] = replaceAndCount(repaired, /\u000c/gu, '\\f', repairCount);
    [repaired, repairCount] = replaceAndCount(repaired, /\u0009/gu, '\\t', repairCount);
    [repaired, repairCount] = replaceAndCount(
      repaired,
      /\r(?=(?:ho|ight|angle|ceil|floor|vert|Vert|brace|brack|paren|mathrm|rm)\b)/gu,
      '\\r',
      repairCount,
    );
    [repaired, repairCount] = replaceAndCount(
      repaired,
      /\n(?=(?:abla|eq|e|eg|ot|u)\b)/gu,
      '\\n',
      repairCount,
    );
    return repaired;
  });
  return { text, repairCount };
}

function replaceAndCount(value: string, pattern: RegExp, replacement: string, currentCount: number): [string, number] {
  let count = currentCount;
  return [
    value.replace(pattern, () => {
      count += 1;
      return replacement;
    }),
    count,
  ];
}
