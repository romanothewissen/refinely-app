function tryParseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export type JsonExtractParseMode = 'clean_parse' | 'repaired_parse';

function extractBalancedJsonCandidate(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') {
      continue;
    }

    const stack: string[] = [open];
    let inString = false;
    let escaping = false;

    for (let index = start + 1; index < text.length; index++) {
      const char = text[index];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === '\\') {
          escaping = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }

      if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.at(-1) !== expected) {
          break;
        }
        stack.pop();
        if (!stack.length) {
          return text.slice(start, index + 1);
        }
      }
    }
  }

  return null;
}

function repairTruncatedJsonCandidate(text: string): string | null {
  for (let start = 0; start < text.length; start++) {
    const open = text[start];
    if (open !== '{' && open !== '[') {
      continue;
    }

    const stack: string[] = [open];
    let inString = false;
    let escaping = false;
    let valid = true;

    for (let index = start + 1; index < text.length; index++) {
      const char = text[index];

      if (inString) {
        if (escaping) {
          escaping = false;
          continue;
        }
        if (char === '\\') {
          escaping = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{' || char === '[') {
        stack.push(char);
        continue;
      }

      if (char === '}' || char === ']') {
        const expected = char === '}' ? '{' : '[';
        if (stack.at(-1) !== expected) {
          valid = false;
          break;
        }
        stack.pop();
      }
    }

    if (!valid) {
      continue;
    }

    let candidate = text.slice(start);
    if (inString) {
      const trailingTail = candidate.match(/[\s,}\]]+$/);
      if (trailingTail && /[}\]]/.test(trailingTail[0])) {
        candidate = candidate.slice(0, -trailingTail[0].length);
      }
      if (escaping) {
        candidate += '\\';
      }
      candidate += '"';
    }

    while (stack.length) {
      const expected = stack.pop();
      candidate += expected === '{' ? '}' : ']';
    }

    if (tryParseJson(candidate) !== null) {
      return candidate;
    }
  }

  return null;
}

/**
 * Parse JSON from LLM output, tolerating Markdown fences and leading/trailing prose.
 */
export function extractJson<T = unknown>(text: string): T {
  return extractJsonWithMetadata<T>(text).data;
}

export function extractJsonWithMetadata<T = unknown>(text: string): {
  data: T;
  parseMode: JsonExtractParseMode;
} {
  const normalized = text.trim().replace(/^\uFEFF/, '');

  const direct = tryParseJson<T>(normalized);
  if (direct !== null) {
    return { data: direct, parseMode: 'clean_parse' };
  }

  const strippedFence = normalized
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const strippedFenceParsed = tryParseJson<T>(strippedFence);
  if (strippedFenceParsed !== null) {
    return { data: strippedFenceParsed, parseMode: 'clean_parse' };
  }
  const strippedFenceRepaired = repairTruncatedJsonCandidate(strippedFence);
  if (strippedFenceRepaired) {
    const parsedStrippedFenceRepaired = tryParseJson<T>(strippedFenceRepaired);
    if (parsedStrippedFenceRepaired !== null) {
      return { data: parsedStrippedFenceRepaired, parseMode: 'repaired_parse' };
    }
  }

  const fencedBlockPattern = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const match of normalized.matchAll(fencedBlockPattern)) {
    const block = match[1]?.trim();
    if (!block) {
      continue;
    }
    const parsedBlock = tryParseJson<T>(block);
    if (parsedBlock !== null) {
      return { data: parsedBlock, parseMode: 'clean_parse' };
    }
    const balancedBlock = extractBalancedJsonCandidate(block);
    if (balancedBlock) {
      const parsedBalancedBlock = tryParseJson<T>(balancedBlock);
      if (parsedBalancedBlock !== null) {
        return { data: parsedBalancedBlock, parseMode: 'clean_parse' };
      }
    }
    const repairedBlock = repairTruncatedJsonCandidate(block);
    if (repairedBlock) {
      const parsedRepairedBlock = tryParseJson<T>(repairedBlock);
      if (parsedRepairedBlock !== null) {
        return { data: parsedRepairedBlock, parseMode: 'repaired_parse' };
      }
    }
  }

  const balanced = extractBalancedJsonCandidate(normalized);
  if (balanced) {
    const parsedBalanced = tryParseJson<T>(balanced);
    if (parsedBalanced !== null) {
      return { data: parsedBalanced, parseMode: 'clean_parse' };
    }
  }

  const repaired = repairTruncatedJsonCandidate(normalized);
  if (repaired) {
    const parsedRepaired = tryParseJson<T>(repaired);
    if (parsedRepaired !== null) {
      return { data: parsedRepaired, parseMode: 'repaired_parse' };
    }
  }

  throw new Error(`Could not parse JSON from LLM response. Raw text: ${text.slice(0, 300)}`);
}
