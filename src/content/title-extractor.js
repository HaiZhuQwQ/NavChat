const SPOKEN_PREFIX_LIST = [
  "请帮我",
  "能不能",
  "我想问一下",
  "我想问",
  "麻烦你",
  "请问",
  "可以帮我",
  "可不可以",
  "帮我",
  "能否"
];

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function trimLeadingPunctuation(text) {
  return text.replace(/^[，。！？,.!?：:；;、\-\s]+/g, "").trim();
}

function stripSpokenPrefix(text) {
  let result = text;
  let changed = true;

  while (changed) {
    changed = false;
    for (const prefix of SPOKEN_PREFIX_LIST) {
      if (result.startsWith(prefix)) {
        result = trimLeadingPunctuation(result.slice(prefix.length));
        changed = true;
      }
    }
  }

  return result;
}

function splitSentences(text) {
  return text
    .split(/[。！？!?\n]/g)
    .map((part) => normalizeWhitespace(part))
    .filter(Boolean);
}

function charCount(text) {
  return [...text].length;
}

function truncateTo(text, maxChars) {
  const chars = [...text];
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return chars[0] || "";
  }
  return chars.slice(0, maxChars - 1).join("") + "…";
}

export function extractRoundTitle(userText, roundIndex) {
  const fallback = `第${roundIndex}轮对话`;
  const normalized = normalizeWhitespace(userText);

  if (!normalized) {
    return fallback;
  }

  const withoutPrefix = stripSpokenPrefix(trimLeadingPunctuation(normalized));
  const sentences = splitSentences(withoutPrefix);
  if (sentences.length === 0) {
    return fallback;
  }

  let title = sentences[0];
  let i = 1;

  // 优先保证语义完整；过短时拼接后续短句，尽量接近 18~30 字。
  while (charCount(title) < 18 && i < sentences.length) {
    title = `${title}，${sentences[i]}`;
    i += 1;
  }

  title = normalizeWhitespace(title);
  if (!title) {
    return fallback;
  }

  return truncateTo(title, 30);
}
