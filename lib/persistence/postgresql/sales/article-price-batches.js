'use strict';
const {INSERT_ARTICLE_PRICES}=require('../../statements/sales-article-price-batches');
const CATALOG=Object.freeze([Object.freeze({statement:INSERT_ARTICLE_PRICES,returning:false,parameterOrder:Object.freeze(['rows']),
 sql:`INSERT INTO trade.sales_article_price_snapshots
  (id,product_id,source_snapshot_id,price_type,amount,currency,price_basis,quality_status,source_field,created_by,created_at)
 SELECT v.id,v."productId",v."sourceSnapshotId",v."priceType",v.amount::numeric,v.currency,
  v."priceBasis",v."qualityStatus",v."sourceField",v.actor,v.timestamp
 FROM jsonb_to_recordset($1::jsonb) AS v(id text,"productId" text,"sourceSnapshotId" text,"priceType" text,
  amount text,currency text,"priceBasis" text,"qualityStatus" text,"sourceField" text,actor text,timestamp text)`,
})]);
module.exports={CATALOG};
