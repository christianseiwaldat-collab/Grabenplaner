"use strict";

const { text } = require("./flexible-search");
const { PRICE_SEARCH_FIELDS } = require('./sales-article-table');

// This representation is derived from the current, authoritative article head.
// Keep the folding exactly aligned with flexible-search; never fold each row
// again while executing a user search.
function articleSearchProjection(row) {
  return {
    ...row,
    searchText: [row.articleNumber, row.description, row.primaryIdentifier].map(text).join(" "),
    articleNumberSort: row.articleNumber.toLocaleLowerCase("de-AT"),
    descriptionSort: row.description.toLocaleLowerCase("de-AT"),
    ...Object.fromEntries(PRICE_SEARCH_FIELDS.map(({ id }) => {
      const [whole, fraction = ''] = String(row[id] ?? '').split('.');
      return [id + 'Sort', row[id] == null ? null : whole.padStart(20, '0') + '.' + fraction.padEnd(12, '0')];
    })),
  };
}

module.exports = { articleSearchProjection };
