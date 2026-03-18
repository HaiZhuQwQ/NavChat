function normalizeForSignature(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function tinyHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}

export class RoundIdManager {
  constructor() {
    this.signatureToId = new Map();
    this.userIndexToId = new Map();
    this.counter = 0;
  }

  buildSignature(round, index) {
    const userSig = normalizeForSignature(round.userText);
    const assistantSig = normalizeForSignature(round.assistantMessages?.[0]?.text || "");
    return {
      full: `${userSig}|${assistantSig}|${index}`,
      userIndex: `${userSig}|${index}`
    };
  }

  assign(round, index) {
    const signature = this.buildSignature(round, index);

    if (this.signatureToId.has(signature.full)) {
      return this.signatureToId.get(signature.full);
    }

    if (this.userIndexToId.has(signature.userIndex)) {
      const reused = this.userIndexToId.get(signature.userIndex);
      this.signatureToId.set(signature.full, reused);
      return reused;
    }

    this.counter += 1;
    const id = `ccn-round-${tinyHash(signature.full)}-${this.counter}`;
    this.signatureToId.set(signature.full, id);
    this.userIndexToId.set(signature.userIndex, id);
    return id;
  }
}
