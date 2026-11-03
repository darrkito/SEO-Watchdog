export function extractTypeDecls(source: string, names: string[]): string {
  const pieces: string[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^export\\s+(interface|type)\\s+${escaped}\\s*(?:\\{|=)`, 'm').exec(source);
    if (!match) continue;
    let start = match.index;
    const before = source.slice(0, start);
    const comment = before.match(/(?:\/\*\*(?:(?!\*\/)[\s\S])*\*\/[ \t]*\n|(?:[ \t]*\/\/[^\n]*\n)+)$/);
    if (comment && comment.index !== undefined) start = comment.index;
    let depth = match[1] === 'interface' ? 1 : 0;
    let end = match.index + match[0].length;
    for (; end < source.length; end++) {
      const char = source[end];
      if (char === '{') depth++;
      if (char === '}') { depth--; if (match[1] === 'interface' && depth === 0) { end++; break; } }
      if (char === ';' && depth === 0 && match[1] === 'type') { end++; break; }
    }
    pieces.push(source.slice(start, end).trim());
  }
  return pieces.join('\n\n');
}
