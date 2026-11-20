'use strict';
const { BRANCH_ARTICLE_STOCK_CATALOG } = require('../../catalogs/branch-article-stock-catalog');
const { compileSalesEntry } = require('../sales/catalog');
const articleReport = require('../../../sales-article-report-statements');
const { reportStockCandidates, publishedReportStock } = require('./article-stock-selection');
// Additive read catalog; the qualified schema and existing migration history stay unchanged.
const BRANCH_ARTICLE_CATALOG = Object.freeze([...BRANCH_ARTICLE_STOCK_CATALOG, ...require('../../catalogs/branch-receipt-catalog').BRANCH_RECEIPT_CATALOG, ...require('../../catalogs/trade-insights-catalog').TRADE_INSIGHTS_CATALOG].map(entry => compileSalesEntry(entry, 8).providerEntry));
const articleReportEntries = articleReport.postgresql().map(entry =>
  entry.statement === articleReport.stockCandidates ? reportStockCandidates : entry);
module.exports = { BRANCH_ARTICLE_CATALOG: Object.freeze([...BRANCH_ARTICLE_CATALOG, ...require('./sales-article-workspace-catalog').CATALOG, ...articleReportEntries, publishedReportStock, ...require('../../../sales-bwl-simulation-statements').postgresqlSales(), ...require('../../../sales-article-sales-catalog').CATALOG.map(entry=>compileSalesEntry(entry,8).providerEntry), ...require('./sales-article-branch-orders-catalog').ARTICLE_BRANCH_ORDERS_CATALOG]) };
