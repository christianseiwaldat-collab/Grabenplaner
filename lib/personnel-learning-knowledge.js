"use strict";
function normalizeKnowledgeArticle(value) {
  if (value === undefined || value === null) return null;
  const text = (input, max, min = 1) => {
    if (typeof input !== "string") throw new Error("Text fehlt");
    const result = input.replace(/\r\n?/g,"\n").trim();
    if (result.length < min || result.length > max || result.includes("\0")) throw new Error("Textlänge ungültig");
    return result;
  };
  try {
    if (typeof value !== "object" || Array.isArray(value)) throw new Error("Artikel ungültig");
    return Object.freeze({ category:text(value.category,80), body:text(value.body,20000,10) });
  } catch {
    throw Object.assign(new Error("Bitte Kategorie (bis 80 Zeichen) und Wissenstext (10 bis 20.000 Zeichen) ausfüllen."), {code:"PERSONNEL_LEARNING_KNOWLEDGE_INVALID",status:400});
  }
}
function isKnowledgeArticle(content) { return content?.catalogEntity === "article"; }
module.exports = {normalizeKnowledgeArticle,isKnowledgeArticle};
