'use strict';
const { BRANCH_ARTICLE_STOCK_CATALOG } = require('../../sqlite/branch-article-stock-catalog');
const { compileSalesEntry } = require('../sales/catalog');
// Additive read catalog; the qualified schema and existing migration history stay unchanged.
const BRANCH_ARTICLE_CATALOG = Object.freeze([...BRANCH_ARTICLE_STOCK_CATALOG, ...require('../../sqlite/branch-receipt-catalog').BRANCH_RECEIPT_CATALOG, ...require('../../sqlite/trade-insights-catalog').TRADE_INSIGHTS_CATALOG].map(entry => compileSalesEntry(entry, 8).providerEntry));
module.exports = { BRANCH_ARTICLE_CATALOG };
