"use strict";

const { text } = require("./flexible-search");

// This representation is derived from the current, authoritative article head.
// Keep the folding exactly aligned with flexible-search; never fold each row
// again while executing a user search.
function articleSearchProjection(row) {
  return {
    ...row,
    searchText: [row.articleNumber, row.description, row.primaryIdentifier].map(text).join(" "),
    articleNumberSort: row.articleNumber.toLocaleLowerCase("de-AT"),
    descriptionSort: row.description.toLocaleLowerCase("de-AT"),
  };
}

module.exports = { articleSearchProjection };
